# Singularity — Claude Code Configuration

Local web UI — control plane for a fleet of coding agents (spec-driven dev). Browser shell + loopback Node daemon (Fastify + ws).

## Run

```
pnpm bootstrap       # first setup: generate .env (detects CLAUDE_BIN) + wire usage-report skill + install + start
pnpm install         # installs dependencies, runs postinstall hook. @zapac/mui-theme is vendored (file:vendor/zapac-mui-theme-*.tgz)
pnpm postinstall     # mac: run if agents fail with "posix_spawnp failed"
pnpm start           # build web + serve on http://127.0.0.1:4317
pnpm build           # build web only (vite build → web/dist); run before serving with `pnpm server`
pnpm dev             # daemon (:4317) + Vite (:5317) → browse UI at 127.0.0.1:5317; Vite proxies /ws + REST to daemon
pnpm test            # node --test-force-exit "server/*.test.mjs"
pnpm clean           # reap orphan esbuild/vite procs (fixes build hangs before a fresh build)

pnpm dev-mock        # UI only, no daemon: Vite (:5317) with an in-browser mock backend
pnpm build:mock      # mock build → web/dist-mock (never touches web/dist)
pnpm test:e2e-mock   # build:mock + the parallel Playwright suite in e2e-mock/
```

**Mock mode needs no `.env` and no daemon.** `--mode mock` sets `VITE_MOCK=1`, which switches on `web/src/mock/` — a Mirage server answering every REST route plus a `mock-socket` `/ws` — so the whole UI runs against in-memory fixtures. Nothing reads `SINGULARITY_HOME`, `CLAUDE_BIN`, or the user's `~/.claude`. Use it for UI work; use `pnpm dev` when the change touches daemon behaviour.

Pieces separately: `pnpm server` (daemon) / `pnpm web` (Vite dev server only — no build). Shell: PowerShell primary; Bash tool POSIX only.

`pnpm build`/`pnpm start` run the production build (~20s warm, longer cold) — run with `run_in_background` (or `timeout: 300000`); the default 120s timeout always fires and auto-backgrounds it.

Machine-specific config — **no baked-in defaults**: `SINGULARITY_HOME`, `DAEMON_PORT`, `CLAUDE_BIN` are REQUIRED; `OLLAMA_BIN` (absent → ollama models unavailable), `SING_SCOPE_ROOT` (absent → no skill-scopes; skills viewer auto-detects flat `~/.claude/skills` + `<project>/.claude/skills` vs grouped), `SING_TRUSTED_ROOT` (absent → default = this clone), `SING_USAGE_SKILL`/`SING_USAGE_REPORTS` (absent → usage-report degrade silently; `/capabilities` reports them), `SING_TOKEN` are OPTIONAL — daemon boots without any. MCP (lean-ctx) is auto-detected, not required. `pnpm bootstrap` generates a `.env` with these filled (detects `CLAUDE_BIN`) for first-time setup. Scripts load it via `node --env-file-if-exists=.env`; missing `.env` or any required var → daemon refuses to start (`requireEnv` in `server/index.mjs`, `SINGULARITY_HOME` enforced in `app-dir.mjs`).

## File structure

```
server/    daemon — Fastify routes (index.mjs) + feature modules, one *.mjs per concern, *.test.mjs co-located
web/       React + MUI + xterm shell (src/), vite.config.mjs (dev proxy :5317 → :4317), dist/ (gitignored build)
  src/
    features/     one dir per surface — appearance, automation, config, config-hooks,
                   explorer, history, memory, palette, processes, rules, sessions,
                   settings, skills, status, tasks, transcripts, usage, wiki
    components/   shared widgets (panelkit, Sparkline, CmEditor, …)
    shell/        AppShell + AppMenu (lazy-loads each feature)
    hooks/        React data hooks (useAgents, useSysStats, …)
    lib/          small utilities
    providers/    context providers
    theme/        MUI theme
    mock/         mock backend (dev-mock + e2e-mock only) — server.js (Mirage) + routes/
                   one-per-concern, ws.js (mock-socket /ws), db.js + fixtures.js (seed
                   corpora), index.js (startMock). Tree-shaken out of the prod bundle.
e2e/       Playwright suite driving every UI flow against a throwaway sandbox daemon
e2e-mock/  sibling Playwright suite driving the same flows against web/src/mock (parallel)
scripts/   bootstrap.mjs (first setup), demo-tasks.mjs, fix-pty-helper.mjs (postinstall +x),
           ollama-login.mjs, reap-build-orphans.mjs (pnpm clean)
vendor/    vendored tgz deps (@zapac/mui-theme) so install works offline
assets/    screenshots
```

Backend modules → routes in `server/index.mjs`. Add a concern = new module + route + co-located test.

The HTTP API lives under `/api` (e.g. `POST /api/tasks`); `/ws`, `GET /`, and `/assets/*` stay at the root. The Vite dev proxy forwards the whole `/api` prefix in one entry, so a new route needs no proxy edit.

**New server route → one more edit, mandatory:**

**Add a handler to `web/src/mock/routes/`.** Mirage is configured to throw on any unhandled request, so a route the client gains but the mock lacks fails the whole mock suite loudly — that's the intended drift alarm, not a flake. Match the daemon's exact response shape (several routes return bare arrays or keyed objects with no `ok`), and broadcast the matching WS frame if the daemon does.

## State

Owned app state → `SINGULARITY_HOME` (required, no default — set in `.env`; `APP_DIR`):
- `state/` (durable): `agents.json`, `tasks.json`, `crons.json`, `background.json`, `ollama.json`, plus per-user picker roots — `config-roots.json`, `hook-roots.json`, `memory-root.json`, `rules-roots.json`, `sessions-root.json`, `skills-roots.json` (+ legacy `skills-root.json`), `wiki-root.json`
- `cache/` (disposable): `usage-cache.json`, `pw-ollama-profile/`

`.worktrees/` + `.tickets/<id>/` live at `TRUSTED_ROOT` (default = this clone; override via `SING_TRUSTED_ROOT` in `.env`), NOT under `APP_DIR` — Claude only honors repo-controllable permissions (allow-rules/hooks) for paths inside the trusted project root; external paths fire Task-permission prompts.
Single source = `server/app-dir.mjs` (`APP_DIR`/`STATE_DIR`/`CACHE_DIR`/`WORKTREES_DIR`/`TICKETS_DIR`). Route all new state through `reg` from `agents.mjs` — never hardcode `~/.singularity`. `migrate-state.mjs` (imported by `index.mjs`) moves the pre-split flat layout into `state/`+`cache/` once.

External (read-only, not owned): `~/.claude/projects` (session transcripts), `~/.claude/.credentials.json` (OAuth), `~/.agents` (spend, skill-scopes), `~/wiki` (client-chosen root).

## Security

Daemon binds **127.0.0.1 only** — spawns `claude` with full FS access. Never bind `0.0.0.0`.
Origin allowlist (daemon + Vite hosts) blocks DNS-rebinding / drive-by browser hits to loopback.
Optional `SING_TOKEN` gates data endpoints + WS (`x-sing-token` header / `?token=`); shell + assets stay open. Env-var only — app never persists it. Served into `window.__SING_TOKEN__` for the shell.

## Working rules

- `claude`/`ollama` binaries: absolute paths from `CLAUDE_BIN`/`OLLAMA_BIN` (no PATH fallback — Windows node-pty does no PATH resolution).
- Per-agent cost = turns + total tokens, plus `$` from the **global statusline** (`harness-usage-report` skill, `~/.claude/settings.json`) — the single source of truth for every session, foreground and task/background. `server/stats.mjs:readCostFile` reads `~/.agents/.harness-usage-report/state/cost-state/<id>.json` (full payload, `cost.total_cost_usd`); honors `USAGE_REPORT_STATE`. No per-task statusline override, no parallel capture script — one statusline, one store. Token estimates (`est_cost_usd`) are the pricing-table fallback only.
- Tests redirect state with `SINGULARITY_HOME=<scratch temp>` set before a **dynamic** `import('./agents.mjs')` (static imports hoist above the env assignment; `app-dir.mjs` throws without it). Same applies to ad-hoc `node -e` scripts importing server modules — run as `node --env-file-if-exists=.env -e "..."`.
- Config editor writes 2 scopes — `settings.json` (project) + `settings.local.json` (project-local) — with `.bak` backup + JSON validate; paths derived server-side, client never supplies a path. User-level `~/.claude/settings.json` is reachable by picking root `~` (project scope resolves to it), not a separate tab.

Surgical edits and goal-driven testing are covered in `~/.claude/CLAUDE.md`.
