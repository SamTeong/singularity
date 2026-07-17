// Shared helpers for the usage pill + view. Both render the same normalized
// {ollama, claude} payload from GET /usage.
export const PROVIDERS = [
  { key: 'claude', label: 'Claude' },
  { key: 'ollama', label: 'Ollama' },
];

// Relative countdown to an ISO reset instant: "40m" / "3h" / "5d" / "now".
export function fmtReset(iso) {
  if (!iso) return '—';
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms)) return '—';
  if (ms <= 0) return 'now';
  const h = ms / 3.6e6;
  if (h < 1) return `${Math.max(1, Math.round(ms / 6e4))}m`;
  if (h < 48) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}

// Divider gridlines splitting a meter track into n equal segments (5h→5, 7d→7),
// so fill-vs-grid reads as a burn-rate gauge. Overlay on top of the fill.
export function segTicks(color, n) {
  const seg = 100 / n;
  return `repeating-linear-gradient(to right, transparent 0, transparent calc(${seg}% - 1.5px), ${color} calc(${seg}% - 1.5px), ${color} ${seg}%)`;
}

// Severity color: calm until 70%, warn to 90%, error past 90%.
export function meterColor(t, pct) {
  const p = pct ?? 0;
  const k = p >= 90 ? 'error' : p >= 70 ? 'warning' : 'success';
  return t.vars.palette[k].main;
}

// Per-provider summary for the collapsed rail tooltip, one line per provider:
// "Claude — 5h: 13%, 7d: 22%\nOllama — 5h: 0%, 7d: 99%". Null if nothing loaded.
// Render with whiteSpace: 'pre-line' so the \n breaks.
export function usageSummary(usage) {
  const win = (label, w) => `${label}: ${w?.pctUsed == null ? '—' : `${Math.round(w.pctUsed)}%`}`;
  const parts = [];
  for (const p of PROVIDERS) {
    const u = usage?.[p.key];
    if (!u?.ok) continue;
    parts.push(`${p.label} — ${win('5h', u.session)}, ${win('7d', u.weekly)}`);
  }
  return parts.length ? parts.join('\n') : null;
}

