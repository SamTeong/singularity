import { NAV } from '@/shell/Sidebar.jsx';
import { NAV_ITEMS } from '@/shell/AppMenu.jsx';

// Build the Views command group from the unified view catalog.
// Sidebar.NAV (primary rail) + AppMenu.NAV_ITEMS (overflow) — deduped by v.
// Phase 0: Views group only; later phases add sessions/files/toggles/actions.
export function buildCommands(ctx) {
  const views = [];
  const seen = new Set();
  for (const item of [...NAV, ...NAV_ITEMS]) {
    if (seen.has(item.v)) continue;
    seen.add(item.v);
    views.push({ v: item.v, label: item.label });
  }
  return views.map((x) => ({
    id: 'view:' + x.v,
    group: 'Views',
    label: x.label,
    keywords: [x.v],
    hint: 'view',
    run: () => ctx.setView(x.v),
  }));
}
