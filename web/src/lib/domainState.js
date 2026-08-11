/**
 * Domain-state → Phosphor tone + bilingual label mapping (design.md D4).
 *
 * ONE shared table for the six lifecycle states that recur across the app —
 * sidebar counts, task columns/cards/detail, session rows, and any skin-neutral
 * status primitive (`StatusPill` and friends). Consumers resolve a domain
 * meaning (e.g. a task's column, a session's connection state) to one of the
 * `DomainStateId`s below and read tone/label/accessibility info from here —
 * do NOT re-derive or duplicate this mapping locally in a feature file.
 *
 * Safety orange never appears as a `tone` here: per design.md D4/brief, orange
 * is reserved for structural chrome (frame lines, dividers, axes, metadata
 * keys) and must never encode a data/status value.
 *
 * `tone` is a {@link import('phosphor-console-theme/components').Tone} —
 * resolve it to an actual color with `toneHue(theme, tone)` (Phosphor) or via
 * `getRoles(theme).status` (skin-neutral; see `theme/contract.js`). This
 * module only owns the domain → tone/label mapping, not color resolution.
 *
 * @typedef {'queued'|'planning'|'running'|'review'|'done'|'failed'} DomainStateId
 *
 * @typedef {Object} DomainStateEntry
 * @property {import('phosphor-console-theme/components').Tone} tone canonical Phosphor tone
 * @property {boolean} filled figure/ground inversion (solid fill + black content) vs. outline
 * @property {string} jp large Mincho Japanese label
 * @property {string} en small English caption paired with `jp` (also the
 *   ZAPAC-facing label, since ZAPAC has no bilingual chrome)
 * @property {string} srLabel full English accessible name (aria-label / screen-reader text)
 */

/** @type {Record<DomainStateId, DomainStateEntry>} */
export const DOMAIN_STATE = Object.freeze({
  queued: Object.freeze({ tone: 'green', filled: false, jp: '待機', en: 'QUEUED', srLabel: 'Queued' }),
  planning: Object.freeze({ tone: 'blue', filled: false, jp: '立案', en: 'PLANNING', srLabel: 'Planning' }),
  running: Object.freeze({ tone: 'mint', filled: false, jp: '稼働', en: 'RUNNING', srLabel: 'Running' }),
  review: Object.freeze({ tone: 'amber', filled: false, jp: '審査', en: 'REVIEW', srLabel: 'In review' }),
  done: Object.freeze({ tone: 'mint', filled: true, jp: '完了', en: 'MERGED', srLabel: 'Done — merged' }),
  // Design.md's table leaves this row's bilingual treatment as "—, explicit
  // symbol + text": there is no single mandated jp/en pair for every failure
  // context. This entry supplies a reasonable generic default; a caller with
  // more specific context (e.g. "ABANDONED", "DISCONNECTED") may render its
  // own `en`/`srLabel` text alongside this entry's `tone`/`filled`.
  failed: Object.freeze({ tone: 'red', filled: true, jp: '異常', en: 'FAILED', srLabel: 'Failed or disconnected' }),
});

/** Canonical lifecycle order — for legends/columns that render every state in sequence. */
export const DOMAIN_STATE_ORDER = Object.freeze(['queued', 'planning', 'running', 'review', 'done', 'failed']);

/**
 * Look up a domain state entry, falling back to `queued` for an unknown id so
 * a consumer never has to null-check before reading `.tone`/`.jp`/etc.
 * @param {string} id a {@link DomainStateId} (or any string — unknown ids fall back)
 * @returns {DomainStateEntry}
 */
export function getDomainState(id) {
  return DOMAIN_STATE[id] ?? DOMAIN_STATE.queued;
}
