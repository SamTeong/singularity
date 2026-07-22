import { getTokens } from '@/theme/contract.js';
import { useCallback, useMemo, useRef } from 'react';
import Box from '@mui/material/Box';
import CodeMirror from '@uiw/react-codemirror';
import { EditorView } from '@codemirror/view';
import { useColorMode } from '@zapac/mui-theme';
import { cmTheme } from '@/lib/cmTheme.js';

// Thin wrapper around @uiw/react-codemirror shared by Config/Hooks/Rules/Memory:
// owns the glass Box border/radius wrapper, plus the stable extensions/onChange
// identities CodeMirror needs — a fresh array/callback each render makes its
// reconfigure effect fire, which drops the open Ctrl+F search panel (flash-close).
// `deps` controls when `extensions` is recomputed (default: never again after
// mount); pass e.g. [path] when the language extension depends on the selected file.
export default function CmEditor({ value, onChange, extensions = [], deps = [], height = '100%' }) {
  const { resolved } = useColorMode(); // 'light' | 'dark' — system mode mapped through the OS
  // eslint-disable-next-line react-hooks/exhaustive-deps -- deps is caller-controlled, mirroring each panel's own useMemo before this was extracted
  const cmExtensions = useMemo(() => [EditorView.lineWrapping, ...extensions, cmTheme], deps);
  // Callers pass a fresh onChange each render; forward through a ref so
  // CodeMirror always sees the same function identity regardless.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const stableOnChange = useCallback((v) => onChangeRef.current(v), []);
  return (
    <Box sx={(t) => ({ flex: 1, minHeight: 0, overflow: 'auto', border: `1px solid ${getTokens(t).glass.stroke}`, borderRadius: `${getTokens(t).radius.sm}px` })}>
      <CodeMirror value={value} theme={resolved === 'dark' ? 'dark' : 'light'} height={height} extensions={cmExtensions} onChange={stableOnChange} />
    </Box>
  );
}
