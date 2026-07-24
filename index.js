import { extension_settings } from '../../../extensions.js';
import { eventSource, event_types, saveSettingsDebounced } from '../../../../script.js';
import { debounce, download, getSortableDelay, parseJsonFile, uuidv4 } from '../../../utils.js';
import { debounce_timeout } from '../../../constants.js';
import { callGenericPopup, Popup, POPUP_RESULT, POPUP_TYPE } from '../../../popup.js';
import { t } from '../../../i18n.js';

// Must match the folder name exactly.
const extensionName = 'quick-prompt';
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

/** Marks the picker/settings UI so it is easy to tell our own elements apart. */
const OWN_UI_CLASS = 'qp-root';
/** Class on every inline insert button we inject. */
const INSERT_BTN_CLASS = 'qp-insert-btn';
/** Show the picker's search box only once the library is big enough to need it. */
const SEARCH_THRESHOLD = 8;
/** How long to keep re-asserting the caret after an insert, in ms. */
const CARET_RESTORE_WINDOW_MS = 300;

const defaultSettings = {
    categories: [],
    buttonsEnabled: true,
    lastCategoryId: null,
};

function settings() {
    return extension_settings[extensionName];
}

function save() {
    saveSettingsDebounced();
}

// ---------------------------------------------------------------- data model

function findCategory(id) {
    return settings().categories.find(c => c.id === id) ?? null;
}

function addCategory(name) {
    const category = { id: uuidv4(), name: name || t`New category`, prompts: [] };
    settings().categories.push(category);
    save();
    return category;
}

function addPrompt(categoryId) {
    const category = findCategory(categoryId);
    if (!category) return null;
    const prompt = { id: uuidv4(), title: t`New prompt`, content: '' };
    category.prompts.push(prompt);
    save();
    return prompt;
}

function totalPromptCount() {
    return settings().categories.reduce((sum, c) => sum + c.prompts.length, 0);
}

function isUsable(el) {
    return el
        && document.body.contains(el)
        && !el.disabled
        && !el.readOnly
        && el.getClientRects().length > 0;
}

// ---------------------------------------------------------------- insertion

/**
 * Inserts text at the caret of the resolved target field.
 *
 * `execCommand('insertText')` is preferred because it keeps the browser's native undo
 * stack intact and fires a trusted `input` event by itself. SillyTavern relies on `input`
 * everywhere: character fields (script.js), world info entry content (world-info.js) and
 * the chat input auto-resize (RossAscends-mods.js).
 * The target field is captured when the picker opens and passed in explicitly. It is
 * never re-resolved here: re-resolving at insert time could fall back to #send_textarea
 * if the original field became momentarily unusable, silently sending the prompt to the
 * chat box instead of the character/lorebook field the user was editing.
 * @param {string} text
 * @param {HTMLTextAreaElement|HTMLInputElement} field
 * @returns {{field: HTMLTextAreaElement|HTMLInputElement, caret: number}|null}
 *          The field written to and where the caret should end up, or null if nothing happened.
 */
function insertPrompt(text, field) {
    if (!isUsable(field)) {
        toastr.info(t`Tap the text field you want to insert into first.`, 'Quick Prompt');
        return null;
    }

    field.focus();

    const start = field.selectionStart ?? field.value.length;
    const end = field.selectionEnd ?? start;
    const caret = start + text.length;

    if (document.activeElement === field && document.execCommand('insertText', false, text)) {
        return { field, caret };
    }

    field.value = field.value.slice(0, start) + text + field.value.slice(end);
    field.selectionStart = field.selectionEnd = caret;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    return { field, caret };
}

/**
 * Puts the caret back where the insert left it.
 *
 * Closing a Popup restores focus to whatever the dialog had focused
 * (public/scripts/popup.js), and that re-focus collapses the target's selection back to 0.
 * That restore lands *after* the close animation, i.e. after `popup.show()` has already
 * resolved - so a single pass is not enough. Re-apply across a short window instead, and
 * bail the moment the user starts typing so this can never fight real input.
 * @param {{field: HTMLTextAreaElement|HTMLInputElement, caret: number}} result
 */
function restoreCaret(result) {
    if (!result || !isUsable(result.field)) return;

    const { field, caret } = result;
    const snapshot = field.value;

    const apply = () => {
        if (field.value !== snapshot) return;
        field.focus();
        field.setSelectionRange(caret, caret);
    };

    apply();
    field.addEventListener('focus', apply);
    setTimeout(() => {
        apply();
        field.removeEventListener('focus', apply);
    }, CARET_RESTORE_WINDOW_MS);
}

// ---------------------------------------------------------------- inline buttons

/**
 * The three fields the user wants to insert into. Each button is injected next to the
 * field, so it lives inside that field's own container. That is what makes this robust:
 * a click inside an open drawer does not trigger SillyTavern's auto-close (which fires
 * only for clicks whose ancestors include no open drawer - public/script.js ~12119), so
 * the drawer stays open and the field stays visible.
 *
 * @param {string} dataFor The id an `.editor_maximize` button points at.
 * @returns {boolean} Whether that field is one we insert into.
 */
function isTargetEditor(dataFor) {
    return dataFor === 'description_textarea'         // character description
        || dataFor.startsWith('world_entry_content_'); // a lorebook entry's content
}

/**
 * Builds one insert button. It resolves its target lazily through `getField` so a button
 * injected next to a field that is later re-rendered still points at the live element.
 * @param {() => HTMLTextAreaElement|HTMLInputElement|null} getField
 * @param {string} extraClasses
 */
function buildInsertButton(getField, extraClasses) {
    const btn = document.createElement('div');
    btn.className = `${INSERT_BTN_CLASS} ${extraClasses}`;
    btn.setAttribute('role', 'button');
    btn.setAttribute('tabindex', '0');
    btn.title = t`Insert a saved prompt`;

    const activate = () => {
        const field = getField();
        if (!isUsable(field)) {
            toastr.info(t`This field is not available right now.`, 'Quick Prompt');
            return;
        }
        void openPicker(field);
    };

    // preventDefault keeps the field's caret; stopPropagation is defensive so the click
    // never bubbles to SillyTavern's drawer auto-close handler.
    btn.addEventListener('pointerdown', evt => evt.preventDefault());
    btn.addEventListener('click', evt => { evt.stopPropagation(); activate(); });
    btn.addEventListener('keydown', evt => {
        if (evt.key === 'Enter' || evt.key === ' ') {
            evt.preventDefault();
            evt.stopPropagation();
            activate();
        }
    });

    return btn;
}

/**
 * Injects a button next to every target field's maximize button. Idempotent - a maximize
 * button that already has ours beside it is skipped - so it is safe to call on every DOM
 * mutation, which is how lorebook entries (created on demand) get their button.
 */
function injectEditorButtons() {
    if (!settings().buttonsEnabled) return;

    for (const maximize of document.querySelectorAll('.editor_maximize')) {
        const dataFor = maximize.getAttribute('data-for');
        if (!dataFor || !isTargetEditor(dataFor)) continue;
        if (maximize.nextElementSibling?.classList.contains(INSERT_BTN_CLASS)) continue;

        // NOTE: must not carry the `editor_maximize` class - SillyTavern has a delegated
        // click handler on `.editor_maximize` (public/scripts/chats.js) that would fire too.
        // `right_menu_button` alone gives the matching size/hover treatment.
        const btn = buildInsertButton(
            () => /** @type {HTMLTextAreaElement} */ (document.getElementById(dataFor)),
            'fa-solid fa-lightbulb right_menu_button',
        );
        maximize.insertAdjacentElement('afterend', btn);
    }
}

const injectEditorButtonsDebounced = debounce(injectEditorButtons, debounce_timeout.quick);

/** Adds the chat-input button to the send form once. */
function injectChatButton() {
    if (!settings().buttonsEnabled) return;
    if (document.getElementById('quick_prompt_send_button')) return;

    const left = document.getElementById('leftSendForm');
    if (!left) return;

    const btn = buildInsertButton(
        () => /** @type {HTMLTextAreaElement} */ (document.getElementById('send_textarea')),
        'fa-solid fa-lightbulb interactable qp-send-btn',
    );
    btn.id = 'quick_prompt_send_button';
    left.append(btn);
}

/** Removes every injected button (used when the feature is toggled off). */
function removeInjectedButtons() {
    document.querySelectorAll(`.${INSERT_BTN_CLASS}`).forEach(el => el.remove());
}

function refreshButtons() {
    if (settings().buttonsEnabled) {
        injectChatButton();
        injectEditorButtons();
    } else {
        removeInjectedButtons();
    }
}

// ---------------------------------------------------------------- picker

function buildPickerContent(popupRef, resultRef, target) {
    const wrapper = document.createElement('div');
    wrapper.className = `${OWN_UI_CLASS} qp-picker`;

    const categories = settings().categories;

    if (categories.length === 0) {
        wrapper.innerHTML = `<p class="qp-empty">${t`No prompts yet. Add some in Extensions → Quick Prompt Library.`}</p>`;
        return wrapper;
    }

    const search = document.createElement('input');
    search.type = 'text';
    search.className = 'text_pole qp-search';
    search.placeholder = t`Search prompts`;
    search.autocomplete = 'off';
    if (totalPromptCount() > SEARCH_THRESHOLD) {
        wrapper.append(search);
    }

    const list = document.createElement('div');
    list.className = 'qp-picker-list';
    wrapper.append(list);

    for (const category of categories) {
        const details = document.createElement('details');
        details.className = 'qp-picker-category';
        details.dataset.id = category.id;
        details.open = category.id === settings().lastCategoryId;

        const summary = document.createElement('summary');
        summary.textContent = `${category.name} (${category.prompts.length})`;
        details.append(summary);

        for (const prompt of category.prompts) {
            const item = document.createElement('div');
            item.className = 'qp-picker-item interactable';
            item.setAttribute('tabindex', '0');
            item.dataset.search = `${category.name} ${prompt.title} ${prompt.content}`.toLowerCase();

            const title = document.createElement('div');
            title.className = 'qp-picker-item-title';
            title.textContent = prompt.title;

            const excerpt = document.createElement('div');
            excerpt.className = 'qp-picker-item-excerpt';
            excerpt.textContent = prompt.content;

            item.append(title, excerpt);

            const choose = () => {
                settings().lastCategoryId = category.id;
                save();
                const result = insertPrompt(prompt.content, target);
                if (result) {
                    resultRef.value = result;
                    popupRef.value?.complete(POPUP_RESULT.AFFIRMATIVE);
                }
            };

            item.addEventListener('click', choose);
            item.addEventListener('keydown', evt => {
                if (evt.key === 'Enter' || evt.key === ' ') {
                    evt.preventDefault();
                    choose();
                }
            });

            details.append(item);
        }

        list.append(details);
    }

    search.addEventListener('input', () => {
        const query = search.value.trim().toLowerCase();
        for (const details of list.querySelectorAll('.qp-picker-category')) {
            let anyVisible = false;
            for (const item of details.querySelectorAll('.qp-picker-item')) {
                const match = !query || item.dataset.search.includes(query);
                item.classList.toggle('qp-hidden', !match);
                anyVisible ||= match;
            }
            details.classList.toggle('qp-hidden', !anyVisible);
            if (query) details.open = anyVisible;
        }
    });

    return wrapper;
}

/**
 * Opens the picker for a specific field. The target is fixed at call time and threaded
 * through to the insert, so nothing that happens while the picker is open can redirect
 * the prompt to a different field.
 * @param {HTMLTextAreaElement|HTMLInputElement} target
 */
async function openPicker(target) {
    if (!isUsable(target)) {
        toastr.info(t`This field is not available right now.`, 'Quick Prompt');
        return;
    }

    // The content needs a reference to the popup that will own it, and a slot to hand the
    // insert result back out - both are passed by box.
    const popupRef = { value: null };
    const resultRef = { value: null };
    const content = buildPickerContent(popupRef, resultRef, target);

    const popup = new Popup(content, POPUP_TYPE.DISPLAY, '', {
        wide: true,
        allowVerticalScrolling: true,
    });
    popupRef.value = popup;

    await popup.show();
    restoreCaret(resultRef.value);
}

function addWandButton() {
    const container = document.getElementById('extensionsMenu');
    if (!(container instanceof HTMLElement)) return;

    const button = document.createElement('div');
    button.id = 'quick_prompt_wand_button';
    button.classList.add('list-group-item', 'flex-container', 'flexGap5', 'interactable');
    button.title = t`Insert a saved prompt`;
    button.innerHTML = `
        <div class="fa-fw fa-solid fa-bolt extensionsMenuExtensionButton"></div>
        <span>${t`Quick Prompt`}</span>`;
    // The wand menu lives next to the chat input, so it targets the chat input.
    button.addEventListener('click', () => void openPicker(
        /** @type {HTMLTextAreaElement} */ (document.getElementById('send_textarea')),
    ));

    container.append(button);
}

// ---------------------------------------------------------------- settings UI

function renderPrompt(prompt) {
    const el = document.createElement('div');
    el.className = 'qp-prompt';
    el.dataset.id = prompt.id;
    el.innerHTML = `
        <div class="qp-handle drag-handle fa-solid fa-grip-vertical"></div>
        <div class="qp-prompt-fields">
            <input class="text_pole qp-prompt-title" type="text" autocomplete="off" />
            <textarea class="text_pole qp-prompt-content" rows="2" autocomplete="off"></textarea>
        </div>
        <div class="qp-icon-btn interactable fa-solid fa-trash-can" tabindex="0" data-action="delete-prompt"></div>`;

    const title = el.querySelector('.qp-prompt-title');
    const content = el.querySelector('.qp-prompt-content');
    title.value = prompt.title;
    title.placeholder = t`Title`;
    content.value = prompt.content;
    content.placeholder = t`Prompt text`;

    return el;
}

function renderCategory(category) {
    const el = document.createElement('div');
    el.className = 'qp-category';
    el.dataset.id = category.id;
    el.innerHTML = `
        <div class="qp-category-head">
            <div class="qp-handle drag-handle fa-solid fa-grip-vertical"></div>
            <input class="text_pole qp-category-name" type="text" autocomplete="off" />
            <div class="qp-icon-btn interactable fa-solid fa-plus" tabindex="0" data-action="add-prompt"></div>
            <div class="qp-icon-btn interactable fa-solid fa-trash-can" tabindex="0" data-action="delete-category"></div>
        </div>
        <div class="qp-prompt-list"></div>`;

    const name = el.querySelector('.qp-category-name');
    name.value = category.name;
    name.placeholder = t`Category name`;

    el.querySelector('[data-action="add-prompt"]').title = t`Add a prompt`;
    el.querySelector('[data-action="delete-category"]').title = t`Delete this category`;

    const list = el.querySelector('.qp-prompt-list');
    for (const prompt of category.prompts) {
        list.append(renderPrompt(prompt));
    }

    // @ts-ignore - jQuery UI, same pattern as quick-reply/src/ui/SettingsUi.js
    $(list).sortable({
        delay: getSortableDelay(),
        handle: '.qp-handle',
        items: '> .qp-prompt',
        stop: () => reorderPrompts(category.id, list),
    });

    return el;
}

function renderCategories() {
    const container = document.getElementById('quick_prompt_categories');
    if (!container) return;

    container.innerHTML = '';
    for (const category of settings().categories) {
        container.append(renderCategory(category));
    }

    // @ts-ignore
    $(container).sortable({
        delay: getSortableDelay(),
        handle: '> .qp-category > .qp-category-head > .qp-handle',
        items: '> .qp-category',
        stop: () => reorderCategories(container),
    });
}

function reorderCategories(container) {
    const order = [...container.querySelectorAll(':scope > .qp-category')].map(el => el.dataset.id);
    settings().categories.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    save();
}

function reorderPrompts(categoryId, list) {
    const category = findCategory(categoryId);
    if (!category) return;
    const order = [...list.querySelectorAll(':scope > .qp-prompt')].map(el => el.dataset.id);
    category.prompts.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    save();
}

async function onCategoriesClick(event) {
    const button = event.target instanceof HTMLElement ? event.target.closest('[data-action]') : null;
    if (!button) return;

    const categoryEl = button.closest('.qp-category');
    const category = findCategory(categoryEl?.dataset.id);
    if (!category) return;

    switch (button.dataset.action) {
        case 'add-prompt': {
            addPrompt(category.id);
            renderCategories();
            break;
        }
        case 'delete-category': {
            const confirmed = await callGenericPopup(
                t`Delete the category "${category.name}" and all of its prompts?`,
                POPUP_TYPE.CONFIRM,
            );
            if (!confirmed) return;
            settings().categories = settings().categories.filter(c => c.id !== category.id);
            save();
            renderCategories();
            break;
        }
        case 'delete-prompt': {
            const promptEl = button.closest('.qp-prompt');
            const prompt = category.prompts.find(p => p.id === promptEl?.dataset.id);
            if (!prompt) return;
            const confirmed = await callGenericPopup(
                t`Delete the prompt "${prompt.title}"?`,
                POPUP_TYPE.CONFIRM,
            );
            if (!confirmed) return;
            category.prompts = category.prompts.filter(p => p.id !== prompt.id);
            save();
            renderCategories();
            break;
        }
    }
}

function onCategoriesInput(event) {
    const el = event.target;
    if (!(el instanceof HTMLElement)) return;

    const category = findCategory(el.closest('.qp-category')?.dataset.id);
    if (!category) return;

    if (el.classList.contains('qp-category-name')) {
        category.name = el.value;
        save();
        return;
    }

    const prompt = category.prompts.find(p => p.id === el.closest('.qp-prompt')?.dataset.id);
    if (!prompt) return;

    if (el.classList.contains('qp-prompt-title')) {
        prompt.title = el.value;
        save();
    } else if (el.classList.contains('qp-prompt-content')) {
        prompt.content = el.value;
        save();
    }
}

function onExport() {
    const payload = { version: 1, categories: settings().categories };
    download(JSON.stringify(payload, null, 4), 'quick-prompt-library.json', 'application/json');
}

async function onImportFile(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    try {
        const data = await parseJsonFile(file);
        const incoming = Array.isArray(data) ? data : data?.categories;

        if (!Array.isArray(incoming)) {
            toastr.error(t`That file does not look like a Quick Prompt export.`, 'Quick Prompt');
            return;
        }

        // Re-issue every id so an import can never collide with what is already stored.
        const sanitized = incoming
            .filter(c => c && typeof c.name === 'string')
            .map(c => ({
                id: uuidv4(),
                name: String(c.name),
                prompts: (Array.isArray(c.prompts) ? c.prompts : [])
                    .filter(p => p && typeof p.title === 'string')
                    .map(p => ({ id: uuidv4(), title: String(p.title), content: String(p.content ?? '') })),
            }));

        if (sanitized.length === 0) {
            toastr.warning(t`Nothing to import from that file.`, 'Quick Prompt');
            return;
        }

        settings().categories.push(...sanitized);
        save();
        renderCategories();
        toastr.success(t`Imported ${sanitized.length} categories.`, 'Quick Prompt');
    } catch (error) {
        console.error(`[${extensionName}] Import failed:`, error);
        toastr.error(t`Could not read that file.`, 'Quick Prompt');
    }
}

function loadSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    const stored = extension_settings[extensionName];

    for (const [key, value] of Object.entries(defaultSettings)) {
        if (!Object.hasOwn(stored, key)) {
            stored[key] = structuredClone(value);
        }
    }

    if (!Array.isArray(stored.categories)) {
        stored.categories = [];
    }

    $('#quick_prompt_buttons').prop('checked', stored.buttonsEnabled);
}

function bindSettings() {
    $('#quick_prompt_buttons').on('input', function () {
        settings().buttonsEnabled = Boolean($(this).prop('checked'));
        save();
        refreshButtons();
    });

    $('#quick_prompt_add_category').on('click', () => {
        addCategory('');
        renderCategories();
    });

    $('#quick_prompt_export').on('click', onExport);
    $('#quick_prompt_import').on('click', () => $('#quick_prompt_import_file').trigger('click'));
    $('#quick_prompt_import_file').on('change', onImportFile);

    const categories = document.getElementById('quick_prompt_categories');
    categories.addEventListener('click', evt => void onCategoriesClick(evt));
    categories.addEventListener('input', onCategoriesInput);
}

// ---------------------------------------------------------------- init

jQuery(async () => {
    console.log(`[${extensionName}] Loading...`);

    try {
        const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
        $('#extensions_settings2').append(settingsHtml);

        loadSettings();
        bindSettings();
        renderCategories();

        injectChatButton();
        injectEditorButtons();

        // Lorebook entries and the character panel are (re)rendered on demand, so their
        // maximize buttons appear after load. Watch the DOM and inject beside any new ones.
        new MutationObserver(injectEditorButtonsDebounced)
            .observe(document.body, { childList: true, subtree: true });

        // The chat input row is rebuilt when the send form re-renders (e.g. Quick Replies).
        eventSource.on(event_types.CHAT_CHANGED, injectChatButton);

        addWandButton();

        console.log(`[${extensionName}] Loaded successfully`);
    } catch (error) {
        console.error(`[${extensionName}] Failed to load:`, error);
    }
});
