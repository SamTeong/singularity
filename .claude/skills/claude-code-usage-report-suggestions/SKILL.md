---
name: claude-code-usage-report-suggestions
description: Audit and improve the Claude Code Usage Report pipeline end-to-end — collection, CSV schema, aggregation, report/visualizations. Produces a prioritized roadmap; implements chosen items by editing claude-code-usage-report's scripts. Read-only until approved. Node stdlib only, runs locally.
disable-model-invocation: true
metadata:
  version: 1.0.0
---

# claude-code-usage-report-suggestions

Companion to `claude-code-usage-report` (single responsibility: that skill *collects*/*visualizes*; this skill *improves* the whole pipeline). Two modes: **advise** (default — prioritized roadmap) and **implement** (on request — make the change).

`SKILL_DIR` = this skill's directory. Runs via `node`. claude-code-usage-report is a sibling — its `scripts/stats.mjs` is resolved next to this skill (no hardcoded install path) and read as the data layer. No hooks of its own; only reads claude-code-usage-report's data, invoked by claude-code-usage-report's report.

## Pipeline it covers (audit each layer)

1. **Collection** — statusline stashes full statusline JSON to `~/.agents/.claude-code-usage-report/state/cost-state/<sid>.json` (see claude-code-usage-report's capture contract; reference statusline at `claude-code-usage-report/scripts/statusline.mjs`); SessionEnd hook `stats.mjs record` projects it + transcript-derived fields into `stats.csv` and archives raw JSON to `~/.agents/.claude-code-usage-report/state/sessions.jsonl`.
2. **Schema/storage** — `stats.csv` columns + the `facets_json` blob (tools, errors, agents, skills, cwd/branch, compactions).
3. **Aggregation** — `_load_stats()` parses rows into `sessions` (+ `totals`/`usage` tallies for the roadmap); day/month/model aggregates are re-derived client-side from the embedded payload.
4. **Visualization** — `report` renders the self-contained HTML (KPIs, charts, heatmaps, tables).

## Steps

### Advise (default)
1. Generate the roadmap (introspects local data + current coverage): `node <SKILL_DIR>/scripts/improve.mjs roadmap` (`--json` for machine-readable output — what `claude-code-usage-report` calls to embed its "Usage roadmap" section).
2. Read the output. Each item tagged:
   - `available` — data on disk, not yet charted (highest leverage).
   - `partial` — captured forward-only; coverage grows as sessions record.
   - `idea` — viz/UX improvement.
3. Present roadmap grouped by pipeline layer; recommend top 2–3 by value-for-effort. Look beyond the script's catalog — inspect `stats.mjs` and a freshly rendered report for concrete gaps (missing axis labels, dense sections, slow queries).

### Implement (only when the user picks items)
4. For each chosen item, edit the relevant layer in `claude-code-usage-report`:
   - new transcript metric → extend `parse_transcript` + `_merge_facets` (retroactive via backfill).
   - new statusline field → `_extract_state` + the user's statusline (forward-only; reference at `claude-code-usage-report/scripts/statusline.mjs`).
   - new column → `HEADER`/`COLS` + both row builders.
   - new chart/stat → add a `svg*`/`*Bars`/`barChart`/aggregator in `sources/app.js` + wire into its client-side `render()`; add the section shell + any new embedded field in `render.mjs`.
   - update the roadmap catalog in `improve.mjs` so the item flips to "done"/drops off.
5. Verify end-to-end (back up `stats.csv` first):
   - `cp ~/.agents/.claude-code-usage-report/state/stats.csv <scratch>/stats.csv.bak`
   - `node <claude-code-usage-report>/scripts/stats.mjs backfill` → confirm `with_cost` count preserved.
   - `node <claude-code-usage-report>/scripts/stats.mjs report` → confirm new output renders, light+dark.
   - Node smoke-test embedded JS if touched.

## Notes
- Read-only until the user approves an edit. Never run `backfill` without backing up `stats.csv` first (it rewrites the file; a join bug can drop live-recorded cost).
- Keep `claude-code-usage-report` lean — implementation edits land in its files, not new responsibilities here.