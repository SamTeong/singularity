/**
 * Shared shell surface styles — the glass recipe and the paper-tooltip slot
 * props, used by the sidebar, main view, and session dock.
 */
import { getTokens } from '@/theme/contract.js';

// The glass recipe reads its surface tokens through getTokens() (the skin-
// agnostic accessor) so a non-ZAPAC skin only has to satisfy that contract.
// getTokens resolves from theme.vars (the scheme-switching CSS-var reference)
// under cssVariables, not theme.palette.
export const glass = (t) => {
  const { glass: g } = getTokens(t);
  return {
    background: g.surface,
    backdropFilter: `blur(${g.blur})`,
    border: `1px solid ${g.stroke}`,
    // cardShadow + a crisp 1px top-edge sheen — the canonical glass recipe's
    // highlight (DESIGN §4), as an inset shadow so it clips to the radius and
    // never fights child stacking.
    boxShadow: `${g.cardShadow}, inset 0 1px 0 rgba(255,255,255,0.18)`,
  };
};

// Paper-surface tooltip styling, shared across the nav rail + collapsed list.
export const PAPER_TOOLTIP_SLOTPROPS = {
  tooltip: {
    sx: {
      bgcolor: 'var(--mui-palette-background-paper) !important',
      color: 'var(--mui-palette-text-primary) !important',
      border: '1px solid var(--mui-palette-divider) !important',
      backdropFilter: 'blur(8px)',
      whiteSpace: 'pre-line', // multi-line titles (usage summary) break on \n
    },
  },
};
