/**
 * PhosphorMasthead — the Phosphor-only command-console masthead (task 3.2,
 * revised 8.6 per manual visual review against the peg).
 *
 * Mounted once by `AppShell.jsx`, above its existing (unmodified) interaction
 * tree, only when the active skin is Phosphor. Mirrors the structure of
 * `docs/one-shot/phosphor-layout-02.html`'s `.head` (monogram · title/eyebrow
 * · connection stamp · clock/date), but every value is real application
 * state — no fabricated telemetry:
 *
 *   - Product identity: the `特異点`/`SINGULARITY` monogram + "FLEET CONTROL
 *     PLANE" title are static copy describing what this app is (`CLAUDE.md`'s
 *     own description), not a live reading.
 *   - Connection: `connected` — the same `useAgents().connected` flag
 *     `Sidebar.jsx`'s `DaemonFooter` already renders, passed down from
 *     `AppShell` rather than re-subscribed here.
 *   - Loopback address: `location.host` — the same value `DaemonFooter`
 *     reads, computed locally since it's a pure environment read, not state.
 *     Rendered inside the connection `Stamp` (task 8.6) so status + address
 *     read as one unit, matching the peg's single boxed readout.
 *   - Local time: the vendored `SevenSegClock` (`variant="countdown"`, the
 *     glowing orange readout — the peg's `.timechip`), self-driven off the
 *     real wall-clock `Date`, not a controlled/fake value; a plain local date
 *     alongside it (peg's `.dateline`), refreshed every 30s from `Date` — a
 *     real value, not decorative motion, so it is not gated behind
 *     `prefers-reduced-motion` (that governs animation, not this periodic
 *     content refresh).
 *
 * What is deliberately OMITTED (no real source): a fabricated "SYS:NOMINAL"
 * aggregate health score, the one-shot's health-column bar chart, its demo
 * `CODE:`/`FILE:`/`EX_MODE:`/`PRIORITY:` metadata block, an agent-count stat
 * (no `AGENTS n/n` readout — removed per task 8.6; `Sidebar`'s nav already
 * carries live task/cron counts), and the one-shot's `統制卓`/`COMMAND CONSOLE`
 * eyebrow label (removed whole, per task 8.6, rather than orphaning half a
 * bilingual pair — see the eyebrow tagline comment below). None of the
 * removed metadata had a real application-state source, so per the brief it
 * stays out rather than being invented. The connection `Stamp` is the one
 * health signal this app actually has, and it is derived, not invented.
 *
 * Every large Mincho label is paired with an adjacent English caption
 * (`Monogram`'s own built-in caption); small mono captions (the date) are
 * plain English, matching the rest of the system's chrome.
 *
 * Responsive collapse (task 3.4, revised 8.6) — secondary content drops
 * before identity:
 *   - >1080px (desktop): everything.
 *   - <=1080px (intermediate — matches the one-shot's own documented
 *     structural-collapse threshold): drop the address inside the connection
 *     stamp (secondary, and already duplicated in `Sidebar`'s `DaemonFooter`)
 *     — the stamp's own status text always remains.
 *   - <=820px (narrow — the one-shot's second documented threshold, and
 *     design.md's open-question default): drop the eyebrow tagline and the
 *     date line; identity (monogram + H1) and the connection stamp — the one
 *     primary safety-relevant readout — always remain.
 *   - <=560px height (short viewports, e.g. a laptop with the browser chrome
 *     eating vertical space): shrink vertical padding and drop the eyebrow/
 *     date regardless of width, so the masthead cannot grow tall enough to
 *     crowd out the sidebar/dock beneath it.
 *   `flexWrap: 'wrap'` plus `minWidth: 0`/text-overflow on the title is the
 *   layout-level backstop against horizontal overflow at any width in between.
 */
import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import { Monogram, Stamp, SevenSegClock } from 'phosphor-console-theme/components';
import { getRoles } from '@/theme/contract.js';

const NARROW = '@media (max-width:1080px)'; // one-shot's first structural-collapse breakpoint
const COMPACT = '@media (max-width:820px)'; // one-shot's second — design.md's open-question default
const SHORT = '@media (max-height:560px)'; // short-viewport safeguard (this batch's own choice)

// Peg JS (docs/one-shot/phosphor-layout-02.html ~line 995): `MONTHS[d.getMonth()]
// + " " + pad2(d.getDate()) + " " + d.getFullYear()` — e.g. "AUG 06 2026". Not
// `toLocaleDateString`, which would localize the month abbreviation.
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
function formatDate(d) {
  return `${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2, '0')} ${d.getFullYear()}`;
}

/** Local calendar date, refreshed periodically — a real value, not an animation. */
function useLocalDateLabel() {
  const [label, setLabel] = useState(() => formatDate(new Date()));
  useEffect(() => {
    const id = setInterval(() => setLabel(formatDate(new Date())), 30_000);
    return () => clearInterval(id);
  }, []);
  return label;
}

/**
 * @param {Object} props
 * @param {boolean} props.connected live daemon/WS connection state (`useAgents().connected`)
 */
export default function PhosphorMasthead({ connected }) {
  const host = typeof location !== 'undefined' ? location.host : '127.0.0.1:4317';
  const dateLabel = useLocalDateLabel();

  return (
    <Box
      component="header"
      sx={(t) => ({
        flex: 'none',
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 2,
        rowGap: 1,
        px: 2.5,
        py: 1.25,
        borderBottom: `1px solid ${getRoles(t).chrome.stroke}`,
        position: 'relative',
        [SHORT]: { py: 0.5 },
      })}
    >
      <Monogram jp="特異点" label="SINGULARITY" tone="orange" size={22} />

      <Box sx={{ minWidth: 0, flex: '1 1 auto' }}>
        <Box
          component="h1"
          sx={(t) => ({
            m: 0,
            fontFamily: t.nerv.fonts.display,
            fontWeight: 700,
            fontSize: 22,
            lineHeight: 1,
            color: t.nerv.hue.paper,
            letterSpacing: '0.02em',
            textShadow: `0 0 4px currentColor, 0 0 12px color-mix(in srgb, ${t.nerv.hue.mint} 30%, transparent)`,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          })}
        >
          FLEET CONTROL PLANE
        </Box>
        {/* Eyebrow tagline — plain English caption only (task 8.6 removed the
            one-shot's `統制卓`/`COMMAND CONSOLE` bilingual pair whole, per the
            user's visual review, rather than orphaning half of it — see the
            module doc comment). */}
        <Box
          component="span"
          sx={(t) => ({
            display: 'block',
            mt: '4px',
            overflow: 'hidden',
            fontSize: 10,
            letterSpacing: '0.16em',
            color: t.nerv.hue.amber,
            whiteSpace: 'nowrap',
            fontFamily: t.nerv.fonts.mono,
            [COMPACT]: { display: 'none' },
            [SHORT]: { display: 'none' },
          })}
        >
          LOOPBACK DAEMON · SPEC-DRIVEN ORCHESTRATION
        </Box>
      </Box>

      {/* Secondary cluster — collapses progressively; see the module doc
          comment for the exact breakpoint/field mapping. */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2.5, flex: 'none' }}>
        {/* Connection stamp — the one primary safety-relevant readout, so it
            never collapses. The loopback address (task 8.6) renders INSIDE
            it, dimmer, so status + address read as one boxed unit rather than
            two separate elements; only the address sub-span drops at the
            narrow breakpoint (it's secondary, and already duplicated in
            `Sidebar`'s `DaemonFooter`). The connected/disconnected state is
            always spelled out in visible English text, never colour-only. */}
        <Stamp tone={connected ? 'mint' : 'red'} filled={!connected} glow={connected}>
          {connected ? 'DAEMON:CONNECTED' : 'DAEMON:LOST'}
          <Box component="span" sx={{ opacity: 0.72, ml: '8px', [NARROW]: { display: 'none' } }}>{host}</Box>
        </Stamp>

        <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '3px' }}>
          {/* The peg's `.timechip`: a glowing seven-segment orange readout
              (task 8.6 — replaces the plain-digit `DigitalClock`, which was
              the wrong component entirely). Rendered at the vendored
              `countdown` variant's native 20x30 digits, which is already
              marginally larger than the peg's own 19x27 `makeDigit(19,27)`
              and several times the 16px text clock it replaces — so no
              scaling is applied. A `transform: scale()` here would also be
              actively wrong: it doesn't reserve layout space, so the enlarged
              readout would overhang the masthead band and the stamp to its
              left at narrow widths. `role="img"`/`aria-label` restores the
              text alternative `SevenSegClock` doesn't carry on its own
              (mirrors the peg's own `role="img" aria-label="Local time"`). */}
          <Box role="img" aria-label="Local time">
            <SevenSegClock variant="countdown" />
          </Box>
          <Box
            component="span"
            sx={(t) => ({ fontSize: 10, color: t.nerv.hue.amber, letterSpacing: '0.14em', fontFamily: t.nerv.fonts.mono, [COMPACT]: { display: 'none' }, [SHORT]: { display: 'none' } })}
          >
            {dateLabel}
          </Box>
        </Box>
      </Box>
    </Box>
  );
}
