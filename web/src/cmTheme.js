import { EditorView } from '@codemirror/view';

// Sit CodeMirror on the glass surface instead of its stock opaque background,
// and use the system mono (JetBrains Mono). Syntax colors still come from the
// light/dark base theme; this only neutralizes the chrome so the editor reads
// as part of the zapac glass system, not a pasted-in widget.
export const cmTheme = EditorView.theme({
  '&': { backgroundColor: 'transparent', fontSize: '13px' },
  '.cm-gutters': { backgroundColor: 'transparent', border: 'none' },
  '.cm-content': { fontFamily: '"JetBrains Mono", ui-monospace, SF Mono, Menlo, Consolas, monospace' },
  '.cm-activeLine': { backgroundColor: 'rgba(152,91,156,0.08)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent' },
  '.cm-focused': { outline: 'none' },
});
