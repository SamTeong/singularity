import { useEffect, useRef, useState, useCallback } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import CircularProgress from '@mui/material/CircularProgress';
import RefreshIcon from '@mui/icons-material/Refresh';
import ReceiptLongIcon from '@mui/icons-material/ReceiptLong';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { useColorMode } from '@zapac/mui-theme';
import { EmptyState } from '@/components/EmptyState.jsx';
import { useCapabilities } from '@/hooks/useCapabilities.js';
import { useThemeSkin } from '@/theme/AppThemeProvider.jsx';

// The report bootstraps its theme/skin from documentElement.dataset.{theme,skin},
// seeded by localStorage['agents-report-theme']/['agents-report-skin']. Same-origin
// iframe → we drive both: seed the keys (governs the bootstrap read, so no
// light/ZAPAC flash) and set the dataset directly on the live doc so an
// already-loaded report follows the app instantly.
const REPORT_THEME_KEY = 'agents-report-theme';
const REPORT_SKIN_KEY = 'agents-report-skin';

// ponytail: the iframe src can't set the x-sing-token header (iframe attributes
// can't carry custom headers), and switching to fetch() + srcdoc/blob breaks the
// report — its assets resolve via relative URLs against the report's own origin,
// and its theme toggle reads localStorage (both opaque under srcdoc/blob, which
// give an opaque origin + no base URL). Same-origin + 127.0.0.1-only bind + the
// origin allowlist keep the query-string token's exposure to loopback only, and
// the server redacts token= from logs. So ?token= stays.
const TOKEN = window.__SING_TOKEN__;
// skin/theme ride along so the report's inline bootstrap (base.html) resolves the
// right presentation on its first painted frame, before any host round-trip.
const reportSrc = (t, skinId, theme) =>
  `/api/usagereport/report?t=${t}&skin=${encodeURIComponent(skinId)}&theme=${encodeURIComponent(theme)}${TOKEN ? `&token=${encodeURIComponent(TOKEN)}` : ''}`;

// The `src` is captured once per mount rather than recomputed each render, and
// that is load-bearing: `src` is a DOM attribute, so letting it track live skin/
// mode state would make React rewrite it on every light/dark toggle and navigate
// the iframe — throwing away scroll position, legend selection and the hero's
// typing animation, and re-parsing the whole self-contained document. The query
// string exists only to get the FIRST frame right; every change after that is
// syncTheme's job. The caller keys this on `status.at`, so a Refresh (the one
// event that legitimately reloads) remounts and re-captures the current values.
function ReportFrame({ at, skinId, mode, onLoad, ref }) {
  const [src] = useState(() => reportSrc(at, skinId, mode));
  return (
    <Box
      component="iframe"
      ref={ref}
      onLoad={onLoad}
      title="Usage report"
      src={src}
      sx={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0 }}
    />
  );
}

// Usage report: renders the harness-usage-report skill's self-contained HTML
// in a sandboxed iframe. Generate/Refresh spawns the skill server-side.
export default function UsageReportView() {
  const [status, setStatus] = useState(null); // { exists, at } | null while loading
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(true);
  const { resolved } = useColorMode(); // 'light' | 'dark' — the app's active mode
  const { skinId } = useThemeSkin();
  const iframeRef = useRef(null);
  const caps = useCapabilities();
  // usageReport.available gates this whole view (the skill path is configured via
  // SING_USAGE_SKILL + SING_USAGE_REPORTS). null = still loading / fetch failed
  // → don't gate (avoids hiding a working feature on a transient glitch).
  const usageReportUnavailable = caps && caps.usageReport?.available === false;
  const usageReportHint = caps?.usageReport?.hint;

  // Seed the report's bootstrap keys so a (re)load with no query string still
  // starts in the app's mode/skin — i.e. someone opening
  // /usagereport/report directly in a tab. (A report copied out and opened as a
  // file:// URL has a different storage origin and can never read these; it
  // falls back to ZAPAC/light by design.) Persisting the raw skinId is fine: the
  // report's Phosphor CSS keys off data-skin="phosphor" specifically, so any
  // other value is inert — and it is the same value the live-sync path writes.
  try {
    localStorage.setItem(REPORT_THEME_KEY, resolved);
    localStorage.setItem(REPORT_SKIN_KEY, skinId);
  } catch {}

  // Push the app's mode + skin into the already-loaded report doc (same-origin
  // access). `data-skin="phosphor"` activates the report's Phosphor CSS overrides
  // (black CRT surfaces, orange chrome, mint nominal); any other value is inert
  // and renders ZAPAC. Written unconditionally — the same value the load-time
  // query string and the bootstrap's localStorage fallback resolve to — so the
  // two paths can't leave the doc in states that differ (an earlier version
  // deleted the attribute for ZAPAC, which disagreed with the `zapac` the
  // bootstrap writes, and would diverge the moment a `:not([data-skin])` rule
  // appears). Mirrors AppThemeProvider, which publishes the raw id the same way.
  const syncTheme = useCallback(() => {
    const doc = iframeRef.current?.contentDocument;
    if (doc) {
      try {
        doc.documentElement.dataset.theme = resolved;
        doc.documentElement.dataset.skin = skinId;
      } catch {}
    }
  }, [resolved, skinId]);
  useEffect(syncTheme, [syncTheme, status?.at]);

  useEffect(() => {
    fetch('/api/usagereport/status').then((r) => r.json()).then(setStatus)
      .catch(() => setStatus({ exists: false, at: null }));
  }, []);

  const refresh = useCallback(() => {
    setBusy(true); setError(null);
    fetch('/api/usagereport/refresh', { method: 'POST' })
      .then((r) => r.json())
      .then((d) => { if (d.ok) setStatus({ exists: true, at: d.at }); else setError(d.error || 'refresh failed'); })
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  }, []);

  return (
    <Stack sx={{ height: '100%' }}>
      <Stack direction="row" spacing={1} sx={{ px: 3, py: 1.25, alignItems: 'center', flexShrink: 0 }}>
        <IconButton
          size="small"
          onClick={() => setOpen((o) => !o)}
          aria-label={open ? 'Collapse usage report' : 'Expand usage report'}
          sx={{ transform: open ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform .2s' }}
        >
          <ExpandMoreIcon />
        </IconButton>
        <ReceiptLongIcon sx={{ fontSize: 18, color: 'text.secondary' }} />
        <Typography variant="subtitle2" sx={{ flex: 1 }}>Usage report</Typography>
        <Button
          size="small"
          startIcon={busy ? <CircularProgress size={14} color="inherit" /> : <RefreshIcon />}
          onClick={refresh}
          disabled={busy || usageReportUnavailable}
          sx={{ '& .MuiButton-startIcon': { marginRight: 0.5 } }}
        >
          {busy ? 'Generating…' : (status?.exists ? 'Refresh' : 'Generate')}
        </Button>
      </Stack>
      {error && <Typography sx={{ px: 2, pb: 1, color: 'error.main', fontSize: 13 }}>{error}</Typography>}
      <Box sx={{ flex: 1, minHeight: 0, position: 'relative', display: open ? 'block' : 'none' }}>
        {status?.exists ? (
          // No sandbox attribute: allow-scripts + allow-same-origin together are
          // equivalent to no sandbox (the browser warns the iframe can escape it),
          // and we need both — allow-scripts for the inlined charts, allow-same-origin
          // so the report's theme toggle uses its own localStorage and the parent can
          // reach contentDocument for syncTheme. Report is trusted same-origin local
          // content (127.0.0.1, token-gated, user-owned), so no sandbox is fine.
          <ReportFrame
            key={status.at}
            at={status.at}
            skinId={skinId}
            mode={resolved}
            onLoad={syncTheme}
            ref={iframeRef}
          />
        ) : (
          <Box sx={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
            <EmptyState
              icon={<ReceiptLongIcon />}
              title={usageReportUnavailable ? 'Usage report not set up yet' : (status ? 'No report yet' : 'Loading…')}
              description={usageReportUnavailable ? usageReportHint : (status ? "Create a report showing how you've used Claude Code." : '')}
            />
          </Box>
        )}
      </Box>
    </Stack>
  );
}
