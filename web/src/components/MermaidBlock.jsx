import { useEffect, useId, useState } from 'react';
import Box from '@mui/material/Box';
import { useTheme } from '@mui/material/styles';
import { useColorMode } from '@zapac/mui-theme';
import { getRoles } from '@/theme/contract.js';

// Renders a mermaid diagram from raw chart source. mermaid is dynamically
// imported so it stays out of the initial bundle — loaded only when a
// ```mermaid fence actually renders. securityLevel:'strict' blocks script
// injection in diagram source. Theme tracks the app color mode.
export default function MermaidBlock({ chart }) {
  const rawId = useId();
  const id = `mmd-${rawId.replace(/[^A-Za-z0-9_-]/g, '')}`;
  const { resolved } = useColorMode(); // 'light' | 'dark' — system mode mapped through the OS
  const theme = useTheme();
  const roles = getRoles(theme);
  // A framed skin (Phosphor) is dark-only and has its own semantic palette, so
  // it drives mermaid's `base` theme through themeVariables rather than taking
  // the stock 'dark'/'default' pair (task 7.2). Without this a stale ZAPAC
  // light-mode preference rendered a white-on-white diagram on the black
  // console, and even the dark theme painted mermaid's own off-palette blues.
  const framed = !!roles.shell?.frameBorderWidth;
  // Serialized into the state tag below so a skin change re-renders the diagram.
  const mermaidTheme = framed
    ? {
      theme: 'base',
      themeVariables: {
        darkMode: true,
        background: roles.shell.surface,
        mainBkg: roles.shell.panel,
        primaryColor: roles.shell.panel,
        primaryBorderColor: roles.chrome.stroke,
        primaryTextColor: roles.status.nominal,
        secondaryColor: roles.shell.panel,
        tertiaryColor: roles.shell.surface,
        lineColor: roles.chrome.stroke,
        textColor: roles.status.nominal,
      },
    }
    : { theme: resolved === 'dark' ? 'dark' : 'default' };
  // One state cell tagged with the input it was rendered for, so a stale
  // diagram is discarded during render instead of via a reset-setState effect.
  const tag = `${String(chart)}|${resolved}|${framed ? 'phosphor' : 'zapac'}`;
  const [res, setRes] = useState({ tag: null, svg: '', err: null });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', ...mermaidTheme });
        const { svg: out } = await mermaid.render(id, String(chart).replace(/\n$/, ''));
        if (!cancelled) setRes({ tag, svg: out, err: null });
      } catch (e) {
        if (!cancelled) setRes({ tag, svg: '', err: String(e?.message ?? e) });
      }
    })();
    return () => { cancelled = true; };
    // `mermaidTheme` is derived from the theme + `resolved`, both already in the
    // dep list via `tag`; excluding it keeps this effect from refiring on every
    // render (the object literal is a fresh identity each time).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chart, resolved, id, tag]);

  const { svg, err } = res.tag === tag ? res : { svg: '', err: null };

  if (err) {
    return <Box component="pre" sx={{ m: 0, p: 1.5, fontSize: 12, color: 'error.main', bgcolor: 'action.hover', borderRadius: 1, overflow: 'auto' }}>{err}</Box>;
  }
  return <Box sx={{ display: 'flex', justifyContent: 'center', minHeight: 24 }} dangerouslySetInnerHTML={{ __html: svg }} />;
}