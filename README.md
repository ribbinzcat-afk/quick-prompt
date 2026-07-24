# Quick Prompt Library

Save reusable prompts in categories and insert them at the caret of whichever text field
you last touched — the chat box, a character field, or a lorebook entry.

Tested against SillyTavern **1.18.0**.

## What it does

- Categories of prompts, edited in Extensions → **Quick Prompt Library**.
- Drag to reorder categories and prompts.
- A floating **+** button that appears whenever a text field is in play.
- The same picker is available from the wand menu next to the chat input.
- Two-level picker: pick a category, then a prompt. The last category you used reopens first.
- A search box appears once the library grows past 8 prompts.
- Export / import the whole library as JSON.

## Why a floating button

On narrow screens the World Info and Character drawers cover `#send_form` entirely
(`.drawer-content { position: fixed; width: 100dvw }`), so a button parked next to the
send button is unreachable exactly when you are editing a lorebook entry. The floating
button sits at `z-index: 4500`, above the drawer stack.

When the target field lives inside a modal `<dialog>` — SillyTavern's "maximize editor"
popup, for instance — the button is reparented into that dialog, because `showModal()`
makes everything outside the dialog inert.

## How insertion works

The extension remembers the last text field you focused (`focusin`), ignoring anything
inside its own UI so the picker's search box can never become the target. Pressing the
button calls `preventDefault()` on `pointerdown`, so the field never loses focus and the
caret position survives.

Insertion prefers `document.execCommand('insertText')`, which keeps the browser's native
undo stack intact and fires a trusted `input` event by itself. If that is unavailable it
falls back to splicing the value and dispatching `input` and `change` manually.

The `input` event matters: SillyTavern syncs character fields, world info entry content
and the chat input's auto-resize off it. Setting `.value` without dispatching would look
correct on screen and silently fail to save.

## Installation

In SillyTavern: **Extensions → Install extension**, then paste:

```
https://github.com/ribbinzcat-afk/quick-prompt.git
```

Reload the page afterwards.

Or install manually by copying the whole folder into your user extensions directory:

```
<SillyTavern>/data/<your-user>/extensions/quick-prompt/
```

Either way the folder must end up named `quick-prompt`, because that has to match
`extensionName` in `index.js`. SillyTavern derives the folder name from the repository
name, so the repo cannot be renamed without also editing `index.js`.

`auto_update` is enabled, so SillyTavern will pull new commits on startup.

## Data

Everything lives in `extension_settings['quick-prompt']`:

```js
{
  categories: [
    { id: '<uuid>', name: 'Character Setup', prompts: [
      { id: '<uuid>', title: 'Intro Scene', content: '...' }
    ]}
  ],
  fabEnabled: true,
  fabPosition: 'right',
  lastCategoryId: null
}
```

Imports re-issue every `id`, so importing a file you previously exported can never collide
with what is already stored.

## Troubleshooting

Open the browser console (F12) and look for lines prefixed with `[quick-prompt]`.

| Symptom | Likely cause |
| --- | --- |
| "Tap the text field you want to insert into first" | No field has been focused yet and the chat input is not available. |
| The floating button never appears | Turned off in settings, or no text field is currently on screen. |
| Text appears but is not saved | Check whether the target field is one SillyTavern actually watches; the extension always dispatches `input`. |
