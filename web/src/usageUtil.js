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

// Severity color: calm until 70%, warn to 90%, error past 90%.
export function meterColor(t, pct) {
  const p = pct ?? 0;
  const k = p >= 90 ? 'error' : p >= 70 ? 'warning' : 'success';
  return t.vars.palette[k].main;
}

