import { useEffect, useId, useState } from 'react';
import Box from '@mui/material/Box';
import { useColorMode } from '@zapac/mui-theme';

// Renders a mermaid diagram from raw chart source. mermaid is dynamically
// imported so it stays out of the initial bundle — loaded only when a
// ```mermaid fence actually renders. securityLevel:'strict' blocks script
// injection in diagram source. Theme tracks the app color mode.
export default function MermaidBlock({ chart }) {
  const rawId = useId();
  const id = `mmd-${rawId.replace(/[^A-Za-z0-9_-]/g, '')}`;
  const { resolved } = useColorMode(); // 'light' | 'dark' — system mode mapped through the OS
  const [svg, setSvg] = useState('');
  const [err, setErr] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setSvg(''); setErr(null);
    (async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: resolved === 'dark' ? 'dark' : 'default' });
        const { svg: out } = await mermaid.render(id, String(chart).replace(/\n$/, ''));
        if (!cancelled) setSvg(out);
      } catch (e) {
        if (!cancelled) setErr(String(e?.message ?? e));
      }
    })();
    return () => { cancelled = true; };
  }, [chart, resolved, id]);

  if (err) {
    return <Box component="pre" sx={{ m: 0, p: 1.5, fontSize: 12, color: 'error.main', bgcolor: 'action.hover', borderRadius: 1, overflow: 'auto' }}>{err}</Box>;
  }
  return <Box sx={{ display: 'flex', justifyContent: 'center', minHeight: 24 }} dangerouslySetInnerHTML={{ __html: svg }} />;
}