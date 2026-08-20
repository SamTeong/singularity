---
name: Jairus OS — NERV/MAGI Tactical Design System
description: A black CRT command console where information glows in phosphor mint, safety orange, and blood red — dense, all-caps, bilingual, mechanically animated.
colors:
  bg: "#0A0A0A"
  mint: "#52F29A"
  mint-hi: "#7CF4AB"
  green-map: "#3C9C6C"
  green-dim: "#246C3C"
  paper: "#EDF8D6"
  orange: "#F26400"
  amber: "#F49F09"
  amber-dim: "#9C3C24"
  red: "#C20C0C"
  red-hi: "#E2280F"
  crimson: "#E60225"
  teal: "#0C6C80"
  blue: "#5090D0"
  blueprint: "#B4B4B4"
typography:
  display:
    fontFamily: "Arial Narrow, Avenir Next Condensed, Helvetica Neue, Arial, sans-serif"
    fontSize: "clamp(1.5rem, 4vw, 3.4rem)"
    fontWeight: 700
    lineHeight: 1.0
    letterSpacing: "0.02em"
  headline:
    fontFamily: "Arial Narrow, Avenir Next Condensed, Helvetica Neue, Arial, sans-serif"
    fontSize: "1.375rem"
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: "0.03em"
  jp-display:
    fontFamily: "Hiragino Mincho ProN, Yu Mincho, Noto Serif JP, serif"
    fontSize: "2.5rem"
    fontWeight: 800
    lineHeight: 1.0
    letterSpacing: "0.1em"
  body:
    fontFamily: "ui-monospace, SF Mono, Menlo, Consolas, monospace"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "0.03em"
  label:
    fontFamily: "ui-monospace, SF Mono, Menlo, Consolas, monospace"
    fontSize: "0.625rem"
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "0.14em"
rounded:
  none: "0"
  chip: "2px"
  seg: "4px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.mint}"
    rounded: "{rounded.none}"
    padding: "10px 20px"
  button-primary-active:
    backgroundColor: "{colors.mint}"
    textColor: "{colors.bg}"
    rounded: "{rounded.none}"
    padding: "10px 20px"
  button-ghost:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.green-map}"
    rounded: "{rounded.none}"
    padding: "10px 20px"
  stamp:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.mint}"
    rounded: "{rounded.chip}"
    padding: "2px 9px"
  stamp-fill:
    backgroundColor: "{colors.red-hi}"
    textColor: "{colors.bg}"
    rounded: "{rounded.chip}"
    padding: "2px 9px"
  input-text:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.mint}"
    rounded: "{rounded.none}"
    padding: "9px 11px"
  panel:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.mint}"
    rounded: "{rounded.none}"
    padding: "16px"
  zone-title:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.orange}"
    rounded: "{rounded.none}"
    padding: "0 0 4px 0"
  gauge-card:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.mint}"
    rounded: "{rounded.none}"
    padding: "18px"
  card-module:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.mint}"
    rounded: "{rounded.none}"
    padding: "16px"
---

# Design System: Jairus OS — NERV/MAGI Tactical Console

## 1. Overview

**Creative North Star: "The Phosphor Console"**

Everything luminous blooms on true black. This is not a dark theme — it is a CRT command deck, the kind you'd find running a fictional orbital station's reactor. Information is drawn in glowing phosphor mint, cut with safety orange chrome and blood-red alarms. There is no elevation, no soft depth, no glass. Hierarchy is built from three materials only: **border, glow, and hue.** A panel is a stroked box on black; an active control is a solid block of color with the black content punched out of it. Depth is a lie the system refuses to tell.

The register is a working tool, not a marketing surface, but it rejects the product-UI reflex toward invisible familiarity. It is deliberately, unmistakably itself: all-caps condensed display type sits over dense monospace data, every status word is boxed, and large Japanese Mincho glyphs pair with small English captions the way the reference material (the NERV/MAGI screens of *Neon Genesis Evangelion*) pairs `内部` with INTERNAL. Motion is mechanical throughout — stepped segment fills, hard 1–2 Hz blinks, teletype rows, snap state changes. Nothing eases. Nothing fades. The screens feel hand-cranked, like a machine reporting rather than an app animating.

What it explicitly rejects: elevation surfaces and drop-shadow depth; smooth eased or spring motion; tinted-glass panels; humanist body type and sentence-case chrome; the calm neutral palette of a Linear or a Notion. Familiarity is not the goal here — a committed, legible, internally-consistent tactical identity is. The bar is that a NERV screen and a Jairus OS screen should be indistinguishable in grammar.

**Key Characteristics:**
- True near-black (`#0A0A0A`) is the only surface; hierarchy from border + glow + hue, never elevation.
- Color is state: mint = nominal, orange = chrome, blue = pending, amber = caution, red = critical.
- Figure/ground inversion marks activation — idle outline on black, active solid fill with black content.
- Bimodal type: one giant element (kanji / numeral / headline) plus tiny dense captions; nothing mid-sized.
- Bilingual by default: Mincho kanji graphic + small Latin caption.
- Mechanical motion only: `steps()` and `setInterval` ticks, never eased curves.
- A CRT scanline + vignette pass overlays every dark screen.

## 2. Colors

A committed tactical palette: black surface, one phosphor primary, a strict semantic vocabulary where hue *is* the state, and orange reserved entirely for chrome. Tokens are canonical as OKLCH in prose; the frontmatter carries sRGB hex for tooling compatibility.

### Primary
- **Phosphor Mint** (`#52F29A`, `oklch(85.6% 0.196 158)`): The primary. Nominal status, success, approved rulings (承認), active data, primary actions, current selection. **Phosphor Mint Hi** (`#7CF4AB`) is its hover/peak/glow-core sibling for headlines and hot segments.

### Secondary
- **Safety Orange** (`#F26400`, `oklch(68.9% 0.203 44)`): Structural chrome only — every border, rule, divider, section number, axis, crosshair, and metadata key. It draws the machine's frame; it is never a data value.
- **Terminal Amber** (`#F49F09`, `oklch(76.4% 0.166 71)`): Terminal and log text, timestamps, caution-priority labels. **Amber Dim** (`#9C3C24`) is its second brightness level — dim amber is the log's chrome, bright amber its data.

### Tertiary
- **Deliberation Blue** (`#5090D0`, `oklch(64.1% 0.121 251)`): The pending / in-review / deliberating state only (待機, 審査中). Never decoration.
- **Map Green** (`#3C9C6C`, `oklch(64.7% 0.121 158`) → **Green Dim** (`#246C3C`): Secondary and tertiary data — dim wireframes, idle borders, disabled tracks, captions.

### Neutral
- **Void** (`#0A0A0A`, `oklch(15.5% 0 0)`): The one and only background, and the "content color" punched out of every filled control. True near-black, never gray.
- **Paper** (`#EDF8D6`, `oklch(96.4% 0.06 118)`): Max-brightness fill — headlines on black, the black-on-mint clock chip face.
- **Blueprint** (`#B4B4B4`, `oklch(76.8% 0 0)`): Reserved for the optional light "blueprint" schematic variant only. Not part of the core dark system.

### Danger
- **NERV Red** (`#C20C0C`) → **Red Hi** (`#E2280F`): Critical, denied (否認), offline, DANGER. Red Hi carries alert surfaces and strobes; deep red carries danger data. **Crimson** (`#E60225`) is used *exclusively* for 45° hazard stripes.

### Accent
- **Teal** (`#0C6C80`): Header double-rules and hardware-bezel framing only.

### Named Rules
**The Orange-Is-Chrome Rule.** Safety Orange (`#F26400`) draws the machine and never carries meaning. Borders, rules, dividers, axes, section numbers, metadata keys — orange. A data value, a status, a result is *never* orange. If orange is saying something, it's wrong.

**The Color-Is-State Rule.** A component's hue is its status, not its brand. The same panel renders mint / amber / blue / red to mean nominal / caution / pending / critical without moving a pixel. Build every component colorway-parameterized via `currentColor`.

## 3. Typography

**Display Font:** Condensed grotesque — `Arial Narrow` / `Avenir Next Condensed` (web-font target: **Oswald** / **Archivo Narrow**).
**Body Font:** Monospace — `ui-monospace, SF Mono, Menlo, Consolas` (target: **Share Tech Mono** / **VT323**).
**JP Display Font:** Mincho serif — `Hiragino Mincho ProN, Yu Mincho` (target: **Shippori Mincho B1**, ≈ Eva's Matisse EB).

**Character:** Three faces on genuine contrast axes — condensed sans for shouting, monospace for data, heavy Mincho for the bilingual graphic. The pairing is the personality: a NERV readout is condensed caps over dense mono, punctuated by giant kanji. Numerals in clocks and countdowns are drawn as 7-segment SVG polygons, not set in a font.

### Hierarchy
- **Display** (700, `clamp(1.5rem, 4vw, 3.4rem)`, line-height 1.0, tracking 0.02em, ALL CAPS): Page and hero headlines, giant numerals. Condensed, glowing.
- **Headline** (700, 1.375rem, line-height 1.1, ALL CAPS): Card and section titles, primary objectives.
- **JP Display** (800, 2.5rem, `text-transform:none`, letter-spacing 0.1em + matching `text-indent`): The large kanji graphic in headers, alerts, and mastheads. Always paired with a small Latin caption.
- **Body / Data** (400, 0.8125rem, line-height 1.5, tracking 0.03em): Monospace UI text, `KEY:VALUE` metadata, terminal rows. ALL CAPS for chrome; sentence-case permitted only for long prose (article body, form hints), capped at 65–75ch.
- **Label** (400, 0.625rem, letter-spacing 0.14em, ALL CAPS): Field labels, captions, legend text, section eyebrows.

### Named Rules
**The No-Lowercase Rule.** UI chrome is ALL CAPS — labels, buttons, headers, data, terminal. Lowercase is permitted *only* in genuine reading prose (a wiki article body, a form hint sentence). If a button or a status is lowercase, it's wrong.

**The Bimodal-Scale Rule.** Cluster type at the two ends: tiny (8–14px labels and data) and large (22px–hero display). Mid-sized type reads as generic. One giant element per screen, everything else small.

**The Bilingual-Pairing Rule.** A large Mincho kanji never appears alone in functional UI. It is the graphic; a small Latin caption beneath it is the translation (`内部` / INTERNAL). Untranslated decorative kanji is forbidden.

## 4. Elevation

**This system has no elevation.** There are no shadows for depth, no z-lifted cards, no glass. Every surface is flat on true black at the same plane. Depth, where it reads at all, is an illusion built from three flat materials: a 1–2px orange **border**, an outer/inset **glow**, and **hue**. A "raised" panel is simply a stroked box with a faint inset glow; a "focused" field is a border that shifts to mint plus a glow ring.

The only shadow-like tokens in the system are **glow** effects, and they are luminance, not depth:

### Glow Vocabulary
- **Text glow** (`text-shadow: 0 0 4px currentColor, 0 0 12px <hue>@40%`): Applied to headlines, active stamps, alarm text. Intensity graded red > orange > green.
- **Box glow** (`box-shadow: 0 0 6-10px <edge>@40-50%, inset 0 0 6-12px <edge>@12-25%`): The "elevation" of panels and focused inputs — an emitted halo, never a cast shadow.
- **Segment glow** (`box-shadow: 0 0 5px <hue>, 0 0 12px <hue>@40%`): Per-lit LED segment in meters and gauges.

### Named Rules
**The No-Elevation Rule.** Prohibited: `box-shadow` used as a downward/offset drop shadow, lighter-gray "raised" surfaces, `backdrop-filter` glass panels. Depth is border + glow + hue. If a surface looks lifted off the page by a soft gray shadow, delete the shadow and give it a border.

**The Glow-On-Black-Only Rule.** Glow renders on luminous elements against `#0A0A0A`. Content punched out of a filled control (black text on mint) gets *no* glow — the fill carries the light, the content stays crisp.

## 5. Components

Every interactive component ships default, hover, focus-visible, active/selected, and (where relevant) disabled and error. Shape is universally hard-cornered (`0` radius) except chips and meter segments (2–4px). Hero panels and frames chamfer one or two corners via `clip-path`.

Every grammar below is a named React component in [`components/`](components/) (full prop tables in `components/README.md`), each reading `theme.nerv.*` tokens. Reach for the named component — a bordered `<span>` is a `Stamp`, a metric panel is a `TelemetryCard`, a status readout is a typed row — before hand-rolling `sx`.

**The Named-Component Rule.** If a pattern here has a component, assemble from it (and from stock MUI carrying the theme); do not re-derive the grammar inline. Branch out only when the UX genuinely wins, then fold the new pattern back into the library.

### Buttons
- **Shape:** Zero radius, always. Condensed caps, letter-spacing 0.12em.
- **Primary:** Mint outline on black (`2px solid #52F29A`, text mint), padding `10px 20px`. The **selected/primary-active** state is the signature figure/ground inversion — solid mint fill, black text — and blinks (`btnblink`, 1s steps(1)) to signal "this is the live action."
- **Hover:** Fills with its own hue, black text, glow ring.
- **Focus:** `2px solid` paper or mint outline, offset 2–3px.
- **Ghost / Alt:** Ghost = green-dim outline, mono, muted (secondary actions). Alt = orange outline (chrome-level actions). Disabled = 0.4 opacity, animation off.

### Stamps / Chips
- **Style:** Text boxed in a 1px border of its own color, radius 2px, padding `2px 9px`. Colorway via `currentColor`.
- **State:** Outline (default record) · `.blink` (in-progress: `点検中`, `審査中`) · `.fill` (inverse — solid hue, black content — for active/recorded, e.g. an OFFLINE unit or a timestamp).
- **Component:** `Stamp` (`tone`, `filled`, `blink`, `glow`, `size`) is the atom — the canonical boxed pill for any id, status, or tag. Never hand-roll a bordered `<span>` for one.

### Legend
- **Style:** A row of small boxed kanji+EN swatches (`正常` NOMINAL / `注意` CAUTION / `待機` PENDING / `阻止` BLOCKED) that keys every status color used in the section below it. Signature supporting element — place one above any status-colored grid.

### Cards / Panels
- **Corner Style:** `0` radius; hero/focal panels chamfer 1–2 corners (`clip-path`, cut 16–32px).
- **Background:** Void (`#0A0A0A`), never a lighter surface.
- **Shadow Strategy:** None — see Elevation. Border (`1–2px #F26400`) plus faint inset orange glow.
- **Border:** 1px idle chrome; 2px emphasis. The **frame shell** (`ConsoleFrame`) uses 3px + a `::before` inset 1px line = the signature double frame; it holds a header over `sidebar · main · rail`, plus an optional full-width `band`, a `footer` status bar, and an `alarm` state that recolors the frame red and drops a 45° hazard stripe across the top.
- **Internal Padding:** `12–22px`. Titled zones use `.zone-title` (orange condensed caps, green-dim underline).
- **Telemetry panels:** `TelemetryCard` (orange border, title/type header · gauge body · two-slot footer) and `GaugeCard` (single-corner chamfer, state-tinted border, a kanji-tagged channel framing one gauge + readout + sub) are the canonical metric containers — drop a gauge inside, never free-float one.
- **Product card:** `ModuleCard` — the pinnable system/product card for brand surfaces: a glowing kanji glyph · `SYS·NN` code · title · body · footer state stamp; selecting it pins with a mint border + glow (figure/ground). `RecallNote` is the cited memory/decision fragment (1px tinted left edge). Nested cards are forbidden.

### Inputs / Fields
- **Style:** Void field, `1px solid #246C3C` idle border, mint text and caret, uppercase, zero radius.
- **Hover:** Border → Map Green.
- **Focus:** Border → mint, plus glow ring (`box-shadow: 0 0 8px rgba(82,242,154,.35), inset 0 0 6px rgba(82,242,154,.12)`). No default browser outline.
- **Error:** Border → Red Hi + red glow; a directive `.err` message below (`» DESIGNATION REQUIRED — NAME THE DECISION YOU ARE FILING`).
- **Full control set:** custom listbox dropdown (native `<select>` replaced with an ARIA combobox; active option inverts to mint), radio priority chips, checkbox, switch, native-range slider + dual-thumb range, number stepper, segmented toggle group, autocomplete tag input, hazard-block rating, segmented date/time, file dropzone, password reveal, input adornments. Every "checked/selected" state uses the mint (or per-role hue) inversion.

### Navigation
- **Sidebar:** `ConsoleNav` — stacked bilingual items, kanji-on-top / EN-below. Its `boxed` variant (default) inverts the current item to a mint fill (black content); its `rail` variant renders quieter one-line links (kanji + label) with a mint left-edge indicator, for app-shell rails. Hover = border → mint; focus-visible = amber dashed outline. Supports left + right rails.
- **Filter rail:** `FilterRail` — scope buttons that **dim** non-matching rows (opacity 0.25 + grayscale) rather than hiding them; the set stays visible, the filter narrows attention. `FilterChips` is the orange scope-chip row alone (active = solid orange inversion), to pair with your own dimmed rows.
- **Breadcrumb:** `A › B › here` with orange separators, mint-hi current.
- **Top nav / brand:** `SiteHeader` — sticky orange-ruled bar whose in-page `#anchor` links smooth-scroll (reduced-motion aware) beside an actions slot. The `Brand` lockup (rotated-square mint mark · condensed wordmark · orange version, inline or stacked) is the shared masthead mark. Time reads on `SevenSegClock` (mint chip / orange readout skins; `digits` drives an uptime counter) or the lighter `DigitalClock` (mono `HH:MM:SS`, blinking colons). `WikiLink` is the `[[cross-reference]]` that inverts on hover.

### Terminal / Log (signature)
- Amber-on-black, **two brightness levels** (bright amber = data, dim amber = chrome). Dash-rule section headers, dot-leader `LABEL … OK/FAIL` status columns, a single boxed CAUTION stamp exception in an otherwise unboxed log, a persistent blinking cursor. Rows enter by teletype (~130ms/row). This is the canonical way to show system output, feeds, and receipts.

### Alert / Decision Prompt (signature)
- Full-bleed red overlay, 45° hazard stripes top/bottom, a giant condensed English word in a black band, boxed Japanese stamps (intentionally off-center per the reference), corner `ALERT` chips — and always a **response footer** giving the operator the decision (承認 APPROVE / 否認 DENY / 保留 DEFER). Tri-channel: English word + Japanese stamp + hazard pattern. Escape defers.

### Data Display (signature)
- **Segmented meters** use discrete LED segments (never a continuous fill), colored per zone, with a drawn, labeled threshold rule riding across: `SegmentedMeter` (vertical columns + threshold), `SegmentBar` (thin inline horizontal), `LedColumn` (a single vertical column that fills bottom-up and turns critical-red under a `hotBelow` floor), `ProgressMeter` (horizontal with a drawn gate line), `HealthColumns` (mini stepped health bars). **Gauge trio:** `RadialGauge` (arc) / `BarColumnGauge` (bar over histogram) / column banks — three geometries, one grammar.
- **The one continuous-fill exception** is `MeterBar` — a thin **continuous** glowing vitals bar (label · value · fill; `warn` flips it amber) for a sidebar CPU/memory readout. It is the deliberate exception to the LED-segment rule; everything data-quantitative else stays segmented.
- **Charts & separators:** `LineChart` (a glowing polyline with a gradient area fill and a leading dot over sparse baseline dots — not a dense `+` grid), `Waveform` (an edge-tapered braided sinusoid band between sections), `ScanLattice` (a static schematic grid with a targeting reticle). All animate in mechanical steps.

### Flow / Sequence
- **`StepFlow`** — a horizontal progress stepper: chamfered nodes, done → current (blinking blue) → upcoming. **`AgenticLoop`** — the OODA loop as a ring of bilingual kanji nodes with `→` connectors, one lit at a time (self-cycling, mechanical). **`TaskCard`** — a loop-synchronizer task: id · title · action over a `StepFlow` and a labeled progress bar. Sequence grammar (a stepper, a ring, numbering) earns its place only when the content *is* an ordered flow.

### Status rows
- A family of typed, boxed rows for dense status lists — each carries its state in a `Stamp`, never a side-stripe: **`AgentDot`** (state dot + label for a footer bar), **`SinkRow`** (delivery sink: name · state · ping · LIVE/DOWN stamp; OFFLINE inverts to a solid red fill), **`RoutineRow`** (id · name · kind · status stamp · RUN, `dim` when filtered), **`MemoryRow`** (vault entry: id · title · kind stamp), **`GateRow`** (decision-queue row: id · title · priority · REVIEW/verdict), **`RailItem`** (reminder/inbox row with a due marker), **`StatTile`** (negative-space KPI: tiny label · giant numeral · tiny footer).

### Brand surfaces
- The dual-use pieces for the landing/showcase register: **`SiteHeader`** + **`Brand`** (masthead), **`SectionHeading`** (numbered marketing head — index chip · big condensed heading · fading orange rule · note; distinct from the form-oriented `SectionDivider`), **`DossierSheet`** (an "official document" block — teal-ruled heading · KEY/VALUE rows · signature footer · optional rotated `PRELIMINARY` watermark), **`ModuleCard`** (product grid), **`Marquee`** (red hazard ticker), and **`YesNoGate`** (the big Y/N call-to-action — mint YES beside red NO, each fills on choose, with an aria-live response line). One signature per screen still holds: the giant 開始 CTA carries the page; everything around it stays disciplined.

## 6. Do's and Don'ts

### Do:
- **Do** keep `#0A0A0A` as the only background and build hierarchy from border + glow + hue.
- **Do** make color mean state — mint nominal, blue pending, amber caution, red critical — and parameterize every component by `currentColor`.
- **Do** render active/selected states as figure/ground inversion: solid hue fill, black (`#0A0A0A`) content, no glow on the content.
- **Do** box every status word in a `.stamp`; blink = in-progress, solid fill = recorded/active.
- **Do** pair every large kanji with a small English caption (`内部` / INTERNAL).
- **Do** keep motion mechanical — CSS `steps()` and `setInterval` ticks, 150–250ms or stepped, with a `prefers-reduced-motion` alternative that renders the final state and kills blinks/strobes/marquees.
- **Do** reserve Safety Orange (`#F26400`) for chrome — borders, rules, dividers, axes, metadata keys — only.
- **Do** overlay the CRT scanline + vignette pass on every dark screen.
- **Do** number a sequence only when it *is* one (form sections, the OODA loop, an ingestion pipeline) — those carry real order.

### Don't:
- **Don't** use elevation for depth: no drop shadows, no lighter-gray "raised" surfaces, no glassmorphism / `backdrop-filter` panels. Depth is border + glow + hue.
- **Don't** ease or spring anything — no `cubic-bezier` state transitions, no opacity fades for state, no bounce. Linear or `steps()` only.
- **Don't** use `border-left` / `border-right` > 1px as a colored accent stripe on cards, callouts, or list items. Use a full border, a background tint, or a leading stamp.
- **Don't** use `background-clip: text` gradient text. Emphasis comes from weight, size, and glow on a single solid color.
- **Don't** write UI chrome in lowercase or set labels/buttons/data in the Mincho display font.
- **Don't** let Safety Orange carry a data value or a status — if orange is saying something, rewrite it.
- **Don't** put glow on black-on-fill content; the fill carries the light, the content stays crisp.
- **Don't** reach for a modal by default — exhaust inline and progressive alternatives first; when a modal is right, keep it to one focal job (the reference `experiment-sonnet-38` was rejected as "too busy").
- **Don't** ship a light warm-neutral variant as the default; the system is dark-only. The `blueprint` light theme is a deliberate schematic exception, not a fallback.
