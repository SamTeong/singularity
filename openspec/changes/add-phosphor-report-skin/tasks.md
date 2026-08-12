## 1. Baseline

- [x] 1.1 Regenerate `assets/example-report.html` from the current sources (`node .claude/skills/harness-usage-report/scripts/render-example.mjs`) and stash a copy outside the repo as the ZAPAC reference render for the no-regression diff in 7.1

## 2. Decouple the chart palette from the status tokens

- [x] 2.1 Add `--pal-1 … --pal-8`, `--tok-in`, `--tok-out`, `--tok-cr`, `--tok-cc` and `--paper-fg` to the base `:root` block in `sources/style.css`, seeded with the exact colours those slots resolve to today (`--ac`, `--azure`, `--amber`, `--sage`, `--ink-soft`, `#aa41af`, `#3c69c8`, `#00a5e6`; `--paper-fg` = `#fff`)
- [x] 2.2 Mirror any of those tokens that differ under `:root[data-theme="dark"]` so ZAPAC dark is unchanged too
- [x] 2.3 Point `CFG.PALETTE` and `CFG.TOKEN` in `sources/app.js` at the new vars, removing `#aa41af`, `#3c69c8`, `#00a5e6`
- [x] 2.4 Replace the two treemap label `fill='#fff'` with `var(--paper-fg)` and make the treemap tile `rx`/`ry` read a token so a skin can square it (`sources/app.js`)
- [x] 2.5 Replace the four bare `#fff` in `sources/style.css` (`::selection`, `.range-preset.active`, `.lg-all.active`, `.toggle button.active`) with `var(--paper-fg)`
- [x] 2.6 Regenerate the example and confirm a byte-identical (or visually empty) diff against the 1.1 reference — this indirection must be a no-op for ZAPAC

## 3. Split the skins into separate stylesheets

- [x] 3.1 Create `sources/skin-phosphor.css` and move the existing `:root[data-skin="phosphor"]` block and its three rules out of `sources/style.css:50-82` into it, unchanged, so the split is verifiable on its own
- [x] 3.2 Update `render_style()` in `render.mjs` to return `fonts.css + style.css + skin-phosphor.css`, reusing the existing `_source()` helper, with the skin file last so its `:root[…]` selectors outrank `:root[data-theme="dark"]`
- [x] 3.3 Confirm `sources/style.css` now contains no `data-skin` selector and the Phosphor render is unchanged from before the split

## 4. Deliver the skin at load time

- [x] 4.1 Extend the inline bootstrap in `sources/base.html` to resolve the skin as `?skin=` → `localStorage['agents-report-skin']` → none, and apply the same precedence to `?theme=` over the existing theme key, keeping it ahead of the `<style>` block
- [x] 4.2 Append `&skin=${skinId}&theme=${resolved}` to `reportSrc` in `web/src/features/usage/UsageReportView.jsx` and seed the `agents-report-skin` key alongside the existing `localStorage.setItem`
- [x] 4.3 Verify the post-load `syncTheme` path still applies a live skin switch without reloading the iframe, and that a standalone-opened report with no query string still renders ZAPAC

## 5. Build the Phosphor rendition

- [x] 5.1 Write the Phosphor token block: palette from `phosphor.roles.js` with the AA-corrected red `#F04438`, `--pal-*` as mint · blue · amber · greenMap · paper · teal · amberDim · greenDim, `--paper-fg` = `var(--bg)`, `--ac` = mint, `--disp`/`--sans` = the condensed system stack, `--body` = `var(--mono)`, radii at 2px/4px, `--grain:0`
- [x] 5.2 Move the CRT pass onto `body::after` at `z-index:99` with `pointer-events:none`, and flatten `body::before` to a plain surface fill so scanlines and vignette render above content
- [x] 5.3 Remove `backdrop-filter`/`-webkit-backdrop-filter` from `.card`, `.supp`, `.eff`, `.scroll`, `.flagcard`, `.topbar`, `.secnav-panel`, `.filterrail-rail`, `.filterrail-panel`, and redefine `--card-shadow` as a 1px orange hairline plus faint inset glow
- [x] 5.4 Apply upper case and the condensed face to the heading and label classes only (`.flag h1.hl`, `.shead-title h2`, `.card h3`, `.subhead`, `.colcards h4`, `.sg-a`, `.sg-b`, `.empty-state h4`, `.eyebrow-hero`, `.numlbl`, `.flagstats .l`, `.ratio-eyebrow`, `.filter-lbl`, `.cal-lbl`, `.donut-sub`, `.tbl th`, `.fpill`, `.toggle button`), leaving prose, model ids, paths and project names in their original casing
- [x] 5.5 Give `.card`, `.flagcard`, `.scroll`, `.supp`, `.eff` the double frame (1px orange border + `::before` inset hairline at `inset:4px`, `opacity:.4`, `pointer-events:none`), and the 28px `clip-path` chamfer to `.flagcard` only
- [x] 5.6 Restyle `.fpill`, `.range-preset`, `.lg-all`, `.toggle`, `.toggle button`, `.iconbtn` as square orange-outlined controls on `var(--bg)`, with the active state inverting to a mint fill with `var(--paper-fg)` text
- [x] 5.7 Override `:focus-visible` to `2px dashed var(--amber)`, offset 2, `border-radius:0`
- [x] 5.8 Segment `.bar-track`, `.sbar-track`, `.ratio-meter` and `.sbars i` into LEDs with `mask-image:repeating-linear-gradient(…)` (vertical for `.sbars i`) and square `.bar`, `.seg` and the tracks
- [x] 5.9 Square the remaining data surfaces (`.cal .c`, `.heat .cell`, `.lg-swatch`, `.fdot`, `.donut-legend .li i`, `.swatch-legend .sw`, `.scalekey i`, `.treemap`, `.tag`, `.tbl .tag`, `.sg-b`)
- [x] 5.10 Add `text-shadow:0 0 4px currentColor` to `.flagnum`, `.ratio-val`, `.supp .v`, `.flagstats .v`, and replace `.flagnum`'s gradient-clipped text with a flat mint fill (superseding the existing `.flagnum` skin rule)
- [x] 5.11 Re-point `.sg-b.st-*`, `.note.info/.warn/.ok`, `.trend-chip[data-dir]` and `.pill .dot` at mint / blue / amber / red per the roles map, and set `scrollbar-color` to the chrome-dim pair
- [x] 5.12 Hide the report's colour-mode control under Phosphor (`#theme-tgl`)
- [x] 5.13 Add a comment in the skin file recording why `--ac` is mint rather than orange (orange is chrome-only, but the report needs a primary data hue) so it does not read as a mistake

## 6. Guard the isolation

- [x] 6.1 Extend `scripts/stats.test.mjs` with a check that `sources/app.js` contains no `#rrggbb` literal
- [x] 6.2 Extend it with a check that `render_style()` output contains `:root[data-skin="phosphor"]` and `--pal-8`

## 7. Verify

- [x] 7.1 Regenerate `assets/example-report.html` and confirm the ZAPAC render is unchanged against the 1.1 reference
- [x] 7.2 Open the example with `?skin=phosphor` and confirm Phosphor on the first frame, no ZAPAC purple, and scanlines visible over the panels
- [x] 7.3 Run the leak probe from `e2e/phosphor.spec.mjs:305-309` against the Phosphor render — walk every element counting computed `color`/`fill`/`background-color` matching `#985b9c`, `#aa41af`, `#3c69c8`, `#00a5e6`, `#cba3ea`; expect 0, with the model filter widened past five series so the overflow palette slots are exercised
- [x] 7.4 Confirm hover tooltips and scaled heatmap/calendar cells are not sheared by any panel's corner treatment
- [x] 7.5 In the app (`pnpm dev`, `127.0.0.1:5317`), confirm a live ZAPAC ↔ Phosphor switch updates the embedded report without a reload, and that Refresh reloads it with no ZAPAC flash
- [x] 7.6 Run `pnpm test` and confirm the new isolation checks pass alongside the existing suite
