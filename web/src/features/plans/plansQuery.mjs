// Pure URL / saved-state rules for PlansView: timeframe, ?status= buckets, ?layout=.

// Recognised ?preset= values; anything else falls back to the default. Same
// URL contract as History (?preset=3|7|30|all|custom plus ?from/?to ISO days).
export const PRESETS = new Set(['3', '7', '30', 'all', 'custom']);
export const BUCKETS = ['active', 'done', 'blocked', 'superseded', 'other'];
export const LAYOUTS = ['carousel', 'board'];
const DEFAULT_TIMEFRAME = { preset: '3', from: '', to: '' };
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
export const isoDay = (v) => (ISO_DAY.test(v) ? v : '');

// The localStorage timeframe (raw JSON string or null); invalid -> 3d default.
export function parseSavedTimeframe(raw) {
  try {
    const saved = JSON.parse(raw);
    if (saved && PRESETS.has(saved.preset)) {
      return { preset: saved.preset, from: isoDay(saved.from), to: isoDay(saved.to) };
    }
  } catch { /* invalid JSON */ }
  return { ...DEFAULT_TIMEFRAME };
}

// The URL timeframe; an unrecognised preset degrades to 3d.
export function urlTimeframe(searchParams) {
  const p = searchParams.get('preset') ?? '3';
  return { preset: PRESETS.has(p) ? p : '3', from: isoDay(searchParams.get('from')), to: isoDay(searchParams.get('to')) };
}

export const validStatuses = (list) => list.filter((v) => BUCKETS.includes(v));
export const validLayout = (v) => (LAYOUTS.includes(v) ? v : 'carousel');
