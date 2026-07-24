import { extension_settings } from '../../../extensions.js';
import { eventSource, event_types, saveSettingsDebounced } from '../../../../script.js';
import { debounce, download, getSortableDelay, parseJsonFile, uuidv4 } from '../../../utils.js';
import { debounce_timeout } from '../../../constants.js';
import { callGenericPopup, Popup, POPUP_RESULT, POPUP_TYPE } from '../../../popup.js';
import { t } from '../../../i18n.js';

// Must match the folder name exactly.
const extensionName = 'quick-prompt';
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

/** Any field inside an element carrying this class belongs to us and is never an insert target. */
const OWN_UI_CLASS = 'qp-root';
/** Show the picker's search box only once the library is big enough to need it. */
const SEARCH_THRESHOLD = 8;
/** How long to keep re-asserting the caret after an insert, in ms. */
const CARET_RESTORE_WINDOW_MS = 300;

const defaultSettings = {
    categories: [],
    fabEnabled: true,
    fabPosition: 'right',
    lastCategoryId: null,
};

/** Last text field the user focused that is not part of this extension's own UI. */
/** @type {HTMLTextAreaElement|HTMLInputElement} */ let lastField = null;
/** @type {HTMLElement} */ let fab = null;

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

// ---------------------------------------------------------------- focus tracking

function isTrackableField(el) {
    if (el instanceof HTMLTextAreaElement) return true;
    return el instanceof HTMLInputElement && el.type === 'text';
}

function isUsable(el) {
    return el
        && document.body.contains(el)
        && !el.disabled
        && !el.readOnly
        && el.getClientRects().length > 0;
}

/**
 * Resolves where an inserted prompt should go.
 * Falls back to the chat input so the very first insert of a session still works.
 * @returns {HTMLTextAreaElement|HTMLInputElement|null}
 */
function resolveTarget() {
    if (isUsable(lastField)) {
        return lastField;
    }
    const sendTextarea = document.getElementById('send_textarea');
    return sendTextarea instanceof HTMLTextAreaElement && isUsable(sendTextarea) ? sendTextarea : null;
}

/**
 * Whether an element may be adopted as the insert target.
 * Fields inside our own popup/settings UI must never qualify, otherwise the picker's
 * search box would overwrite the real target. SillyTavern's own dialogs are NOT excluded -
 * `.maximized_textarea` lives in one and is a legitimate target
 * (see public/scripts/chats.js editor_maximize).
 */
function isEligibleTarget(el) {
    return isTrackableField(el) && !el.closest(`.${OWN_UI_CLASS}`);
}

function trackFocus(event) {
    if (!isEligibleTarget(event.target)) return;
    lastField = event.target;
    updateFab();
}

/**
 * Adopts whatever is focused right now.
 *
 * Needed because focusing an already-focused element fires no `focusin`: SillyTavern
 * focuses #send_textarea itself on some chat loads, which happens before (or without)
 * any event this extension could observe.
 */
function adoptActiveElement() {
    if (isUsable(lastField)) return;
    if (isEligibleTarget(document.activeElement)) {
        lastField = /** @type {HTMLTextAreaElement|HTMLInputElement} */ (document.activeElement);
    }
}

// ---------------------------------------------------------------- insertion

/**
 * Inserts text at the caret of the resolved target field.
 *
 * `execCommand('insertText')` is preferred because it keeps the browser's native undo
 * stack intact and fires a trusted `input` event by itself. SillyTavern relies on `input`
 * everywhere: character fields (script.js), world info entry content (world-info.js) and
 * the chat input auto-resize (RossAscends-mods.js).
 * @param {string} text
 * @returns {{field: HTMLTextAreaElement|HTMLInputElement, caret: number}|null}
 *          The field written to and where the caret should end up, or null if nothing happened.
 */
function insertPrompt(text) {
    const field = resolveTarget();

    if (!field) {
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

// ---------------------------------------------------------------- floating button

function buildFab() {
    const el = document.createElement('div');
    el.id = 'quickPromptFab';
    el.className = `qp-fab ${OWN_UI_CLASS} interactable`;
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
    el.innerHTML = '<div class="fa-solid fa-plus"></div>';
    el.title = t`Insert a saved prompt`;

    // Keep the target field focused: without this the browser blurs it on press,
    // and on touch devices the caret position would be lost.
    el.addEventListener('pointerdown', evt => evt.preventDefault());
    el.addEventListener('click', () => void openPicker());
    el.addEventListener('keydown', evt => {
        if (evt.key === 'Enter' || evt.key === ' ') {
            evt.preventDefault();
            void openPicker();
        }
    });

    return el;
}

/**
 * Shows/hides the button and, when the target sits inside a modal dialog, moves the
 * button into that dialog - `showModal()` makes everything outside the dialog inert,
 * so a button parented to <body> could not be clicked.
 */
function updateFab() {
    if (!fab) return;

    adoptActiveElement();
    const visible = settings().fabEnabled && isUsable(lastField);
    fab.classList.toggle('qp-fab-visible', visible);
    fab.classList.toggle('qp-fab-left', settings().fabPosition === 'left');

    if (!visible) {
        if (fab.parentElement !== document.body) {
            document.body.append(fab);
        }
        return;
    }

    const host = lastField.closest('dialog[open]') ?? document.body;
    if (fab.parentElement !== host) {
        host.append(fab);
    }
}

const updateFabDebounced = debounce(updateFab, debounce_timeout.short);

// ---------------------------------------------------------------- picker

function buildPickerContent(popupRef, resultRef) {
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
                const result = insertPrompt(prompt.content);
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

async function openPicker() {
    if (!resolveTarget()) {
        toastr.info(t`Tap the text field you want to insert into first.`, 'Quick Prompt');
        return;
    }

    // The content needs a reference to the popup that will own it, and a slot to hand the
    // insert result back out - both are passed by box.
    const popupRef = { value: null };
    const resultRef = { value: null };
    const content = buildPickerContent(popupRef, resultRef);

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
    button.addEventListener('click', () => void openPicker());

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

    $('#quick_prompt_fab').prop('checked', stored.fabEnabled);
    $('#quick_prompt_fab_position').val(stored.fabPosition);
}

function bindSettings() {
    $('#quick_prompt_fab').on('input', function () {
        settings().fabEnabled = Boolean($(this).prop('checked'));
        save();
        updateFab();
    });

    $('#quick_prompt_fab_position').on('change', function () {
        settings().fabPosition = String($(this).val());
        save();
        updateFab();
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

        fab = buildFab();
        document.body.append(fab);

        document.addEventListener('focusin', trackFocus);
        // A drawer closing or a world info entry being re-rendered can remove the target
        // field without any focus event firing.
        document.addEventListener('focusout', updateFabDebounced);
        window.addEventListener('resize', updateFabDebounced);
        // Opening a chat can focus #send_textarea without a focusin this extension sees.
        eventSource.on(event_types.CHAT_CHANGED, updateFabDebounced);

        addWandButton();
        updateFab();

        console.log(`[${extensionName}] Loaded successfully`);
    } catch (error) {
        console.error(`[${extensionName}] Failed to load:`, error);
    }
});
