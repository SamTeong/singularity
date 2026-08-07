/**
 * keys.js — the single source of truth for rebindable keyboard shortcuts.
 *
 * `ACTIONS` lists every shortcut the app recognises (id, group, label, default
 * binding). `DEFAULTS` derives the id->binding map from it. `matches` tests a
 * DOM KeyboardEvent against a binding; `bindingFromEvent` captures one from a
 * recording keydown; `formatBinding` renders it for display.
 *
 * Binding shape: `{ key, alt?, ctrl?, shift?, meta? }`, or `{ key, mod: true, ... }`
 * where `mod` means ctrl-or-meta (platform-agnostic Ctrl/Cmd), or
 * `{ doubleTap: 'Shift' }` for the double-tap palette trigger.
 */

export const ACTIONS = [
  // Global
  { id: 'pagePrev', group: 'Global', label: 'Previous page (More menu)', def: { key: 'ArrowUp', alt: true } },
  { id: 'pageNext', group: 'Global', label: 'Next page (More menu)', def: { key: 'ArrowDown', alt: true } },
  { id: 'paletteOpen', group: 'Global', label: 'Open command palette', def: { doubleTap: 'Shift' } },
  // Sessions
  { id: 'sessionPrev', group: 'Sessions', label: 'Previous session', def: { key: 'ArrowUp', alt: true } },
  { id: 'sessionNext', group: 'Sessions', label: 'Next session', def: { key: 'ArrowDown', alt: true } },
  { id: 'terminalCopy', group: 'Sessions', label: 'Copy terminal selection', def: { key: 'c', ctrl: true } },
  // Editor
  { id: 'editorTabPrev', group: 'Editor', label: 'Previous editor tab', def: { key: 'ArrowUp', alt: true } },
  { id: 'editorTabNext', group: 'Editor', label: 'Next editor tab', def: { key: 'ArrowDown', alt: true } },
  { id: 'editorSave', group: 'Editor', label: 'Save file', def: { key: 's', mod: true } },
  // Palette
  { id: 'paletteNext', group: 'Palette', label: 'Next command', def: { key: 'ArrowDown' } },
  { id: 'palettePrev', group: 'Palette', label: 'Previous command', def: { key: 'ArrowUp' } },
  { id: 'paletteRun', group: 'Palette', label: 'Run command', def: { key: 'Enter' } },
  { id: 'paletteClose', group: 'Palette', label: 'Close palette', def: { key: 'Escape' } },
  // History
  { id: 'dayToggle', group: 'History', label: 'Toggle day card', def: { key: 'Enter' } },
  { id: 'dayNext', group: 'History', label: 'Next day card', def: { key: 'ArrowDown' } },
  { id: 'dayPrev', group: 'History', label: 'Previous day card', def: { key: 'ArrowUp' } },
  // Chat
  { id: 'chatSend', group: 'Chat', label: 'Send message', def: { key: 'Enter' } },
];

export const DEFAULTS = Object.fromEntries(ACTIONS.map((a) => [a.id, a.def]));

/** Does a DOM KeyboardEvent satisfy `binding`? False for falsy/doubleTap bindings. */
export function matches(binding, event) {
  if (!binding || binding.doubleTap) return false;
  if (event.key !== binding.key) return false;
  if (binding.mod) {
    if (!(event.ctrlKey || event.metaKey)) return false;
  } else if (event.ctrlKey !== !!binding.ctrl || event.metaKey !== !!binding.meta) {
    return false;
  }
  return event.altKey === !!binding.alt && event.shiftKey === !!binding.shift;
}

/** Capture a binding from a recording keydown event. */
export function bindingFromEvent(event) {
  return { key: event.key, alt: event.altKey, ctrl: event.ctrlKey, shift: event.shiftKey, meta: event.metaKey };
}

const KEY_LABELS = {
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
  Enter: 'Enter', Escape: 'Esc', ' ': 'Space',
};

function keyLabel(key) {
  return KEY_LABELS[key] ?? (key.length === 1 ? key.toUpperCase() : key);
}

/** Render a binding for display, e.g. `Alt+↑`, `Ctrl+C`, `⌘/Ctrl+S`, `Shift Shift`. */
export function formatBinding(binding) {
  if (!binding) return '';
  if (binding.doubleTap) return `${binding.doubleTap} ${binding.doubleTap}`;
  const parts = [];
  if (binding.mod) parts.push('⌘/Ctrl');
  else {
    if (binding.ctrl) parts.push('Ctrl');
    if (binding.meta) parts.push('⌘');
  }
  if (binding.alt) parts.push('Alt');
  if (binding.shift) parts.push('Shift');
  parts.push(keyLabel(binding.key));
  return parts.join('+');
}
