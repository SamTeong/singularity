import { NAV } from '@/shell/Sidebar.jsx';
import { NAV_ITEMS } from '@/shell/AppMenu.jsx';

// The one view catalog: sidebar rail (NAV) + More-menu overflow (NAV_ITEMS),
// deduped by view id. Feeds the command palette's Views group and the router's
// route validation, so a view that exists in the nav is addressable by URL and
// nothing else is.
export const VIEW_LIST = [];
for (const item of [...NAV, ...NAV_ITEMS]) {
  if (VIEW_LIST.some((x) => x.v === item.v)) continue;
  VIEW_LIST.push({ v: item.v, label: item.label });
}

export const VIEWS = new Set(VIEW_LIST.map((x) => x.v));
