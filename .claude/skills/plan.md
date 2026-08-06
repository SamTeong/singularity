# Plan — Left filter rail for the `harness-usage-report` HTML report

> Self-contained. Written for a fresh session with no prior context.
> Read "Instructions for the next agent" (bottom) first.

## Context

The `harness-usage-report` skill generates an interactive HTML report of Claude Code / Codex /
Ollama session cost and token usage. It has global filters — timeframe presets
(`7d`/`30d`/`all`), a custom date range, and a harness multi-select — but they live in the
scrolling hero content (`sources/hero.html` L9-10) and scroll out of view. Once you are deep
in the report there is no way to see *whether* the numbers are filtered, let alone change the
filter without scrolling back to the top. The sticky `.topbar` holds only the brand mark and
theme toggle.

Additionally, the custom date-range inputs already exist and are already wired
(`#from`/`#to`, `onDateChange` app.js L830-835) but their container is rendered
`display:none` — a built feature no user can reach.

Outcome: global filters become permanently reachable from a left-edge rail that costs zero
content width, shows active filter state at rest, and can be pinned open. Harness-specific
rate-limit cards start respecting the harness filter.

## Where the code lives

Skill root (**edit here**):
`C:\Users\sate\.agents\skill-scopes\harness\.claude\skills\harness-usage-report\scripts\`

Read-only mirror (**do NOT edit**):
`C:\Users\sate\.harness\config\skills\.referenced-skills\harness-usage-report\`

| Concern | File | Key lines |
|---|---|---|
| Assembler, section HTML constants, sidebar JS | `render.mjs` | `render()` L359-379; `render_scripts()` L335-349; `_build_sessions_json()` L155-182; `SIDEBAR_JS` L270-315; `RATE_LIMITS_HTML` L215-224 |
| Doc skeleton, `{{STYLE}}` slot, topbar, section slots | `sources/base.html` | topbar L8; section list L9-20 |
| All CSS (design tokens + rules) | `sources/style.css` | `:root` tokens L1-32, dark override L33-44; `.wrap` L66; pill/legend chrome L160-215; `.topbar` L285-300; `.secnav` L308-378 |
| Hero markup, filter containers | `sources/hero.html` | `#rangeBar`, `#datePickers` L9-10 |
| Client JS (1075 lines) | `sources/app.js` | `filterSessions` L582; `render(range)` L702-810; `onDateChange` L830-835; `initControls` L836-846; `H_ACTIVE` L850; `renderHarnessBar` L851-864; `_toggleH` L864; `showTY` L981; `main` L1065-1075 |

**How filtering works today:** `render_scripts()` injects `var SESSIONS=[...]` (one row per
session, fields `{ts,sid,cost,model,disp,in,out,cr,cc,tok,dur,api,la,lr,r5,r7,turns,tools,hour,dow,facets?}`).
A filter change re-runs `filterSessions()` → `aggregate()` → reassigns `.innerHTML` on ~30
mount points. No charting library — all charts are hand-rolled inline SVG strings. No row
show/hide, no diffing.

## Decisions already made by the user — do not re-litigate

1. **At rest the rail shows a quiet state badge** (not invisible, not a thin accent bar).
2. **Globals only in the rail.** `#model-filter`, `#tok-legend`, `#ty-legend`, `#road-filter`
   stay inline in their own panels.
3. **Pinned on a narrow viewport: overlay the content.** No layout shift, no `.wrap` margin rule.
4. Additional requirement from the user: the harness-specific rate-limit panels
   ("claude models only", "ollama cloud models only", "codex models only") must **hide/show
   with the harness filter**.

## Design

Mirror of the existing `.secnav` section-nav sidebar (`style.css` L312-313, `render.mjs`
`SIDEBAR_JS` L270-315) but left-anchored. **Reuse its chrome and localStorage pattern** rather
than inventing new ones. `.secnav` is `position:fixed; right:1.1rem` — the left gutter is
completely free, and `.wrap` is `max-width:1080px; margin:0 auto`, so a fixed left rail costs
zero content width.

**Three states:**

1. **At rest** — 44px column, `opacity:.35`, showing live filter state:
   ```
   ┌────┐
   │ 7D │   active range: 7D / 30D / ALL / ●● (custom)
   │●●○ │   one dot per harness, filled = active (none active = all filled)
   └────┘
   ```
2. **Revealed** — expands to a 216px panel on `:hover` of a 24px invisible hit strip, on
   `:focus-within`, or on click. Pure CSS `:hover` on the container — **no `mousemove` listener**.
3. **Pinned** — a pin button toggles `.pinned` (stays expanded, `opacity:1`), persisted in
   `localStorage` key `insights-filterrail-v1`, with `aria-pressed` reflecting state.

Pinned + narrow viewport → the panel overlays the left edge of the cards. (Reference math: the
216px panel begins overlapping `.wrap` below ~1435px viewport width, given
`max-width:1080px; padding:0 clamp(18px,4vw,40px)`. No breakpoint needed since we overlay.)

## Edits

### 1. Rail markup + mechanics — `render.mjs`

- New `FILTERRAIL_HTML` const near `SIDEBAR_HTML` (~L265): the hit strip, the at-rest badge
  column (`.fr-badge`, `.fr-dots`), the pin `<button>`, and the panel containing
  `id='rangeBar'` and `id='datePickers'` moved in. `#harnessBar` needs no markup — app.js
  inserts it.
- New `FILTERRAIL_JS` const near `SIDEBAR_JS` (~L275): open/close + pin persistence **only**.
  It does not own filter state. Reuse `.secnav`'s Escape / click-outside pattern, scoping each
  check to `!rail.contains(e.target)` so the left rail and right secnav do not interfere.
- `render(c)` (~L359): add `FILTERRAIL: FILTERRAIL_HTML` to the `_fill()` call.
- `RATE_LIMITS_HTML` (L215-224): add `data-harness="claude|codex|ollama"` to each of the 8
  harness-specific `<div class='card rv'>` wrappers and to the 4 token-yield toggle buttons
  (`#tybtn-7d`, `#tybtn-5h` → `claude`; `#tybtn-ollama-wk` → `ollama`; `#tybtn-codex-wk` → `codex`).
  Use `data-harness`, **not** `data-h` — `data-h` is already the harness *filter button* hook
  (`button[data-h]`, app.js L861).

The 8 harness-specific cards: Claude 5h/7d utilization, Ollama utilization, Codex weekly quota,
Claude forecast, Ollama forecast, Codex weekly-quota forecast, Claude window-balance, Ollama
window-balance.

### 2. Mount point — `sources/base.html`

Add a `{{FILTERRAIL}}` slot **immediately after the `.topbar` div (L8), before `{{HERO}}`** —
not next to `{{SIDEBAR}}` at the end of `<body>`. Fixed positioning decouples visual placement
from DOM order, and this puts filters early in tab order (theme toggle → filters → hero →
sections → secnav) instead of behind the entire page like the section-nav.

### 3. Remove the old filter placement — `sources/hero.html`

Delete the `#rangeBar` and `#datePickers` `<div>`s (L9-10). Dropping the inline
`style='display:none'` on `#datePickers` is a deliberate behaviour change: the date range
becomes reachable.

`.range-bar{margin:14px 0 4px}` (`style.css` L379-383) becomes dead once the containers move —
delete it or repurpose it for the panel; do not orphan it. Verify hero spacing still reads
correctly: `.shead`'s bottom margin (L95) and the first `.card`'s top margin (L136) now carry
the rhythm alone.

### 4. CSS — `sources/style.css`

Add the `.filterrail*` block next to `.secnav` (L308-378). Use existing tokens only:
`--surface`, `--card-brd`, `--card-shadow`, `--line`, `--clay`, `--ink-soft`, `--r-lg`,
`--r-pill`, `--s*`, `--mono`.

Reuse **verbatim** — write no new pill styles: `.range-preset`, `.range-preset.active`,
`button.lg-item`, `button.lg-item.off`, `.lg-all`, `.lg-all.active`, `.lg-swatch`,
`.filter-lbl`, and the shared chrome block at L169-183.

Panel-local overrides needed (216px is narrower than the old hero strip):
```css
.fr-body #rangeBar,.fr-body #harnessBar{display:flex;flex-direction:column;align-items:stretch;gap:6px}
.fr-body #rangeBar .range-preset,.fr-body #harnessBar .lg-item,.fr-body #harnessBar .lg-all{width:100%;justify-content:flex-start}
.fr-body #datePickers{display:flex;flex-direction:column;gap:6px}
```

Hiding class — the existing rule is `.rsec.is-hidden{display:none}` (L376), scoped to `.rsec`,
so it will **not** hide a `.card`. Extend that one rule instead of adding a parallel class:
```css
.rsec.is-hidden,.card.is-hidden{display:none}
```

Reduced motion — append `.filterrail-panel,.filterrail-rail` to the existing selector list at
L378; do not add a second media query.

`z-index:50`, matching `.topbar` and `.secnav`. No conflict: the rail is vertically centred and
`#glow` is `z-index:-1`.

### 5. Harness-gated panels — `sources/app.js`

New `syncHarnessPanels()`:

```
for el of document.querySelectorAll('[data-harness]'):
    el.classList.toggle('is-hidden', H_ACTIVE.size > 0 && !H_ACTIVE.has(el.dataset.harness))
```

Empty `H_ACTIVE` = "all", so nothing hides — matches existing filter semantics
(`filterSessions` L582).

Call it from `render(range)` (L702) alongside `renderHarnessBar(range)`. `render()` is the
single funnel: the harness click handler `_toggleH(id, range)` (L864) already calls it.

**Edge case to handle:** if the active token-yield view belongs to a hidden harness (harness
filter = ollama only, but `#tybtn-7d` (claude) is the active TY view), fall through to the
first visible `[data-harness]` toggle. One line at the end of `syncHarnessPanels()`.

Also add `syncFilterBadge(range)` — populates `.fr-badge` / `.fr-dots` from the active preset
and `H_ACTIVE`, and updates the rail's `aria-label` (e.g. `"Filters: 7 days, all harnesses"`).
Call it from the same place in `render()`.

**No change** to `initControls` (L836-846), `onDateChange` (L830-835), `applyPreset`, or
`renderHarnessBar` (L851-864). All resolve targets via `getElementById`, which is
DOM-location-agnostic, and `#harnessBar` is inserted via
`bar.insertAdjacentHTML('afterend', …)` relative to `#rangeBar` — so it follows `#rangeBar`
into the rail automatically. Re-parenting is zero JS change for the existing wiring.

## Accessibility

- Pin button: `aria-pressed` toggled with `.pinned`.
- Rail toggle: `role="button" tabindex="0"`, `aria-expanded`, `aria-controls`, and a
  state-bearing `aria-label` updated by `syncFilterBadge`. (`.secnav-rail` at `render.mjs` L266
  omits `aria-expanded` — a pre-existing gap; do not copy it.)
- Panel: `role="region" aria-label="Filters"`. Do **not** copy `.secnav-panel`'s
  `role='menu'`/`menuitem` — the panel holds real `<button>` / `<input type=date>` controls.
- Add `aria-pressed` to the rail's `.range-preset` / `.lg-item` / `.lg-all` buttons, which
  currently signal state via CSS class only. Report-wide gap; fix it here since these become
  always-visible controls.
- Keyboard: Escape closes when unpinned; pinned ignores Escape.
- 44px minimum touch target for the rail and the pin button — `.secnav-rail`'s 26px is below
  the minimum; do not inherit that.

## Verify

1. Regenerate the report via the skill's documented entrypoint (confirm it from the skill's
   `SKILL.md`; `scripts/render.mjs` is the assembler) and open the output HTML in a browser.
2. Rail: at rest shows `7D` + harness dots at low opacity. Mouse to the left edge → panel
   expands. Move away → collapses. Click pin → stays open; reload → still pinned.
3. Filters still work from the rail: click `30d` → all reactive sections re-render with
   different numbers; click a harness → same. Date inputs are visible and change the range.
4. Harness gating: select **ollama only** → Claude and Codex rate-limit / forecast /
   window-balance cards disappear, Ollama ones remain, and the token-yield toggle lands on an
   Ollama view rather than a hidden Claude one. Deselect all → everything returns.
5. Narrow the window to ~1300px with the rail pinned → the panel overlays the left edge of the
   cards; layout does not shift or reflow.
6. The right-hand `.secnav` still opens, drags, and eye-toggles independently; Escape in one
   panel does not close the other.
7. Keyboard-only: Tab from the theme toggle reaches the rail before the hero content;
   Enter/Space opens it; every filter control is reachable and announces its pressed state.
8. Toggle dark mode with the rail open — the panel picks up `--surface` / `--card-brd`; no
   hardcoded colours.

## Risk to confirm during implementation

The 8 harness-specific cards were reported with ids of the form `#sec-ratelimits`,
`#sec-ollama-util`, `#sec-forecast`, … — the same `sec-*` prefix the secnav eye-toggle uses for
`.rsec` sections (`el('sec-'+name)`, `render.mjs` L305). **Before gating, confirm which
elements those ids are actually on.** Gate via the new `data-harness` attribute on the
`.card.rv` wrappers regardless, so the eye-toggle and the harness filter never fight over the
same `.is-hidden` class on the same element.

## Out of scope

- Print styles: none exist today; `#glow` / `.topbar` / `.secnav` already render at fixed
  position in PDF export. The rail inherits that pre-existing gap. A
  `@media print{#glow,.secnav,.filterrail,.topbar{display:none}}` drive-by is a separate ask.
- Moving `#model-filter` into the rail (needs rewiring — it only re-draws the breakdown panel
  today).
- URL-hash filter state for shareable filtered views.

---

# Instructions for the next agent

1. **Read this whole file first.** It is self-contained; the exploration is already done and
   the user's design decisions are recorded above. Do not re-explore the report from scratch
   and do not re-ask the four decisions in "Decisions already made by the user".
2. **Edit the skill-scopes copy**, not the `.harness\config\...\.referenced-skills\` mirror.
   Paths are in "Where the code lives".
3. **Verify the two flagged unknowns before writing the corresponding code:**
   - the actual elements carrying the `#sec-*` ids on the harness-specific cards (see "Risk to
     confirm"),
   - the skill's documented regeneration command, from its `SKILL.md`.
4. **Order of work** — each step leaves the report renderable, so you can eyeball as you go:
   1. `render.mjs`: `FILTERRAIL_HTML` + `FILTERRAIL_JS` + the `_fill()` key.
   2. `base.html`: the `{{FILTERRAIL}}` slot after the topbar.
   3. `style.css`: the `.filterrail*` block, the `.card.is-hidden` extension, the
      reduced-motion selector.
   4. `hero.html`: remove `#rangeBar` / `#datePickers`; drop the now-dead `.range-bar` rule.
   5. `app.js`: `syncFilterBadge()` + `syncHarnessPanels()`, both called from `render()`.
   6. `render.mjs`: `data-harness` attributes on the 8 cards + 4 TY toggles.
5. **Constraints:** Node stdlib only, no new dependencies, no charting library. Reuse the
   existing CSS tokens and pill classes — do not author new pill styles. Keep the diff
   surgical: nothing outside the files and functions named above.
6. **Run the verification checklist** in "Verify" and report which steps passed and which did
   not, with actual output. Do not report done on an unrun check.
7. Do not commit unless asked.
