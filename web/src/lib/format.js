// Shared value formatters. Previously copy-pasted per-consumer and drifted
// (SessionHistory's fmtUsd handled null + sub-cent; TasksBoard's didn't) — one
// implementation here so a display fix lands everywhere at once.

// Dollar amount, "" below a cent so a real cost never renders as $0.00, null
// passed through as the "no cost known yet" sentinel.
export const fmtUsd = (n) => (n == null ? null : n > 0 && n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`);

// Token count, M/k suffixed. Drops the .0 at the 10M/10k rounding boundary
// ("12M" not "12.0M").
export const fmtTokens = (n) => {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
  return String(n || 0);
};

// "time ago" for a ms timestamp: just now / Nm / Nh / Nd, falling back to an
// ISO date past 30 days.
export function relTime(ms) {
  if (!Number.isFinite(ms)) return ''; // subagent/search opens carry no mtime — avoid new Date(NaN) throw
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 2592000) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ms).toISOString().slice(0, 10);
}
