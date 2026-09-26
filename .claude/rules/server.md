---
paths:
  - "server/**"
---

# Server rules

## State
- All owned state goes under `SINGULARITY_HOME` (`APP_DIR`, no default). The single source is `server/app-dir.mjs` (`APP_DIR`/`STATE_DIR`/`CACHE_DIR`/`WORKTREES_DIR`/`TICKETS_DIR`). Route new state through `reg` from `agents.mjs`. Never hardcode `~/.singularity`.
- `state/` is durable: `agents.json`, `tasks.json`, `crons.json`, `background.json`, `models.json`, `ollama.json`, `projects.json` (Projects view repo list), plus picker roots (`config-roots`, `hook-roots`, `memory-root`, `rules-roots`, `sessions-root`, `skills-roots` (+ legacy `skills-root`), `wiki-root` `.json`). `cache/` is disposable (`pw-ollama-profile/`, `projects-summary/`).
- `.worktrees/` + `.tickets/<id>/` live at `TRUSTED_ROOT`, not `APP_DIR`. Claude honors repo allow-rules and hooks only inside the trusted root; external paths trigger Task permission prompts.
- `migrate-state.mjs` (imported by `index.mjs`) moves the old flat layout into `state/` + `cache/` once.
- External and read-only: `~/.claude/projects` (transcripts), `~/.claude/.credentials.json`, `~/.agents` (spend, skill-scopes), `~/wiki`. One exception: `model-prices.mjs` writes the usage-report skill's `pricing.json` (its only rate source, Settings ▸ Models ▸ Prices).

## Models
`state/models.json` (Settings ▸ Models) drives picker suggestions, client spawn classification (`web/src/lib/models.js`), server spawn routing (`models.mjs` via `model-store.mjs`), and the History summariser (any enabled entry, any group). `model-store.mjs` seeds it from the shipped arrays; Restore defaults re-merges missing shipped ids. History has two tiers: the configured summariser, else deterministic bullets. There is no implicit fallback LLM. Summarisers append declawed's Phase 2 (rewrite) rules to the prompt when `~/.agents/skills/declawed/SKILL.md` exists.

## Binaries, cost, config
- `claude`/`ollama`: always absolute paths from `CLAUDE_BIN`/`OLLAMA_BIN`. There is no PATH fallback, because Windows node-pty does no PATH resolution.
- Per-agent cost = turns + total tokens, plus `$` from the global statusline (`harness-usage-report` skill). `stats.mjs:readCostFile` reads `~/.agents/.harness-usage-report/state/cost-state/<id>.json` (`cost.total_cost_usd`) and honors `USAGE_REPORT_STATE`. One statusline, one store: no per-task override, no parallel capture script. `est_cost_usd` is only a pricing-table fallback.
- The config editor writes `settings.json` + `settings.local.json` with a `.bak` backup and JSON validation. Paths are derived server-side; the client never supplies a path. User-level `~/.claude/settings.json` = pick root `~`.

## Security detail
`SING_TOKEN` (env only, never persisted) gates data endpoints, WS and the shell. It is accepted as the `x-sing-token` header, `?token=`, or the `sing_token` HttpOnly cookie; a `?token=` hit mints the cookie and 302s the token out of the URL. Assets stay open. The token is served into `window.__SING_TOKEN__`. The unknown-GET fallback (`setNotFoundHandler`) must serve through `sendShell`, never a bare `sendFile`, or deep-link reloads 401.

## Tests
Set `SINGULARITY_HOME=<scratch temp>` before a **dynamic** `import('./agents.mjs')`. Static imports hoist above the assignment, and `app-dir.mjs` throws without it. Ad-hoc scripts that import server modules run as `node --env-file-if-exists=.env <script>`.

## Gotcha: restart drops registry
The restart route spawns the new daemon, then the old one `persist()`s `agents.json` on drain, after the new one already loaded it. So rows can vanish. When probing after a restart, read the live WS `list`, never `agents.json`.
