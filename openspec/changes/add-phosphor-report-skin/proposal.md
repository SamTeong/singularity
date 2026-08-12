# Phosphor Console skin for the generated usage report

## Why

The app ships two skins — ZAPAC and Phosphor Console — and every shell surface
honors them, but the usage report does not. The report is generated HTML produced
by the `harness-usage-report` skill and embedded in an iframe, and it received only
a *recolor* for Phosphor: ~25 design-token overrides plus three rules. It keeps
ZAPAC's frosted glass, Lato display type, sentence case, soft shadows, ambient
radial glow and film grain, so a Phosphor-skinned app still shows a ZAPAC-shaped
report — the one panel in the product that visibly breaks the skin.

Three concrete defects compound this: the skin arrives too late to affect first
paint (so ZAPAC purple flashes on every generation), the CRT scanline pass renders
*behind* the content instead of over it, and ZAPAC brand hex values are hardcoded in
the chart palette where no skin can reach them.

## What Changes

- The generated report gains a **complete** Phosphor Console rendition — typography,
  chrome, controls, meters, focus treatment and CRT pass — not just a palette swap.
  ZAPAC remains the default and is unchanged.
- The report accepts its skin **at load time** from the embedding host, so the
  correct skin is present on first paint. A report opened standalone, outside the
  app, continues to render as ZAPAC.
- The CRT scanline/vignette pass moves to a layer above page content, matching the
  Phosphor design system.
- The chart series palette is decoupled from the semantic status tokens and moved
  behind CSS custom properties, removing every hardcoded brand colour from the
  report's JavaScript. ZAPAC's rendered output is unaffected by this indirection.
- The report's light/dark toggle is hidden under Phosphor, which is dark-only.
- Skin isolation gains a regression test so brand colours cannot be reintroduced
  into the shared chart code.

No behavior changes: the report's data, aggregation, filters, section ordering,
sidebar and persistence are untouched. This is presentation only.

## Capabilities

### New Capabilities
- `skin-aware-usage-report`: how the generated usage report receives the active skin
  from its host, applies it before first paint, renders the ZAPAC default and the
  Phosphor Console rendition, and keeps skin-specific colour out of shared chart
  code.

### Modified Capabilities
<!-- None. The app shell's skin activation, persistence and isolation
     (`phosphor-console-appearance`, `zapac-shell-appearance`) are unchanged — this
     change consumes the existing skin selection rather than altering it. -->

## Impact

**Report generator** (`.claude/skills/harness-usage-report/scripts/`)
- `sources/skin-phosphor.css` — new, the entire Phosphor rendition
- `sources/style.css` — Phosphor block removed; series/foreground tokens added
- `sources/base.html` — skin resolved before first paint
- `sources/app.js` — chart palette reads tokens; no colour literals remain
- `render.mjs` — style assembly includes the skin file
- `stats.test.mjs` — skin-isolation regression test
- `assets/example-report.html` — regenerated

**App** (`web/src/features/usage/UsageReportView.jsx`)
- Passes the active skin and colour mode to the iframe at load, alongside the
  existing post-load sync that handles live switching.

**Not affected:** the daemon (`server/usagereport.mjs` serves the file and forwards
unknown query parameters unchanged), the skin registry and resolver, the vendored
theme packages, and the report's zero-network guarantee — Phosphor's display face is
a system font stack, so no webfont is added.
