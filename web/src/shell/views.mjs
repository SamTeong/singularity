import { NAV } from '@/shell/Sidebar.jsx';
import { NAV_ITEMS } from '@/shell/AppMenu.jsx';

// The one view catalog: sidebar rail (NAV) + More-menu overflow (NAV_ITEMS),
// deduped by view id. NAV_CATALOG keeps every item field (icon included) for
// consumers that render a full row (MobileNavDrawer); VIEW_LIST is the
// `{v, label}` shape the command palette's Views group and the router's route
// validation need.
export const NAV_CATALOG = [];
for (const item of [...NAV, ...NAV_ITEMS]) {
  if (NAV_CATALOG.some((x) => x.v === item.v)) continue;
  NAV_CATALOG.push(item);
}

export const VIEW_LIST = NAV_CATALOG.map((x) => ({ v: x.v, label: x.label }));

export const VIEWS = new Set(VIEW_LIST.map((x) => x.v));
