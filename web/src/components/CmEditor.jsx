import { getTokens, getRoles } from '@/theme/contract.js';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import Box from '@mui/material/Box';
import { useTheme } from '@mui/material/styles';
import CodeMirror from '@uiw/react-codemirror';
import { EditorView } from '@codemirror/view';
import { useColorMode } from '@zapac/mui-theme';
import { makeCmTheme } from '@/lib/cmTheme.js';

// Thin wrapper around @uiw/react-codemirror shared by Config/Hooks/Rules/Memory:
// owns the glass Box border/radius wrapper, plus the stable extensions/onChange
// identities CodeMirror needs — a fresh array/callback each render makes its
// reconfigure effect fire, which drops the open Ctrl+F search panel (flash-close).
// `deps` controls when `extensions` is recomputed (default: never again after
// mount); pass e.g. [path] when the language extension depends on the selected file.
export default function CmEditor({ value, onChange, extensions = [], deps = [], height = '100%' }) {
  const { resolved } = useColorMode(); // 'light' | 'dark' — system mode mapped through the OS
  const theme = useTheme();
  // A framed skin (Phosphor) is dark-only, so its base CodeMirror theme is
  // always 'dark' regardless of any ZAPAC light/dark preference left in storage.
  const framed = !!getRoles(theme).shell?.frameBorderWidth;
  const base = framed || resolved === 'dark' ? 'dark' : 'light';
  // Stable per theme identity — MUI hands back the same theme object across
  // renders, so this doesn't retrigger CodeMirror's reconfigure (see below).
  const cmTheme = useMemo(() => makeCmTheme(theme), [theme]);
  // Serialized so the dep list stays an array literal (react-hooks/use-memo);
  // every caller passes plain strings — checked against all 5 call sites:
  // HooksEditor (`[path]`), RulesPanel (`[ref.path]` or `[]`), SkillsPanel
  // (`` [`f:${file.path}`] ``), ConfigEditor and MemoryPanel (both omit `deps`,
  // so it's always `[]`). `extensions` is deliberately excluded — `deps` is
  // caller-controlled, mirroring each panel's own useMemo before this was
  // extracted.
  const depKey = JSON.stringify(deps);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
  const cmExtensions = useMemo(() => [EditorView.lineWrapping, ...extensions, cmTheme], [depKey, cmTheme]);
  // Callers pass a fresh onChange each render; forward through a ref so
  // CodeMirror always sees the same function identity regardless.
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; });
  const stableOnChange = useCallback((v) => onChangeRef.current(v), []);
  return (
    <Box sx={(t) => ({ flex: 1, minHeight: 0, overflow: 'auto', border: `1px solid ${getTokens(t).glass.stroke}`, borderRadius: `${getTokens(t).radius.sm}px` })}>
      <CodeMirror value={value} theme={base} height={height} extensions={cmExtensions} onChange={stableOnChange} />
    </Box>
  );
}
