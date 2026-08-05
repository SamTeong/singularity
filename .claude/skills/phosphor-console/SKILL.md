---
name: phosphor-console
description: >-
  How to build UI with the Phosphor Console — the NERV/MAGI tactical Material UI
  (v7) theme in `theme/` plus the ~60 custom console components in `components/`
  (imported via `@theme` and `@components`). A black CRT command deck where color
  IS state (mint nominal · orange chrome · blue pending · amber caution · red
  critical), active = figure/ground inversion, depth = border + glow + hue (no
  elevation), motion is mechanical, and type is bimodal + bilingual (kanji +
  caption). Use this skill whenever building or editing ANY UI in this repo — a
  dashboard, form, wiki, landing page, console screen, or a single stamp, meter,
  gauge, terminal, or button — or whenever the user mentions the theme, the
  Phosphor Console, NERV/MAGI/Evangelion styling, `theme.nerv.*`, `@components`,
  any house component (Stamp, ConsoleFrame, GaugeCard, LogConsole, RoutineRow,
  AgenticLoop, YesNoGate, SegmentedMeter…), the design system / `/` gallery, or
  the DESIGN.md rules. Reach for it even when the user just says "add a
  form / dashboard card / status chip / meter / terminal / alert / landing
  section" without naming the theme — in this repo, that means this system.
---

# Building UI with the Phosphor Console

The Phosphor Console is a two-part system: a **Material UI v7 theme** in
[`theme/`](../../../theme) (imported as `@theme`) that dresses the entire MUI
surface in the NERV/MAGI tactical identity, and a **library of ~60 house
components** in [`components/`](../../../components) (imported as `@components`)
for the console-specific pieces MUI has no primitive for — boxed bilingual
stamps, segmented meters, the diagnostic terminal, the command frame. It is
**dark-only** by definition: a black CRT command deck, not a themeable light/dark
pair.

**Before building, prefer what already exists.** Stock MUI components are already
themed (§Stock MUI just works). A house component probably already covers your
need (§Component catalog / [`references/components.md`](references/components.md)).
Reimplementing one inline with `sx` is drift. The living reference for every
component is the **design-system gallery** at the app's `/` route
([`app/src/pages/DesignSystemPage.tsx`](../../../app/src/pages/DesignSystemPage.tsx))
and the reference screens at `/dashboard-0{1,2,3}` and `/landing-0{1,2}` — read
their source when you need a working usage example. The authority on the visual
grammar is [`DESIGN.md`](../../../DESIGN.md); the non-negotiable rules are in
[`CLAUDE.md`](../../../CLAUDE.md).

## Setup

Wrap the app once. Everything below inherits the theme; no per-component config.

```tsx
import { ThemeProvider, CssBaseline } from '@mui/material';
import { theme } from '@theme';

export default function App() {
  return (
    <ThemeProvider theme={theme} defaultMode="dark">
      <CssBaseline /> {/* required — see below */}
      <YourApp />
    </ThemeProvider>
  );
}
```

`CssBaseline` is **required, not optional**: it installs the CRT scanline +
vignette overlay (on `body::before`), the `nervBlink` / `nervBtnBlink` keyframes
the component overrides depend on, and the global `prefers-reduced-motion` guard.
Drop it and blinks/stamps break and every screen loses its CRT pass. `defaultMode`
is `"dark"` because there is no other mode. `cssVariables` is on, so every custom
token is emitted as a `--mui-*` variable reachable via `theme.vars.*`.

## The eight rules that keep it on-brand

These are load-bearing. Break them and the UI stops reading as the system even
when every value is "close." They restate [`CLAUDE.md`](../../../CLAUDE.md)'s
non-negotiables — that file wins on any conflict.

1. **Black is the only surface.** `#0A0A0A` (`theme.nerv.hue.void`). No elevation
   grays, no drop shadows, no glass. Depth is built from three flat materials
   only: **border, glow, and hue.** A "raised" panel is a stroked box with a
   faint inset glow, never a lifted card.
2. **Color is state, not brand.** mint = nominal/primary/success · orange =
   **chrome only** (borders, rules, dividers, axes, metadata keys — never a data
   value) · blue = pending · amber = caution · red = critical. The same component
   renders every colorway to mean a different state without moving a pixel.
3. **Filled means active** (figure/ground inversion). Idle = outline on black;
   active/selected = a solid hue fill with **black (`#0A0A0A`) content punched
   out**, and **no glow on that content** — the fill carries the light.
4. **Everything important is boxed** (a `Stamp`). Blinking = in-progress; solid
   fill = recorded/active. Never hand-roll a bordered `<span>` for a status/id/tag.
5. **Bimodal, bilingual type.** One giant element per screen (kanji / numeral /
   heading) plus tiny captions — nothing mid-sized. A large Mincho kanji always
   carries a small Latin caption (`内部` / INTERNAL). Display = condensed ALL
   CAPS; data = monospace; JP = Mincho. UI chrome is never lowercase.
6. **Mechanical motion only.** `steps()` / `setInterval` / linear — never eased,
   spring, or bounce. Every animation ships a `prefers-reduced-motion` path that
   renders the final settled state; library components handle this for you via
   `useReducedMotion`, so gate any *new* interval you write behind it too.
7. **CRT pass on every dark screen.** Inherited from `CssBaseline` — don't remove
   it, don't re-add a second one.
8. **Number a sequence only when it *is* one** (form sections, the OODA loop, a
   pipeline) — order has to carry real information. Numbered eyebrows on every
   section are AI grammar, banned here.

## Stock MUI just works

Import stock MUI components normally — they resolve to the tactical identity with
no extra styling. Reach for `sx` to lay them out, not to restyle them. If you're
about to heavily `sx`-override one, a house component probably already does it
(reach for `Stamp` over a restyled `Chip`, `LogConsole` over a hand-built log).

`Button` carries custom variants beyond `contained` (mint outline → mint fill on
hover, the default): `ghost` (dim secondary), `alt` (orange chrome-level action),
`stamp` (boxed status-stamp button). Add `className="nerv-live"` to make any
button blink as the live selected action. `Paper` has `variant="chamfer"` and
`variant="frame"`; `Chip` has `variant="stamp"`; `Typography` has `jp`,
`terminal`, `stamp`, and `data` variants.

## Design tokens — never hardcode

**Prefer tokens over literals.** A raw `#52F29A` or `borderRadius: 4` is drift.
Everything traces to [`theme/tokens.ts`](../../../theme/tokens.ts), reachable two
ways:

**`theme.nerv.*`** (structural tokens, in `sx` callbacks) — the everyday path:

```tsx
sx={(t) => ({
  color: t.nerv.hue.mint,                 // hue.{void,mint,mintHi,greenMap,greenDim,
                                          //   paper,orange,amber,amberDim,red,redHi,crimson,teal,blue}
  fontFamily: t.nerv.fonts.mono,          // fonts.{display, mono, jp}
  borderRadius: `${t.nerv.radius.chip}px`,// radius.{none:0, chip:2, seg:4}
  clipPath: t.nerv.chamfer(28),           // chamfered corners for hero panels/frames
  animation: `nervBlink ${t.nerv.motion.durations.blink}ms ${t.nerv.motion.snap} infinite`,
})}
```

**`theme.vars.palette.nerv.*`** — the same palette hues as live CSS variables,
for when you need a `--mui-*` var (e.g. in a `styled` template or plain CSS).

In **library components**, take a semantic `tone` (`'mint' | 'green' | 'amber' |
'blue' | 'red' | 'orange' | 'paper' | 'dim' | 'teal'`) rather than a raw hex, and
resolve it with `toneHue(theme, tone)` (exported from `@components`). That keeps a
component colorway-parameterized so the same box means any state.

## Component catalog (house components)

All import from `@components`. This is the map; **[`references/components.md`](references/components.md)
has the full prop signatures and the `components/README.md` prop tables** — read
it before using one you don't know.

- **Atom:** `Stamp` — the boxed pill (`tone`, `filled`, `blink`, `glow`, `size`)
  for every id/status/tag. The most-reached-for piece.
- **Text:** `BilingualLabel`, `MetadataBlock` (`KEY:VALUE`), `SectionDivider`
  (numbered form head), `SectionHeading` (marketing head), `FieldLabel`,
  `DossierSheet` (spec/dossier block with watermark + signature).
- **Layout & shell:** `ConsoleFrame` (the chamfered command shell: header ·
  `sidebar · main · rail` · optional `band` / `footer` / `alarm`), `ZoneTitle`,
  `Monogram`, `Stat`, `GaugeCard`, `TelemetryCard`.
- **Flow:** `StepFlow` (progress stepper), `AgenticLoop` (self-cycling OODA
  ring), `TaskCard`.
- **Status:** `StatusLegend`, `Roster`, `StatTile`, `RailItem`, `GateRow`,
  `AgentCard`, `RecallNote`, `SinkRow`, `RoutineRow`, `ModuleCard`, `MemoryRow`,
  `AgentDot`.
- **Inputs:** `ChipRadioGroup`, `NumberStepper`, `HazardRating`, `TagInput`,
  `DateSegments` (stock MUI `TextField`/`Select`/`Checkbox`/`Switch`/`Slider` are
  already themed — use them inside `FieldLabel`).
- **Navigation:** `ConsoleNav` (`variant="boxed" | "rail"`), `FilterChips`,
  `FilterRail` (dims non-matches, never hides), `WikiLink`, `SiteHeader`, `Brand`.
- **Feedback:** `HazardPrompt`, `GateDecisionDialog`, `ApprovalBar`, `YesNoGate`.
- **Data-viz:** `SegmentedMeter`, `RadialGauge`, `BarColumnGauge`, `ProgressMeter`,
  `SegmentBar`, `LedColumn`, `MeterBar` (the one continuous-fill exception),
  `HealthColumns`, `Terminal`, `LogConsole`, `SevenSegClock`, `DigitalClock`,
  `Marquee`, `LineChart`, `Waveform`, `ScanLattice`.

**Controlled vs. self-driving:** the meters, gauges, charts, clocks, and
`AgenticLoop` animate a demo feed when uncontrolled; pass `value(s)` / `active`
(etc.) to drive them from your own data, which also stops the internal animation.

## Recipes

**A full console screen** — `ConsoleFrame` is the shell. Header spans the top over
a `sidebar · main · rail` grid; add a `footer` status bar and an `alarm` boolean
(red frame + hazard stripe) when state demands:

```tsx
<ConsoleFrame header={<Head/>} sidebar={<Nav/>} rail={<Rail/>}
  footer={<StatusBar/>} alarm={anyRetried}>
  <MainColumn/>
</ConsoleFrame>
```

**A status/id/tag** — reach for `Stamp`, never a bordered `<span>`:

```tsx
<Stamp tone="mint" glow>SYS:NOMINAL</Stamp>
<Stamp tone="amber" blink>IMPL</Stamp>       {/* in-progress */}
<Stamp tone="red" filled>DOWN</Stamp>        {/* recorded/active inversion */}
```

**A live console / feed** — `LogConsole` (streaming, tagged or tagless toned rows,
optional `prompt` line) or `Terminal` (diagnostic with dot-leader checks +
typewriter). Feed rows; it auto-scrolls:

```tsx
<LogConsole title="STDOUT // AGENT·ORION" rows={rows} status={paused ? 'PAUSED' : 'TAILING'} />
```

**A metric** — frame a gauge in a card, never free-float one. `TelemetryCard`
(title/type header · body · footer) or `GaugeCard` (chamfered, state-tinted
channel), with a `RadialGauge` / `SegmentBar` / `LedColumn` inside:

```tsx
<TelemetryCard title="◐ VAULT RETENTION" type="ARC" foot={['THRESHOLD 90%', 'STABLE']}>
  <RadialGauge value={98} label="HELD" size={120} />
</TelemetryCard>
```

**A human-in-the-loop gate** — `ApprovalBar` (inline approve/deny under a log),
`GateDecisionDialog` (full-screen approve/deny/defer, focus-trapped), or
`YesNoGate` (the big marketing Y/N CTA). Never a hand-composed MUI `Dialog` when
one of these fits.

**A form** — number the sections (they *are* a sequence) with `SectionDivider`;
label controls with `FieldLabel` (bilingual caption over a themed stock input);
use `ChipRadioGroup` / `HazardRating` / `TagInput` / `NumberStepper` for the
console-specific controls. Every "checked/selected" state uses the hue inversion.

**A filterable list** — `FilterChips` (orange scope chips) over rows that **dim**
(opacity + grayscale) rather than hide when filtered — the operator never loses
their place — or the bundled `FilterRail`. Typed rows: `RoutineRow`, `SinkRow`,
`MemoryRow`, `GateRow`.

**A landing / brand surface** — `SiteHeader` + `Brand` masthead, `SectionHeading`
section breaks, `ModuleCard` product grid, `Marquee` ticker, `AgenticLoop` /
`DossierSheet` for the hero, `YesNoGate` for the CTA. One signature per screen
(a giant kanji, a decision alarm) carries the page; everything else stays quiet.

## Anti-patterns (these read as "off-system" or fail a11y)

- Any surface color other than `#0A0A0A`; a drop shadow, lighter-gray "raised"
  card, or `backdrop-filter` glass for depth. Depth is border + glow + hue.
- A hardcoded hex/size instead of a `theme.nerv.*` token or a component `tone`.
- **Orange carrying a data value or status** — orange is chrome only. If orange
  is *saying* something, it's wrong.
- Easing/spring/bounce on any transition; an opacity fade for a state change. Use
  linear / `steps()`, and always ship a reduced-motion path.
- `border-left` / `border-right` > 1px as a colored accent stripe on a card, row,
  or callout. Use a full border, a background tint, or a leading `Stamp`.
- `background-clip: text` gradient text anywhere. Emphasize with weight/size/glow.
- Lowercase UI chrome, or setting labels/buttons/data in the Mincho JP font.
- **Glow on black-on-fill content** — the fill carries the light; the content
  stays crisp.
- Rebuilding a stock MUI or house component with `sx` when the themed one exists
  (a restyled `Chip` instead of `Stamp`, a hand-built log instead of `LogConsole`,
  a hand-composed `Dialog` instead of `GateDecisionDialog`/`YesNoGate`).
- A numbered/eyebrow marker above a section that isn't a real sequence.
- A modal doing more than one focal job.

## Verifying your work

Run the app to check a change: `cd app && npm run dev` (or the browser-preview
tools). Type-check the theme + components in context with `cd app && npx tsc -b`
and build with `npx vite build` — both must be clean. `verbatimModuleSyntax` and
`noUnusedLocals/Parameters` are on, so use `import type`, no unused imports.

Verify visually against the reference screens — `/` (the component gallery),
`/dashboard-0{1,2,3}`, `/landing-0{1,2}`. **Screenshot quirk:** the in-app
browser renders black frames when a page is scrolled programmatically; for the
long scrolling gallery/landing pages, resize the viewport tall and screenshot
from scroll-0, or confirm content through the DOM (`read_page`, `get_page_text`,
computed styles) instead. Fixed-viewport dashboards screenshot fine as-is.

When unsure how a component should look or behave, open the `/` gallery or read
its source in [`components/`](../../../components) — the code is the source of truth.
