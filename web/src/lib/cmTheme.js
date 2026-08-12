import { EditorView } from '@codemirror/view';
import { getRoles } from '@/theme/contract.js';

// Sit CodeMirror on the active skin's surface instead of its stock opaque
// background, and use the system mono (JetBrains Mono). Syntax colors still
// come from the light/dark base theme; this only neutralizes the chrome so the
// editor reads as part of the skin, not a pasted-in widget.
//
// A factory rather than a module-level constant (task 7.2): the active-line and
// focus-ring colors used to be hardcoded ZAPAC purple, which painted
// `rgba(152,91,156,…)` into the Phosphor console — the editor was the one
// remaining surface that ignored the skin. Both now resolve through the
// semantic roles, so ZAPAC keeps its exact previous values and Phosphor gets
// its own chrome.
//
// `roles.focus.color` is Phosphor's dashed-amber focus hue; under ZAPAC the
// roles bundle carries its purple. The literals below are the ZAPAC fallbacks
// for a theme/test double that hasn't populated roles.
const ZAPAC_ACTIVE_LINE = 'rgba(152,91,156,0.08)';
const ZAPAC_FOCUS_RING = 'rgba(152,91,156,0.5)';

/**
 * Build the skin-aware CodeMirror chrome extension.
 * @param {object} t MUI theme
 * @returns {import('@codemirror/state').Extension}
 */
export const makeCmTheme = (t) => {
  const roles = getRoles(t);
  const framed = !!roles.shell?.frameBorderWidth; // Phosphor
  return EditorView.theme({
    '&': { backgroundColor: 'transparent', fontSize: '13px' },
    '.cm-gutters': { backgroundColor: 'transparent', border: 'none' },
    // Unchanged across skins — both systems specify JetBrains Mono for source.
    '.cm-content': { fontFamily: '"JetBrains Mono", ui-monospace, SF Mono, Menlo, Consolas, monospace' },
    '.cm-activeLine': { backgroundColor: framed ? roles.chrome.track : ZAPAC_ACTIVE_LINE },
    '.cm-activeLineGutter': { backgroundColor: 'transparent' },
    '.cm-focused': {
      outline: 'none',
      boxShadow: `inset 0 0 0 2px ${framed ? roles.focus.color : ZAPAC_FOCUS_RING}`,
    },
  });
};
