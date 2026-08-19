# NERV/MAGI Tactical Design System — "Jairus OS"

A component + token system extracted from the reference GIFs (`references-chosen/`), the 34 experiments, and the shipped pages (`dashboard-0{1,2,3}`, `form-0{1,2}`, `landing-page-0{1,2}`, `wiki`). It is the buildable consolidation of two research docs: [DESIGN-SYSTEM.md](DESIGN-SYSTEM.md) (the original — sampled palette + per-GIF recipes) and [REFERENCE-ANALYSIS.md](REFERENCE-ANALYSIS.md) (the 23-GIF breakdown). Live gallery: **[design-system.html](design-system.html)**.

**One-line identity:** a black CRT command console where information glows in phosphor mint, safety orange, and blood red — dense, all-caps, hard-edged, bilingual (EN + JP), animated in abrupt mechanical steps rather than smooth easing.

---

## 1. Principles

1. **Black is the canvas; light is the ink.** Everything sits on `#0A0A0A`. No elevation grays, no soft shadows-for-depth. Hierarchy comes from **border + glow + hue**, never a lighter surface.
2. **Color is state; layout is constant.** The same component re-renders mint / amber / blue / red to mean nominal / caution / pending / critical without moving a pixel. Build every component colorway-parameterized.
3. **Filled means active (figure/ground inversion).** Idle = 1px outline on black. Active/selected = solid fill of the semantic hue with **black (`--bg`) content punched out**, no glow on the content. The single most recognizable move in the system — it drives selected nav, checked radios/switches, the active mode button, and the OFFLINE stamp.
4. **Everything important is boxed.** A status word = text inside a 1px border of its own color (`.stamp`). Blinking box = in progress; solid-fill inverse = recorded/active.
5. **Bimodal type scale.** One giant element (kanji, numeral, headline) + tiny dense captions. Avoid mid-sizes — if everything is 16px it reads off-brand.
6. **Bilingual pairing.** Big Mincho kanji is the graphic; a small Latin caption underneath is the translation (`内部` / INTERNAL). Kanji never appears untranslated in functional UI.
7. **Structure encodes truth.** Numbered markers (01/02…) only where content is a real sequence (form sections, ingestion pipeline, OODA loop) — never as decoration.
8. **Motion is mechanical.** `setInterval` ticks and CSS `steps()` only. Stepped fills, hard 1–2 Hz blinks, teletype rows, snap state changes (optionally a 2–3 frame flicker before settling). **Never** `ease`/`cubic-bezier`/spring/opacity-fade for state. Loaders end by reverse-cascade to black, not fade.
9. **Diagonal energy where urgency lives.** Chamfered panel corners, 45° hazard chevrons, rotated warning plates — reserved for alerts and hero framing, not sprinkled everywhere.
10. **CRT pass on every dark screen.** Scanlines + vignette via `body::after`. Part of the identity, not optional chrome.
11. **Copy is direction, not mood.** Errors state what happened and how to fix it (`DESIGNATION REQUIRED — NAME THE DECISION YOU ARE FILING`), never apologize. Empty states invite action.
12. **Restraint.** Spend boldness in one signature element per screen; keep everything around it disciplined. Respect `prefers-reduced-motion` — kill blinks/strobes/marquees, keep final states readable.

---

## 2. Design tokens

All tokens are CSS custom properties on `:root`. They are **identical across every shipped file** — the system's biggest consistency win (0 palette drift in audit).

### 2.1 Color

```css
:root{
  /* surface */
  --bg:#0A0A0A;            /* the only background; true near-black, never gray */
  /* primary / success / active data */
  --mint:#52F29A;         --mint-hi:#7CF4AB;   /* hi = hover/peak/glow core */
  --green-map:#3C9C6C;    /* secondary data, dim labels, captions */
  --green-dim:#246C3C;    /* tertiary: idle borders, tracks, disabled */
  --paper:#EDF8D6;        /* max-brightness fill: headlines, clock chip face */
  /* chrome */
  --orange:#F26400;       /* CHROME: borders, rules, dividers, markers, section idx */
  /* terminal / log */
  --amber:#F49F09;        --amber-dim:#9C3C24;  /* dim = 2nd brightness level */
  /* danger */
  --red:#C20C0C;          --red-hi:#E2280F;    --crimson:#E60225; /* stripes only */
  /* accents */
  --teal:#0C6C80;         /* header double-bars, hardware bezel */
  --blue:#5090D0;         /* pending / deliberating / reviewing state */
  --blueprint:#B4B4B4;    /* optional light "blueprint" theme bg only */
}
```

**Semantic mapping**

| Role | Token | Notes |
|---|---|---|
| primary / success / online | `--mint` (hover `--mint-hi`) | actions, nominal, approved (承認) |
| chrome / structure / focus-accent | `--orange` | all borders, rules, dividers, section numbers |
| info / pending / in-review | `--blue` | 待機 / 審査中 states |
| warning / caution | `--amber` | 注意, elevated priority |
| error / critical / denied | `--red-hi` (deep `--red`) | 否認, DANGER, offline |
| hazard stripes | `--crimson` | `repeating-linear-gradient(-45deg,…)` only |
| terminal text | `--amber` + `--amber-dim` | two brightness levels = two hierarchy levels |
| body / data text | `--mint` / `--green-map` | context-dependent |
| max-bright fill | `--paper` | headlines on black, clock face |

**Glow recipe** (intensity red > orange > green; never on black-on-fill content):
```css
text-shadow:0 0 4px currentColor, 0 0 12px <hue>@40%;
box-shadow:0 0 6px <edge>@50%, inset 0 0 6px <edge>@25%;
```

### 2.2 Typography

| Role | Stack (token) | Treatment |
|---|---|---|
| **Display** | `--cond` → `"Arial Narrow","Avenir Next Condensed","Helvetica Neue",Arial,sans-serif` | ALL CAPS, 700, tracking .02–.14em. Headlines, section titles, buttons, big numerals. Web-font target: **Oswald / Archivo Narrow**. |
| **Body / data / UI** | `--mono` → `ui-monospace,"SF Mono",Menlo,Consolas,monospace` | ALL CAPS for chrome; sentence-case allowed for long prose (article body, form hints). Tracking .03–.08em. Target: **Share Tech Mono / VT323**. |
| **JP display** | `--jp` → `"Hiragino Mincho ProN","Yu Mincho","Noto Serif JP",serif` | Weight 800, `text-transform:none`, letter-spacing .1–.5em + matching `text-indent` to re-center. Target: **Shippori Mincho B1** (≈ Eva's Matisse EB). |
| **Numerals / clock** | 7-segment SVG polygons (not a font) | See `.timechip`; orange glow (countdown) or black-on-mint (timestamp). |

**Scale** (bimodal — cluster at the ends): `8 / 9 / 10 / 11 / 12 / 13 / 14` (labels & data) … `18 / 22 / 26 / 34 / 40 / 60 / 72+ / clamp() hero`. Leading 1.1–1.2 for chrome, 1.5–1.72 for prose. `font-variant-numeric:tabular-nums` on any changing number.

**Conventions:** no lowercase in UI chrome; interpunct in IDs (`VEGA·1`, `GATE·04`, `ENG-402`); `KEY:VALUE` metadata blocks (`CODE:`, `FILE:`, `EXTENTION:` — the canonical misspelling, `EX_MODE:`, `PRIORITY:`).

### 2.3 Spacing

Base grid `4 / 8 / 16 / 24 / 32`. Component padding: panels 12–22px, cards 9–18px, chips 2–9px, meter segment gap 3px, frame margin 14px. **Density is the point** — screens are packed; whitespace is black space used for drama (the giant-kanji hero), not for breathing room between controls.

### 2.4 Borders, radius, shape

| Token | Value |
|---|---|
| default radius | **0** |
| chip / stamp / segment radius | 2–4px only |
| hairline border | 1px (connectors, label boxes, idle states) |
| standard border | 2px (panel outlines, callouts, active emphasis) |
| frame border | 3px + `::before` inset 1px = the signature **double frame** |
| chamfer (hero/frame/card) | `clip-path:polygon(0 0,calc(100% - Npx) 0,100% Npx,100% 100%,Npx 100%,0 calc(100% - Npx))`, N = 10 (chip) / 16–22 (card) / 26–30 (frame) |
| header double-rule | paired 2–3px `--teal` bars |

### 2.5 Motion

| Pattern | Spec |
|---|---|
| blink (in-progress) | `@keyframes blink{0%,49%{opacity:1}50%,100%{opacity:0}}` at `1s steps(1)` (urgent `.5s`) |
| button "selected" blink | `@keyframes btnblink{0%,74%{fill}75%,100%{invert}}` at `1s steps(1)` |
| segment fill | 8–15 steps/sec (interval 70–160ms), whole segments |
| teletype | rows appear in chunks, ~110–160ms/row |
| cascade / stagger | 30–80ms per unit, row-major |
| state snap | instant, optional 2–3 frame flicker (`visibility:hidden` 60→120ms) before settling |
| countdown | 1s tick, blinking colons |
| teardown | reverse cascade to black (never opacity fade) |
| canvas redraw | ≤12fps (83ms) for hand-cranked feel |
| easing | `linear` or `steps()` **only** |
| reduced-motion | media query **and** JS `matchMedia` check; kill blinks/strobe/marquee, render final states |

### 2.6 CRT pass (mandatory, dark screens)

```css
body::after{content:"";position:fixed;inset:0;pointer-events:none;z-index:99;
  background:
    repeating-linear-gradient(0deg,rgba(0,0,0,.22) 0 1px,transparent 1px 3px),
    radial-gradient(ellipse at center,transparent 55%,rgba(0,0,0,.55) 100%)}
```

---

## 3. Component catalog

Grouped atoms → forms → data display → feedback → navigation → patterns. Each notes **provenance** (source file) and, where the user gave one, a **verdict**: ✅ user-confirmed "must have / like"; ⚠️ liked with a requested change (the gallery shows the refined version).

### 3.1 Atoms

| Component | Provenance | Notes |
|---|---|---|
| **Stamp / chip** | universal | `.stamp` = 1px box, radius 2px. Variants: outline (default), `.blink` (in progress), `.fill` (inverse black-on-hue); colorway via `currentColor`. |
| **Legend** ✅ | sonnet-37 | Row of small boxed kanji+EN swatches keying every status color below it. "Must have." |
| **Button** ✅ | exp-01 | Ghost outline default; `.primary` = mint outline + **blinking selected state** (`btnblink`); `.alt` = orange. Hover fills. Focus-visible = paper/mint outline offset. "Selected state = blinking." |
| **7-seg clock** ✅ | exp-01 | Inline SVG hex-segment digits. Two skins: **orange countdown** (glow) and **black-on-mint timestamp chip** (`.timechip` on `--paper`). "Clock is nice." |
| **Metadata block** | universal | Mono `KEY:VALUE`, corner-pinned, `--orange` keys / `--amber` values, leading ~1.35. |
| **Section divider** | form-02, lp | Numbered `01` orange tab + kanji + title + gradient rule — only for real sequences. |
| **Kanji masthead stamp** | dashboard-01, sonnet-18 | Boxed Mincho glyph + tiny EN caption as a logo/monogram. |

### 3.2 Form controls (the MUI-equivalent set)

All share: `--bg` field, 1px `--green-dim` idle border → `--mint` glow on focus; `.field.error` = red border + `.err` message; labels are kanji+EN with `.req` red asterisk and right-aligned `.hint`.

| Control | Provenance | Notes |
|---|---|---|
| **Text input** | form-01 | uppercase, mint caret, placeholder `--green-dim` |
| **Textarea + char telemetry** | form-01 | counter `000/280`, hot(amber)/over(red) thresholds |
| **Custom dropdown (listbox)** ✅ | form-01/02 | native `<select>` popup **replaced** with ARIA combobox + `<ul role=listbox>`; kanji-paired options; active row = mint inversion; hidden input carries value; full keyboard (↑↓/Enter/Esc); mouse-close never steals focus |
| **Radio priority chips** | form-01 | boxed stamp chips, checked = colorway inversion; per-priority hue (routine/elevated/critical) |
| **Checkbox** (single + inline group) | form-02 | 18px box, mint ✓ on check |
| **Switch** | form-02 | 52×24 track, thumb slides + glows, ON/OFF text reflects |
| **Slider** (single) | form-02 | native range restyled; `--fill` gradient track, tall thin thumb, tabular readout |
| **Dual-thumb range** | form-02 | two stacked ranges + fill span, ordered (no crossover) |
| **Number stepper** | form-02 | −/+ orange buttons flanking a spinner-stripped number |
| **Segmented toggle group** | form-02 | joined buttons, checked = mint inversion, optional sub-labels |
| **Autocomplete tag input** | form-02 | chips + typeahead `role=listbox`, Enter adds / Backspace removes |
| **Rating** (hazard blocks) | form-02 | 5 diagonal-hatch blocks lit by colorway; used for autonomy/risk |
| **Date / time segments** | form-02 | mono numeric cells, auto-advance, `/` and `:` separators |
| **File dropzone** | form-02 | dashed border, kanji drop glyph, drag state, file list w/ remove |
| **Password + reveal / input adornment** | form-02 | prefix/suffix `.fix` cells + SHOW/HIDE toggle in a shared focus ring |
| **Readiness / progress meter** | form-02 | live segmented completion meter as a form's signature |
| **Actions + teletype receipt** | form-01/02 | blinking primary + ghost; submit prints a dot-leader receipt and flips the header state stamp |

### 3.3 Data display

| Component | Provenance | Verdict / refinement |
|---|---|---|
| **Segmented bar meter + threshold** ✅ | sonnet-12/15, dashboard | vertical/horizontal LED segments (never continuous fill), colored per zone; a labeled threshold rule rides across. "Like this bar graph." |
| **Gauge trio** ✅ | sonnet-32, dashboard-03, lp-01 | radial arc / horizontal bar / vertical columns — three geometries, one grammar. "Like all 3 graph cards." |
| **Negative-space stat card** ✅ | sonnet-15 | one big value/kanji with generous black space + small caption. "Use of negative space is nice." |
| **Line / trend chart** ⚠️ | sonnet-18 | mirrored panels + canvas polyline. **Requested:** remove the excessive `+` grid marks, richer line. Gallery version: sparse baseline dots, glowing polyline **with gradient area fill + leading dot**. |
| **Waveform separator** ⚠️ | exp-06 → dashboard-02 | braided sinusoid band as a section separator. **Requested:** remove tetris bricks, improve wave. Canonical = the refined dashboard-02 version (edge-tapered braid, no blocks). |
| **Scan-lattice separator** ✅ | exp-04, lp-01 | rounded-diamond street grid + orange crosshair target, used as a landing divider. "Can be a separator between sections." |
| **Terminal / log** ✅ | sonnet-20, exp-03 | amber-on-black, two brightness levels, dash-rule section headers, dot-leader `… OK/FAIL` status column, boxed CAUTION stamp exception, blinking cursor, teletype entry. "This is what I want the terminal to look like." |
| **Marquee** ⚠️ | sonnet-28, lp-01 | stepped horizontal ticker between red rules. "Good marquee, a bit worse than the other alerts" → keep for ambient status; prefer the alert overlay for true alarms. |
| **Roster/unit grid + legend** ✅ | sonnet-37 | small boxed status cards in a grid, keyed by a legend; click selects → telemetry rail; OFFLINE inverts. "Must have." |
| **OODA / pipeline stepper** | dashboard-02, wiki | chamfered nodes joined by connectors; done=mint fill, now=blinking blue. Numbered because the loop is a real sequence. |

### 3.4 Feedback

| Component | Provenance | Verdict |
|---|---|---|
| **Alert overlay / Y-N prompt** ✅ | exp-02, dashboard-01 DECIDE | full-bleed red, hazard stripes, giant EN word in a black band, boxed JP stamps, corner ALERT chips, **response footer** where the user answers (APPROVE/DENY/DEFER). Kanji intentionally off-center per the reference. "Like the evacuate & impact… like the footer." |
| **Modal (double-frame card)** ⚠️ | exp-10, form cards, sonnet-38 | chamfered double frame, kanji+EN header, teal rule, metadata, focal content. sonnet-38 "too busy" → cap modals at one focal job, push secondary data to a rail. |
| **Receipt / confirmation** | form-01/02 | dot-leader teletype rows appended after submit; last row is a mint fill state. |
| **Inline validation** | forms | `.field.error` red border + directive `.err` copy. |

### 3.5 Navigation

| Component | Provenance | Verdict |
|---|---|---|
| **Sidebar nav** ✅ | dashboard-01, sonnet-34, wiki | stacked boxed items, kanji-on-top / EN-below, current = mint inversion. Left+right rails (wiki/sonnet-34). "Like the left and right sidebar." |
| **Filter rail** ✅ | sonnet-35, dashboard-03 | scope buttons that **dim** non-matching rows (grayscale + opacity) rather than removing them. "Like the filter functionality." |
| **Breadcrumb** | wiki | `A › B › here`, orange separators, mint current. |
| **TOC scroll-spy** | wiki | sticky right-rail list, active section highlighted via IntersectionObserver. |
| **Top nav + clock** | lp-01 | sticky orange-ruled bar, diamond brand mark, blinking-colon clock, integrity stat chip. |
| **Wikilink + preview card** | wiki | `[[LINK]]` inline buttons with hover/focus popcards; the knowledge-view signature. |

### 3.6 Structural patterns

| Pattern | Provenance | Notes |
|---|---|---|
| **Frame shell** | dashboard-0{1,2,3}, sonnet-34 | one chamfered double-frame per screen; internal zones divided by 1px rules, **not** separate floating panels. `grid-template-areas` layout. |
| **Panel / card** | exp-01, universal | black fill + 1–2px orange border + faint inset glow; hero cards chamfer 1–2 corners. Never elevation. |
| **Dashboard tile** | dashboard-03 | titled zone (`.zone-title` orange, green-dim underline) holding a meter/list/feed. |
| **Hazard alarm frame** | sonnet-34, dashboard-03 | `frame[data-mode=alert]` swaps border to red + hazard strip when any child is critical. |

---

## 4. Audit summary

**Files reviewed:** 8 pages + 34 experiments + 23 references · **Palette drift:** 0 (tokens identical everywhere) · **Score: 92/100.**

### Consistency wins
- Token block copy-pasted verbatim across all files — zero hardcoded-hex drift in shipped pages.
- `.stamp`, `.blink`, CRT pass, zero-size-viewport guard, and `prefers-reduced-motion` handling appear in every file.
- form-01/02 controls already reuse one field/error/label grammar.

### Issues found → recommendations
| Issue | Where | Recommendation |
|---|---|---|
| `.blink` name collision | wiki uses `.blink` for a *backlink card*; everywhere else `.blink` = the **animation**. | Rename backlink card to `.backlink`. |
| Two clock implementations | dashboard-01 (orange 7-seg) vs dashboard-02/03 (black-on-mint chip) | Both are valid **skins** of one component — document as `timechip[data-skin]`, share the SVG factory. |
| Line chart `+` grid too dense; line too plain | sonnet-18 | Ship the refined version (sparse marks + area-fill glow) — done in gallery. |
| Wave "tetris bricks" | exp-06 | Removed in dashboard-02 refined wave — make that the canonical separator. |
| Modal busyness | sonnet-38 | Cap modals at one focal job, push secondary data to a rail. |
| Marquee vs alert overload | sonnet-28 | Marquee = ambient status only; true alarms use the overlay. |
| Light "document" theme orphaned | sonnet-17 | User confirmed it clashes (reads dark-mode-only). Keep the system **dark-only** unless a `--blueprint` variant is formally specced. |

### Priority actions
1. Extract the shared shell (frame + sidebar + clock + terminal + tokens) into one `nerv.css` + `nerv.js` so pages stop copy-pasting ~200 lines each.
2. Canonicalize the two clock skins and the refined wave/line-chart into that shared layer.
3. Rename the wiki `.blink` backlink to remove the animation-name collision.

---

## 5. Do / Don't

| ✅ Do | ❌ Don't |
|---|---|
| Black bg; hierarchy from border + glow + hue | Gray elevation surfaces, soft drop shadows |
| ALL-CAPS condensed display + mono data | Lowercase UI chrome, humanist body for controls |
| Solid hue fill + black content for active/selected | Tinted/translucent hover-active states |
| Box every status word; blink = in-progress | Floating unboxed badges |
| Pair kanji with a small EN caption | Untranslated kanji as decoration |
| Stepped/instant motion, hard blinks | Eased springs, fades, blurred transitions |
| Number only real sequences | Decorative 01/02/03 markers |
| One signature element per screen | Maximalism everywhere (see sonnet-38) |
| Respect reduced-motion; keep final states | Motion that hides information when stilled |
| Reuse the token block verbatim | New hex values per component |

---

## 6. File provenance map

| Deliverable pattern | Canonical source |
|---|---|
| tokens, CRT, stamp, blink | any shipped page (identical) |
| frame shell + zones | `dashboard-03.html`, `experiment-sonnet-34.html` |
| header + orange 7-seg clock | `dashboard-01.html`, `experiment-01.html` |
| black-on-mint clock chip | `dashboard-02.html` |
| full form-control set | `form-02.html` (superset of `form-01.html`) |
| terminal | `experiment-sonnet-20.html` |
| gauge trio | `experiment-sonnet-32.html`, `dashboard-03.html` |
| segmented meter + threshold | `experiment-sonnet-12.html`, `dashboard-01.html` |
| line/trend chart | `experiment-sonnet-18.html` (refine) |
| wave separator | `dashboard-02.html` (refined exp-06) |
| scan-lattice separator | `experiment-04.html`, `landing-page-01.html` |
| roster grid + legend | `experiment-sonnet-37.html` |
| filter rail | `experiment-sonnet-35.html` |
| alert / Y-N prompt | `experiment-02.html`, `dashboard-01.html` |
| marquee | `experiment-sonnet-28.html` |
| sidebar (L/R rails) | `experiment-sonnet-34.html`, `wiki.html` |
| wikilink + preview | `wiki.html` |
