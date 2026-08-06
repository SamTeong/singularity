import { getTokens, getRoles } from '@/theme/contract.js';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import Badge from '@mui/material/Badge';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import AddIcon from '@mui/icons-material/Add';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import ViewKanbanIcon from '@mui/icons-material/ViewKanban';
import ScheduleIcon from '@mui/icons-material/Schedule';
import SpeedIcon from '@mui/icons-material/Speed';
import { Stamp, ZoneTitle } from 'phosphor-console-theme/components';
import Logo from '@/components/Logo.jsx';
import { Meter } from '@/components/Meter.jsx';
import { visibleProviders, usageSummary } from '@/lib/usageUtil.js';
import { useCapabilities } from '@/hooks/useCapabilities.js';
import { useAgents } from '@/providers/AgentsProvider.jsx';
import { useThemeSkin } from '@/theme/index.js';
import { getDomainState } from '@/lib/domainState.js';
import {
  glass,
  PAPER_TOOLTIP_SLOTPROPS,
  brandGrad,
  brandGlow,
  trackColor,
  navActiveBg,
  chipBg,
  surface2,
  stroke2,
  brandOrInk,
  statusColor,
  focusRing,
} from '@/shell/shellStyles.js';

// Vertical nav rail entries (icon + label + bilingual jp/en pair — the jp glyph
// is Phosphor-only chrome, rendered `aria-hidden` so the accessible name stays
// the English label under every skin). The rail is the sidebar's primary
// navigation; the ＋ "New session" row above it opens the create dialog.
const NAV = [
  { v: 'tasks', icon: <ViewKanbanIcon />, label: 'Tasks', jp: '任務' },
  { v: 'cron', icon: <ScheduleIcon />, label: 'Automation', jp: '自動' },
  { v: 'usage', icon: <SpeedIcon />, label: 'Usage', jp: '消費' },
];

const NEW_SESSION_JP = '新規';

// ink-2 / ink-3 from DESIGN.md map to MUI's scheme-switching text palette.
const INK2 = 'text.secondary';
const INK3 = 'text.disabled';
const INK = 'text.primary';

/**
 * Bilingual nav-row label (task 4.1): a large-ish Mincho jp term beside its
 * English caption. The jp glyph is decorative chrome only — `aria-hidden` so
 * the row's accessible name (and e2e `getByRole` lookups) stay the plain
 * English label, matching design.md's "accessible names are English only"
 * rule. Phosphor-only; ZAPAC never renders this (its rows pass the plain
 * `label` string straight to `ListItemText`).
 */
function NavLabel({ jp, en }) {
  return (
    <Box component="span" sx={{ display: 'inline-flex', alignItems: 'baseline', gap: '8px', minWidth: 0 }}>
      <Box component="span" aria-hidden sx={(t) => ({ fontFamily: getTokens(t).fonts.jp, fontWeight: 800, fontSize: 15, lineHeight: 1, letterSpacing: '.08em', flex: 'none' })}>
        {jp}
      </Box>
      <Box component="span" sx={(t) => ({ fontFamily: getTokens(t).fonts.display, fontWeight: 700, fontSize: 11, letterSpacing: '.12em', textTransform: 'uppercase' })}>
        {en}
      </Box>
    </Box>
  );
}

/**
 * App sidebar: the vertical nav rail (New session · Tasks · Automation · Usage),
 * collapsible to an icon rail. Domain state comes from {@link useAgents}; only
 * view/collapse UI state and the menu-open callback are passed in.
 *
 * ZAPAC keeps its own header row (brand mark + "More" icon button) above the
 * rail, unchanged. Phosphor has neither — the peg's sidebar (`docs/one-shot/
 * phosphor-layout-02.html`'s `.side`) has no logo tile at all (the `特異点`/
 * `SINGULARITY` monogram lives only in the masthead) and no header-row "More"
 * control; its `.nav-more` is the last child of `nav.nav` instead. So under
 * Phosphor: no header Stack renders (the connection state it also carried is
 * not lost — `DaemonFooter` below already renders the same live `connected`
 * flag, unconditionally, every render), and the "More" trigger is the final
 * row inside the nav `<List>` (see the `isPhosphor` branch after `NAV.map`).
 */
export default function Sidebar({ collapsed, setCollapsed, view, setView, onNewSession, onOpenMenu, menuOpen }) {
  const { agents, connected, usage, refreshUsage, tasks, crons } = useAgents();
  const caps = useCapabilities();
  const { skinId } = useThemeSkin();
  const isPhosphor = skinId === 'phosphor';
  const usageTip = usageSummary(usage, caps); // per-provider 5h/7d summary for the collapsed tooltip
  const counts = { tasks: tasks.length, cron: crons.length };

  // Phosphor's "More" trigger reads as a hard-edged orange chrome box (mockup's
  // `.nav-more`) instead of a plain circular icon button — same element/props,
  // presentation only. `aria-expanded="true"` (menuOpen) gets the same fill
  // inversion as hover.
  const moreBtnSx = (t) =>
    isPhosphor
      ? {
          borderRadius: getTokens(t).radius.none,
          border: `1px solid ${getRoles(t).chrome.stroke}`,
          color: getRoles(t).chrome.stroke,
          '&:hover': { backgroundColor: getRoles(t).chrome.stroke, color: getRoles(t).shell.surface },
          '&[aria-expanded="true"]': { backgroundColor: getRoles(t).chrome.stroke, color: getRoles(t).shell.surface },
        }
      : {};

  return (
    <Box
      component="aside"
      sx={(t) => {
        const g = glass(t);
        return {
          ...g,
          // layout-02 `.bg-fallback`'s glow-1 (16% 8%), scoped to the rail itself
          // rather than the global AmbientBackground: strongest behind the brand
          // mark / "New session" pill, fading to the flat glass surface by the
          // nav rows below (mock's warm top bloom on `.side`). ZAPAC-only — the
          // purple bloom has no Phosphor mapping, so Phosphor keeps the flat
          // void/orange surface `glass(t)` already resolves to.
          background: isPhosphor ? g.background : `radial-gradient(120% 55% at 20% 8%, ${brandGlow(t)}, transparent 68%), ${g.background}`,
          position: 'relative',
          zIndex: getTokens(t).layers.nav,
          width: collapsed ? 64 : 300, // layout-02 `.side` width
          flexShrink: 0,
          mt: 1.5,
          ml: 1.5,
          // Hard edge under Phosphor (no pill/rounded-full ZAPAC radius).
          borderRadius: isPhosphor ? 0 : `${getTokens(t).radius.lg}px`,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          transition: 'width .2s ease',
          '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
        };
      }}
    >
      {/* Header: logo (+ title when expanded) + more menu (nav overflow, processes,
          dark mode). ZAPAC only — Phosphor's peg sidebar has no logo tile (the
          monogram lives in the masthead) and moves "More" into the nav rail
          below (see the isPhosphor branch after NAV.map). Dropping this cluster
          under Phosphor doesn't lose the connection state the Badge also
          carried — DaemonFooter renders the same live `connected` flag,
          unconditionally, further down this component. */}
      {!isPhosphor && (
        <Stack direction={collapsed ? 'column' : 'row'} spacing={1.5} sx={{ p: '18px', pb: '14px', alignItems: 'center', justifyContent: collapsed ? 'center' : 'flex-start' }}>
          <Tooltip title={connected ? '' : 'disconnected'} placement="bottom" disableInteractive slotProps={PAPER_TOOLTIP_SLOTPROPS}>
            <Badge variant="dot" color="error" overlap="circular" anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }} invisible={connected}>
              {/* layout-02 `.brand-mark`: the identity gradient as a rounded tile
                  with a soft bloom, glyph flattened to white on top of it. */}
              <Box
                sx={(t) => ({
                  width: 36,
                  height: 36,
                  flexShrink: 0,
                  display: 'grid',
                  placeItems: 'center',
                  borderRadius: '10px',
                  background: brandGrad(t),
                  boxShadow: `0 8px 22px -8px ${brandGlow(t)}`,
                })}
              >
                <Logo onBrand active={agents.some((a) => a.status === 'running' || a.status === 'starting')} />
              </Box>
            </Badge>
          </Tooltip>
          {!collapsed && (
            <>
              {/* layout-02 `.brand-name`: font-family: var(--font-display) — h4 is the
                  theme's "brand name / section heading" variant (16px/700/-.01em). */}
              <Typography component="span" variant="h4" sx={{ flex: 1, lineHeight: 1 }}>Singularity</Typography>
              <Tooltip title="More" placement="bottom" disableInteractive slotProps={PAPER_TOOLTIP_SLOTPROPS}>
                <IconButton onClick={onOpenMenu} size="small" aria-label="More" aria-haspopup="menu" aria-expanded={menuOpen} sx={moreBtnSx}><MoreVertIcon /></IconButton>
              </Tooltip>
            </>
          )}
          {collapsed && (
            <Tooltip title="More" placement="right" disableInteractive slotProps={PAPER_TOOLTIP_SLOTPROPS}>
              <IconButton onClick={onOpenMenu} size="small" aria-label="More" aria-haspopup="menu" aria-expanded={menuOpen} sx={moreBtnSx}><MoreVertIcon /></IconButton>
            </Tooltip>
          )}
        </Stack>
      )}

      {/* Vertical nav rail: ＋ New session, then Tasks / Automation / Usage. Icon-only when collapsed. */}
      {/* layout-02 `.nav`: 6px/10px padding, 3px between rows. */}
      <List sx={{ px: '10px', py: '6px' }}>
        {/* Tooltips only when collapsed — expanded rows show their label already. */}
        <Tooltip title={collapsed ? 'New session' : ''} placement="right" disableInteractive slotProps={PAPER_TOOLTIP_SLOTPROPS}>
          <ListItemButton
            onClick={onNewSession}
            sx={(t) => {
              if (isPhosphor) {
                // Layout only — border/text/hover/focus-visible come from the
                // vendored theme's MuiListItemButton override, except the CTA
                // emphasis (thicker mint border + fill-on-hover) added below,
                // matching layout-02's `.newsess` (mint outline that fills on
                // hover — the one row that acts like a primary action, not a
                // toggle, so it doesn't wait for a `.Mui-selected` state).
                const mint = getRoles(t).status.nominal;
                const punchedOut = getRoles(t).shell.surface;
                return {
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px',
                  justifyContent: collapsed ? 'center' : 'flex-start',
                  minHeight: 40,
                  pl: collapsed ? 0 : '14px',
                  pr: collapsed ? 0 : '14px',
                  py: '8px',
                  border: `2px solid ${mint}`,
                  boxShadow: `0 0 8px color-mix(in srgb, ${mint} 20%, transparent)`,
                  '&:hover': {
                    background: mint,
                    color: punchedOut,
                    boxShadow: `0 0 12px color-mix(in srgb, ${mint} 45%, transparent)`,
                  },
                };
              }
              return {
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                justifyContent: collapsed ? 'center' : 'flex-start',
                minHeight: 40,
                borderRadius: `${getTokens(t).radius.sm}px`,
                mb: '5px', // `.nav-new` sits 5px clear of the nav items below it
                pl: collapsed ? 0 : '14px',
                pr: collapsed ? 0 : '14px',
                py: '8px', // `.nav-new` is 42px total; icon (24px) drives content height once ListItemText's own 4px/4px margin is zeroed below
                background: chipBg(t),
                border: `1px solid ${stroke2(t)}`,
                color: INK,
                fontWeight: 700,
                fontSize: 14,
                transition: 'border-color .18s ease, background .18s ease',
                '&:hover': {
                  borderColor: t.vars.palette.primary.main,
                  background: `color-mix(in srgb, ${t.vars.palette.primary.main} 12%, ${chipBg(t)})`,
                },
                '&:focus-visible': focusRing(t),
              };
            }}
          >
            <ListItemIcon sx={(t) => ({ minWidth: collapsed ? 0 : 36, justifyContent: 'center', color: isPhosphor ? 'inherit' : brandOrInk(t) })}><AddIcon /></ListItemIcon>
            {/* my: 0 kills MUI's default ListItemText 4px/4px vertical margin — left in
                place, it stacks with the icon's 24px to blow the row past 42px. */}
            {!collapsed && (
              <ListItemText
                primary={isPhosphor ? <NavLabel jp={NEW_SESSION_JP} en="New session" /> : 'New session'}
                sx={{ my: 0 }}
                slotProps={{ primary: { sx: { fontSize: 14, fontWeight: 700 } } }}
              />
            )}
          </ListItemButton>
        </Tooltip>
        {NAV.map((item) => {
          const isUsage = item.v === 'usage';
          const tooltipLabel = isUsage && usageTip ? usageTip : item.label;
          const count = counts[item.v];
          return (
            <Tooltip key={item.v} title={collapsed ? tooltipLabel : ''} placement="right" disableInteractive slotProps={PAPER_TOOLTIP_SLOTPROPS}>
              <ListItemButton
                selected={view === item.v}
                onClick={() => {
                  if (view === item.v) { setCollapsed((c) => !c); return; }
                  setView(item.v);
                  if (isUsage) refreshUsage(true);
                }}
                sx={(t) => {
                  if (isPhosphor) {
                    // Layout only — idle/hover/selected border+fill, the
                    // figure-ground inversion, and the focus-visible outline
                    // all come from the vendored theme's MuiListItemButton
                    // override (dim-green idle border · mint hover outline ·
                    // mint fill + void content when selected · amber dashed
                    // focus ring). No ZAPAC gradient bar, no chip-tint hover.
                    return {
                      display: 'flex',
                      alignItems: 'center',
                      gap: '13px',
                      justifyContent: collapsed ? 'center' : 'flex-start',
                      minHeight: 40,
                      pl: collapsed ? 0 : '14px',
                      pr: collapsed ? 0 : '14px',
                      py: '8px',
                      position: 'relative',
                      // Hovering the CURRENT row must not dissolve its
                      // inversion. MUI's built-in hover overlay outranks the
                      // vendored `&.Mui-selected:hover` rule and replaces the
                      // solid mint fill with a ~7%-alpha tint, so the active
                      // item visually stops being active exactly while the
                      // pointer is on it. Restated from `sx` (applied last, so
                      // it wins) using the theme's own peak hue.
                      '&.Mui-selected:hover': { background: t.nerv.hue.mintHi },
                    };
                  }
                  return {
                    display: 'flex',
                    alignItems: 'center',
                    gap: '13px',
                    justifyContent: collapsed ? 'center' : 'flex-start',
                    minHeight: 40,
                    borderRadius: `${getTokens(t).radius.sm}px`,
                    mb: '3px', // `.nav` row gap
                    pl: collapsed ? 0 : '14px',
                    pr: collapsed ? 0 : '14px',
                    py: '8px', // `.nav-item` is 40px total; icon (24px) drives content height once ListItemText's own 4px/4px margin is zeroed below
                    position: 'relative',
                    color: INK2,
                    fontWeight: 400,
                    fontSize: 14,
                    transition: 'background .18s ease, color .18s ease',
                    '&:hover': { background: surface2(t), color: INK },
                    '&.Mui-selected': {
                      background: navActiveBg(t),
                      color: INK,
                      fontWeight: 700,
                      boxShadow: getTokens(t).glass.cardShadow,
                      '&:hover': { background: navActiveBg(t) },
                    },
                    // 4px gradient left-edge marker — the ONE sanctioned active indicator (DESIGN §6).
                    // `transform: 'none'` cancels the vendored theme's own
                    // `.Mui-selected::before` rule (top:50%/translateY(-50%), for
                    // its own top:50%-based centering scheme) — left uncancelled,
                    // that leftover translateY(-50%) stacks with our top/bottom
                    // offsets and drags the whole bar up out of the row, leaving
                    // only a sliver clipped against the top edge.
                    '&.Mui-selected::before': {
                      content: '""',
                      position: 'absolute',
                      left: 0,
                      top: '9px',
                      bottom: '9px',
                      width: '4px',
                      borderRadius: '0 4px 4px 0',
                      background: brandGrad(t),
                      transform: 'none',
                    },
                    '&:focus-visible': focusRing(t),
                  };
                }}
              >
                {/* Icon slot: ZAPAC keeps its MUI icon in both states. Phosphor has
                    none — the kanji IS the icon (peg nav buttons are jp+en+count,
                    no icon glyph) — so it only fills this slot when collapsed
                    (the sole remaining visible content); when expanded the jp
                    already renders paired with its caption inside NavLabel below,
                    so rendering it twice would be redundant. */}
                {isPhosphor ? (
                  collapsed && (
                    <ListItemIcon sx={{ minWidth: 0, justifyContent: 'center', color: 'inherit' }}>
                      <Box aria-hidden sx={(t) => ({ fontFamily: getTokens(t).fonts.jp, fontWeight: 800, fontSize: 17, lineHeight: 1 })}>{item.jp}</Box>
                    </ListItemIcon>
                  )
                ) : (
                  <ListItemIcon sx={{ minWidth: collapsed ? 0 : 36, justifyContent: 'center', color: 'inherit', opacity: 0.85 }}>{item.icon}</ListItemIcon>
                )}
                {/* my: 0 — see "New session" row above for why this matters. */}
                {!collapsed && (
                  <ListItemText
                    primary={isPhosphor ? <NavLabel jp={item.jp} en={item.label} /> : item.label}
                    sx={{ my: 0 }}
                    slotProps={{ primary: { sx: { fontSize: 14, fontWeight: 'inherit' } } }}
                  />
                )}
                {!collapsed && count != null && (
                  isPhosphor ? (
                    <Stamp
                      size="sm"
                      tone="mint"
                      sx={{ ml: 'auto', border: '1px solid currentColor', color: 'inherit', background: 'transparent' }}
                    >
                      {count}
                    </Stamp>
                  ) : (
                    <Typography
                      component="span"
                      sx={(t) => ({
                        ml: 'auto',
                        fontSize: 11,
                        fontWeight: 700,
                        letterSpacing: '.02em',
                        color: INK3,
                        background: chipBg(t),
                        px: '9px',
                        py: '2px',
                        borderRadius: `${getTokens(t).radius.pill ?? 999}px`,
                        '.Mui-selected &': { color: brandOrInk(t) },
                      })}
                    >
                      {count}
                    </Typography>
                  )
                )}
              </ListItemButton>
            </Tooltip>
          );
        })}
        {/* Phosphor's "More" trigger: layout-02's `.nav-more` is the final child
            of `nav.nav`, not a header-row icon button (see the file-header note
            and the `!isPhosphor` header Stack above). Same handler/behaviour as
            ZAPAC's header IconButton — only the position and presentation move.
            `aria-label` pins the accessible name to exactly "More" (the e2e
            suite's `getByRole('button', { name: 'More', exact: true })`) even
            though the visible caption reads "MORE" (this theme's chrome is
            never lowercase). */}
        {isPhosphor && (
          <Tooltip title={collapsed ? 'More' : ''} placement="right" disableInteractive slotProps={PAPER_TOOLTIP_SLOTPROPS}>
            <ListItemButton
              onClick={onOpenMenu}
              aria-label="More"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              sx={(t) => ({
                ...moreBtnSx(t),
                display: 'flex',
                alignItems: 'center',
                gap: '13px',
                justifyContent: collapsed ? 'center' : 'flex-start',
                minHeight: 40,
                pl: collapsed ? 0 : '14px',
                pr: collapsed ? 0 : '14px',
                py: '8px',
                mt: '3px',
              })}
            >
              <ListItemIcon sx={{ minWidth: collapsed ? 0 : 36, justifyContent: 'center', color: 'inherit' }}>
                <Box aria-hidden sx={(t) => ({ fontFamily: getTokens(t).fonts.mono, fontSize: 15, letterSpacing: '.2em' })}>···</Box>
              </ListItemIcon>
              {!collapsed && (
                <ListItemText
                  primary={<Box aria-hidden sx={(t) => ({ fontFamily: getTokens(t).fonts.display, fontWeight: 700, fontSize: 11, letterSpacing: '.12em' })}>MORE</Box>}
                  sx={{ my: 0 }}
                />
              )}
            </ListItemButton>
          </Tooltip>
        )}
      </List>

      <Box sx={{ flex: 1 }} />

      {/* "Usage · 5h window" mini-bar panel — only in the expanded rail. */}
      {!collapsed && <UsagePanel usage={usage} caps={caps} />}

      {/* Daemon-status footer — always visible (replaces the conditional StatusPill). */}
      <DaemonFooter connected={connected} />
    </Box>
  );
}

/**
 * Sidebar usage panel (layout-02 `.usage`): a recessed glass tile with a labelled
 * mini-bar + percentage per provider, wired to the live `useAgents.usage` shape.
 * Renders a muted placeholder row when no data has loaded yet.
 *
 * Phosphor renders the same rows (task 4.3, revised 8.6) through `@/components/
 * Meter.jsx` — the same themed bar the Usage view's main pane uses (`size="lg"`
 * there, `size="sm"` here) — instead of a bespoke bar, so both surfaces share
 * one implementation. Real percentages/placeholders only, no fabricated
 * provider or telemetry.
 */
function UsagePanel({ usage, caps }) {
  const { skinId } = useThemeSkin();
  const isPhosphor = skinId === 'phosphor';
  const rows = visibleProviders(caps).map((p) => {
    const u = usage?.[p.key];
    const win = u?.ok ? u.session : null; // the same "5h session" window shape Meter/UsageView already consume
    const pct = win?.pctUsed != null ? Math.round(win.pctUsed) : null;
    return { key: p.key, label: p.label, pct, win };
  });
  const hasData = rows.some((r) => r.pct != null);

  if (isPhosphor) {
    return (
      <Box sx={{ mx: 1.5, mb: 1.5 }}>
        <ZoneTitle aside="5H WINDOW">
          <Box component="span">USAGE</Box>
          <Box component="span" aria-hidden sx={(t) => ({ fontFamily: getTokens(t).fonts.jp, ml: '8px' })}>消費</Box>
        </ZoneTitle>
        {!hasData ? (
          <Typography sx={(t) => ({ fontSize: 11, fontFamily: getTokens(t).fonts.mono, textTransform: 'uppercase', color: getRoles(t).status.idle })}>No usage yet</Typography>
        ) : (
          // Same themed `Meter` the Usage view's main pane renders (size="lg"),
          // at its documented compact size — one bar component, two surfaces.
          // `win`/`segments`/`windowMs` mirror UsageView.jsx's own "Session (5h)"
          // Meter exactly, so both readings of the same 5h window match.
          <Stack spacing="9px">
            {rows.map((r) => (
              <Meter key={r.key} size="sm" label={r.label.toUpperCase()} win={r.win} segments={5} windowMs={5 * 3.6e6} />
            ))}
          </Stack>
        )}
      </Box>
    );
  }

  return (
    <Box
      sx={(t) => ({
        mx: 1.5,
        mb: 1.5,
        p: '14px',
        borderRadius: `${getTokens(t).radius.md}px`,
        background: surface2(t),
        border: `1px solid ${stroke2(t)}`,
      })}
    >
      <Typography sx={{ fontSize: 11, fontWeight: 700, letterSpacing: '.14em', textTransform: 'uppercase', color: INK3, mb: '11px' }}>
        Usage · 5h window
      </Typography>
      {!hasData ? (
        <Typography sx={{ fontSize: 12, color: INK3 }}>No usage yet</Typography>
      ) : (
        <Stack spacing="10px">
          {rows.map((r) => (
            <Stack key={r.key} direction="row" spacing="10px" sx={{ alignItems: 'center' }}>
              <Typography sx={{ fontSize: 12, color: INK2, width: '52px', flex: 'none' }}>{r.label}</Typography>
              <Box
                sx={(t) => ({
                  flex: 1,
                  height: '6px',
                  borderRadius: `${getTokens(t).radius.pill ?? 999}px`,
                  background: trackColor(t),
                  overflow: 'hidden',
                })}
              >
                <Box
                  sx={(t) => ({
                    display: 'block',
                    height: '100%',
                    width: `${r.pct ?? 0}%`,
                    borderRadius: `${getTokens(t).radius.pill ?? 999}px`,
                    background: brandGrad(t),
                  })}
                />
              </Box>
              <Typography sx={{ fontSize: 11, fontWeight: 700, color: INK3, width: '34px', textAlign: 'right', flex: 'none' }}>
                {r.pct == null ? '—' : `${r.pct}%`}
              </Typography>
            </Stack>
          ))}
        </Stack>
      )}
    </Box>
  );
}

/**
 * Daemon-status footer (layout-02 `.side-foot`): a connection dot + label + the
 * loopback address the client reaches the daemon/WS through (`location.host`).
 * Always visible — reflects the live `useAgents.connected` state.
 *
 * Phosphor renders the same live `connected` boolean as a domain-state-driven
 * `Stamp` (task 4.4) — `running`/`failed` from the shared `lib/domainState.js`
 * mapping, so a lost connection gets the red critical/filled inversion — with
 * the connection state spelled out in visible English text (never color-only).
 */
function DaemonFooter({ connected }) {
  const { skinId } = useThemeSkin();
  const isPhosphor = skinId === 'phosphor';
  const host = typeof location !== 'undefined' ? location.host : '127.0.0.1:4317';

  if (isPhosphor) {
    const { tone, filled } = getDomainState(connected ? 'running' : 'failed');
    return (
      <Box
        component="footer"
        sx={(t) => ({
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          pt: '13px',
          pb: '13px',
          px: '18px',
          borderTop: `1px solid ${getRoles(t).chrome.stroke}`,
        })}
      >
        <Stack direction="row" spacing="7px" sx={{ alignItems: 'center' }}>
          {/* Decorative bilingual pairing (layout-02 `接続 CONNECTED`) — aria-hidden
              so the Stamp's own English text remains the sole accessible name. */}
          <Box component="span" aria-hidden sx={(t) => ({ fontFamily: getTokens(t).fonts.jp, fontSize: 13, color: getRoles(t).status[tone === 'red' ? 'critical' : 'nominal'] })}>
            {connected ? '接続' : '切断'}
          </Box>
          <Stamp tone={tone} filled={filled} size="sm">
            {connected ? 'DAEMON CONNECTED' : 'DAEMON DISCONNECTED'}
          </Stamp>
        </Stack>
        <Typography component="small" sx={(t) => ({ fontFamily: getTokens(t).fonts.mono, fontSize: 10, letterSpacing: '.08em', color: getRoles(t).status.caution })}>
          {host}
        </Typography>
      </Box>
    );
  }

  return (
    <Box
      component="footer"
      sx={(t) => ({
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        pt: '13px',
        pb: '13px',
        px: '18px',
        borderTop: `1px solid ${stroke2(t)}`,
      })}
    >
      <Box
        aria-hidden
        sx={(t) => {
          const kind = connected ? 'ok' : 'danger';
          const c = statusColor(t, kind);
          return {
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            background: c,
            flex: 'none',
            boxShadow: `0 0 0 3px color-mix(in srgb, ${c} 22%, transparent)`,
          };
        }}
      />
      <Box sx={{ lineHeight: 1.25 }}>
        <Typography component="div" sx={{ fontSize: 12, fontWeight: 700, color: INK2, lineHeight: 1.25 }}>
          {connected ? 'Daemon connected' : 'Daemon disconnected'}
        </Typography>
        <Typography component="small" variant="code" sx={{ display: 'block', fontSize: 11, fontWeight: 400, color: INK3, lineHeight: 1.25 }}>
          {host}
        </Typography>
      </Box>
    </Box>
  );
}
