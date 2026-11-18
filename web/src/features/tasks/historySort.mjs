// Pure tag-filter and History-table sort rules for TasksBoard.
import { repoName } from '../../lib/paths.js';

// OR semantics: an item matches if it carries ANY active tag; an empty set matches all.
export const matchesTags = (activeTags, item) => activeTags.size === 0 || (item.tags || []).some((t) => activeTags.has(t));

// Sort value per header key. Numeric fields fall back to 0; strings to ''.
export const sortValue = (h, key) => {
  const s = h.finalStats;
  switch (key) {
    case 'title': return h.title;
    case 'repo': return repoName(h.repo);
    case 'branch': return h.branch || '';
    case 'outcome': return h.outcome;
    case 'busyMs': return s?.busyMs ?? 0;
    case 'apiMs': return s?.apiMs ?? 0;
    case 'costUsd': return s?.costUsd ?? 0;
    case 'tokens': return s?.tokens ?? 0;
    case 'concludedAt': return h.concludedAt ? new Date(h.concludedAt).getTime() : 0;
    default: return 0;
  }
};

// Numeric fields compare by value, strings by localeCompare.
export const compareHistory = (sort) => {
  const dir = sort.dir === 'desc' ? -1 : 1;
  return (a, b) => {
    const va = sortValue(a, sort.key), vb = sortValue(b, sort.key);
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
    return String(va).localeCompare(String(vb)) * dir;
  };
};
