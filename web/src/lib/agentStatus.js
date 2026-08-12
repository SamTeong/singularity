// agent lifecycle -> the theme's fixed StatusPill kinds (done|active|review|error).
// Was triplicated across App.jsx/TasksBoard.jsx/CronJobs.jsx — a new lifecycle
// state had to be added in all 3 or a pill silently fell back to 'review'.
export const KIND = { starting: 'active', running: 'active', idle: 'review', detached: 'review', exited: 'error' };

// KIND -> DomainStateId (lib/domainState.js), for the Phosphor tone/bilingual
// mapping every skin-neutral status surface reads from. Was independently
// re-derived three times (StatusPill.jsx's `STATUS_TO_DOMAIN`, TasksBoard.jsx's
// `AGENT_KIND_TO_DOMAIN`, and an inline ternary chain in TaskDetailPanel.jsx) —
// centralized here alongside KIND itself, the map it's built from, so a future
// lifecycle state only needs to be taught to KIND and this table stays correct
// everywhere. `active` means "currently executing", the same meaning as
// `domainState`'s `running`; `error` covers both a hard failure and a lost
// connection, the same meaning as `domainState`'s `failed`.
export const KIND_TO_DOMAIN = { done: 'done', active: 'running', review: 'review', error: 'failed' };
