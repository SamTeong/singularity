/**
 * PhosphorMasthead — the Phosphor-only command-console masthead (task 3.2).
 *
 * Mounted once by `AppShell.jsx`, above its existing (unmodified) interaction
 * tree, only when the active skin is Phosphor. Mirrors the structure of
 * `docs/one-shot/phosphor-layout-02.html`'s `.head` (monogram · title/eyebrow
 * · secondary metadata · connection stamp · agent load · clock), but every
 * value is real application state — no fabricated telemetry:
 *
 *   - Product identity: the `特異点`/`SINGULARITY` monogram + "FLEET CONTROL
 *     PLANE" title/eyebrow are static copy describing what this app is
 *     (`CLAUDE.md`'s own description), not a live reading.
 *   - Connection: `connected` — the same `useAgents().connected` flag
 *     `Sidebar.jsx`'s `DaemonFooter` already renders, passed down from
 *     `AppShell` rather than re-subscribed here.
 *   - Agent/load: `liveCount`/`agentCount` — `AppShell`'s own existing
 *     `agents.filter(isLive).length` / `agents.length`, passed down (not
 *     recomputed here) so there is exactly one definition of "live".
 *   - Loopback address: `location.host` — the same value `DaemonFooter`
 *     reads, computed locally since it's a pure environment read, not state.
 *   - Local time: the vendored `DigitalClock` (self-driven, real wall-clock
 *     `Date`, not a controlled/fake value); a plain local date alongside it,
 *     refreshed every 30s from `Date` — a real value, not decorative motion,
 *     so it is not gated behind `prefers-reduced-motion` (that governs
 *     animation, not this periodic content refresh).
 *
 * What is deliberately OMITTED (no real source): a fabricated "SYS:NOMINAL"
 * aggregate health score, the one-shot's health-column bar chart, and its
 * demo `CODE:`/`FILE:`/`EX_MODE:`/`PRIORITY:` metadata block — none of those
 * have a real application-state source, so per the brief they are left out
 * rather than invented. The connection `Stamp` below is the one health
 * signal this app actually has, and it is derived, not invented.
 *
 * Every large Mincho label is paired with an adjacent English caption
 * (`BilingualLabel`/`Monogram`'s own built-in caption); small mono captions
 * (`ADDR`, `AGENTS`, the date) are plain English, matching the rest of the
 * system's chrome (see `phosphor-console-theme`'s `Stat`/`MetadataBlock`,
 * neither of which pairs their small captions with Japanese either).
 *
 * Responsive collapse (task 3.4) — secondary metadata drops before identity;
 * a bilingual pair is always hidden or shown as one unit, never split:
 *   - >1080px (desktop): everything.
 *   - <=1080px (intermediate — matches the one-shot's own documented
 *     structural-collapse threshold): drop the ADDR metadata block first
 *     (secondary, and already duplicated in `Sidebar`'s `DaemonFooter`).
 *   - <=820px (narrow — the one-shot's second documented threshold, and
 *     design.md's open-question default): drop the whole eyebrow tagline
 *     (its bilingual `統制卓`/`COMMAND CONSOLE` pair collapses together, never
 *     orphaned) and the AGENTS stat and date line; identity (monogram + H1)
 *     and the connection stamp — the one primary safety-relevant readout —
 *     always remain.
 *   - <=560px height (short viewports, e.g. a laptop with the browser chrome
 *     eating vertical space): shrink vertical padding and drop the eyebrow/
 *     date/AGENTS stat regardless of width, so the masthead cannot grow tall
 *     enough to crowd out the sidebar/dock beneath it.
 *   `flexWrap: 'wrap'` plus `minWidth: 0`/text-overflow on the title is the
 *   layout-level backstop against horizontal overflow at any width in between.
 */
import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Stack from '@mui/material/Stack';
import { Monogram, BilingualLabel, MetadataBlock, Stamp, Stat, DigitalClock } from 'phosphor-console-theme/components';
import { getRoles } from '@/theme/contract.js';

const NARROW = '@media (max-width:1080px)'; // one-shot's first structural-collapse breakpoint
const COMPACT = '@media (max-width:820px)'; // one-shot's second — design.md's open-question default
const SHORT = '@media (max-height:560px)'; // short-viewport safeguard (this batch's own choice)

function formatDate(d) {
  return d.toLocaleDateString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' }).toUpperCase();
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
 * @param {number} props.liveCount running/idle/starting agent count (`AppShell`'s own `liveCount`)
 * @param {number} props.agentCount total tracked agent count (`agents.length`)
 */
export default function PhosphorMasthead({ connected, liveCount, agentCount }) {
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
        {/* Eyebrow tagline — a genuine bilingual pair (統制卓/COMMAND CONSOLE),
            so it collapses as one unit at the narrow breakpoint rather than
            dropping only one half of it. */}
        <Stack
          direction="row"
          alignItems="baseline"
          spacing={1}
          sx={{
            mt: '4px',
            overflow: 'hidden',
            [COMPACT]: { display: 'none' },
            [SHORT]: { display: 'none' },
          }}
        >
          <Box
            component="span"
            sx={(t) => ({ fontSize: 10, letterSpacing: '0.16em', color: t.nerv.hue.amber, whiteSpace: 'nowrap', fontFamily: t.nerv.fonts.mono })}
          >
            LOOPBACK DAEMON · SPEC-DRIVEN ORCHESTRATION
          </Box>
          <BilingualLabel jp="統制卓" en="COMMAND CONSOLE" size={13} tone="amber" captionTone="amber" />
        </Stack>
      </Box>

      {/* Secondary metadata cluster — collapses progressively; see the
          module doc comment for the exact breakpoint/field mapping. */}
      <Stack direction="row" alignItems="center" spacing={2.5} sx={{ flex: 'none' }}>
        <Box sx={{ [NARROW]: { display: 'none' } }}>
          <MetadataBlock entries={[['ADDR', host]]} />
        </Box>

        <Stamp tone={connected ? 'mint' : 'red'} filled={!connected} glow={connected}>
          {connected ? 'DAEMON:CONNECTED' : 'DAEMON:LOST'}
        </Stamp>

        <Box sx={{ [COMPACT]: { display: 'none' }, [SHORT]: { display: 'none' } }}>
          <Stat label="AGENTS" value={`${liveCount}/${agentCount}`} tone={liveCount > 0 ? 'mint' : 'paper'} />
        </Box>

        <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '3px' }}>
          <DigitalClock tone="orange" size={16} />
          <Box
            component="span"
            sx={(t) => ({ fontSize: 9, color: t.nerv.hue.amber, letterSpacing: '0.12em', fontFamily: t.nerv.fonts.mono, [COMPACT]: { display: 'none' }, [SHORT]: { display: 'none' } })}
          >
            {dateLabel}
          </Box>
        </Box>
      </Stack>
    </Box>
  );
}
