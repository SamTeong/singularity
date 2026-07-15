import React, { useEffect, useRef, useState, useCallback } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import RefreshIcon from '@mui/icons-material/Refresh';
import ReceiptLongIcon from '@mui/icons-material/ReceiptLong';
import { EmptyState, useColorMode } from '@zapac/mui-theme';

// The report bootstraps its theme from documentElement.dataset.theme, seeded by
// localStorage['agents-report-theme']. Same-origin iframe → we drive both: seed
// the key (governs the bootstrap read, so no light-flash) and set data-theme
// directly on the live doc so an already-loaded report follows the app instantly.
const REPORT_THEME_KEY = 'agents-report-theme';

// iframe can't send the x-sing-token header, so the token rides the query string
// (same as the WS). `t` (report mtime) cache-busts on refresh.
const TOKEN = window.__SING_TOKEN__;
const reportSrc = (t) => `/spend/report?t=${t}${TOKEN ? `&token=${encodeURIComponent(TOKEN)}` : ''}`;

// Spend report: renders the claude-code-usage-report skill's self-contained HTML
// in a sandboxed iframe. Generate/Refresh spawns the skill server-side.
export default function SpendView() {
  const [status, setStatus] = useState(null); // { exists, at } | null while loading
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const { resolved } = useColorMode(); // 'light' | 'dark' — the app's active mode
  const iframeRef = useRef(null);

  // Seed the report's bootstrap key so a (re)load starts in the app's mode.
  try { localStorage.setItem(REPORT_THEME_KEY, resolved); } catch {}

  // Push the app's mode into the already-loaded report doc (same-origin access).
  const syncTheme = useCallback(() => {
    const doc = iframeRef.current?.contentDocument;
    if (doc) { try { doc.documentElement.dataset.theme = resolved; } catch {} }
  }, [resolved]);
  useEffect(syncTheme, [syncTheme, status?.at]);

  useEffect(() => {
    fetch('/spend/status').then((r) => r.json()).then(setStatus)
      .catch(() => setStatus({ exists: false, at: null }));
  }, []);

  const refresh = useCallback(() => {
    setBusy(true); setError(null);
    fetch('/spend/refresh', { method: 'POST' })
      .then((r) => r.json())
      .then((d) => { if (d.ok) setStatus({ exists: true, at: d.at }); else setError(d.error || 'refresh failed'); })
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  }, []);

  return (
    <Stack sx={{ height: '100%' }}>
      <Stack direction="row" spacing={1} sx={{ px: 2, py: 1.25, alignItems: 'center', flexShrink: 0 }}>
        <ReceiptLongIcon sx={{ fontSize: 18, color: 'text.secondary' }} />
        <Typography variant="subtitle2" sx={{ flex: 1 }}>Usage report</Typography>
        <Button
          size="small"
          startIcon={busy ? <CircularProgress size={14} color="inherit" /> : <RefreshIcon />}
          onClick={refresh}
          disabled={busy}
          sx={{ '& .MuiButton-startIcon': { marginRight: 0.5 } }}
        >
          {busy ? 'Generating…' : (status?.exists ? 'Refresh' : 'Generate')}
        </Button>
      </Stack>
      {error && <Typography sx={{ px: 2, pb: 1, color: 'error.main', fontSize: 13 }}>{error}</Typography>}
      <Box sx={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {status?.exists ? (
          // Reports are fully self-contained (zero external requests); allow-scripts
          // for the inlined charts, allow-same-origin so the report's theme toggle
          // can use its own localStorage. Content is user-owned local data.
          <Box
            component="iframe"
            key={status.at}
            ref={iframeRef}
            onLoad={syncTheme}
            title="Spend report"
            src={reportSrc(status.at)}
            sandbox="allow-scripts allow-same-origin"
            sx={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0 }}
          />
        ) : (
          <Box sx={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
            <EmptyState
              icon={<ReceiptLongIcon />}
              title={status ? 'No report yet' : 'Loading…'}
              description={status ? 'Generate a spend report from your Claude Code usage.' : ''}
            />
          </Box>
        )}
      </Box>
    </Stack>
  );
}
