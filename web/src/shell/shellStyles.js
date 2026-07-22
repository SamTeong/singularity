/**
 * Shared shell surface styles — the glass recipe and the paper-tooltip slot
 * props, used by the sidebar, main view, and session dock.
 */

// Use theme.vars (the --mui-* CSS vars) not theme.palette — under cssVariables
// theme.palette holds only the default (light) scheme's literals and won't switch
// with the .dark class; theme.vars is the scheme-switching reference.
export const glass = (t) => ({
  background: t.vars.palette.glass.surface,
  backdropFilter: `blur(${t.vars.palette.glass.blur})`,
  border: `1px solid ${t.vars.palette.glass.stroke}`,
  // cardShadow + a crisp 1px top-edge sheen — the canonical glass recipe's
  // highlight (DESIGN §4), as an inset shadow so it clips to the radius and
  // never fights child stacking.
  boxShadow: `${t.vars.palette.glass.cardShadow}, inset 0 1px 0 rgba(255,255,255,0.18)`,
});

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
