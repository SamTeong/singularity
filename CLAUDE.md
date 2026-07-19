# Singularity — Claude Code Configuration

Local web UI to run + steer multiple Claude Code agents. Browser shell + loopback Node daemon (Fastify + ws). See `README.md` for features, `PLAN.md` for design.

## Run

```
pnpm install         # once — @zapac/mui-theme is vendored (file:vendor/zapac-mui-theme-*.tgz)
pnpm start           # build web + serve on http://127.0.0.1:4317
pnpm dev             # daemon (:4317) + Vite (:5317) → open :5317; Vite proxies /ws + REST to daemon
pnpm test            # node --test "server/*.test.mjs"
```

Pieces separately: `pnpm server` / `pnpm web`. Shell: PowerShell primary; Bash tool POSIX only.

Machine-specific config — **no baked-in defaults**: `SINGULARITY_HOME`, `PORT`, `CLAUDE_BIN`, `SING_SCOPE_ROOT`, `SING_USAGE_SKILL`, `SING_USAGE_REPORTS` (optional: `OLLAMA_BIN` — absent → ollama models unavailable but daemon boots; `SING_TOKEN`). Copy `.env.example` → `.env` (gitignored) and fill in. Scripts load it via `node --env-file-if-exists=.env`; missing `.env` or any required var → daemon refuses to start (`requireEnv` in `server/index.mjs`, `SINGULARITY_HOME` enforced in `app-dir.mjs`).

## Repo structure

```
server/    daemon — Fastify routes (index.mjs) + feature modules, one *.mjs per concern, *.test.mjs co-located
web/       React + MUI + xterm shell (src/), vite.config.mjs (dev proxy :5317 → :4317), dist/ (gitignored build)
scripts/   ollama-login.mjs helper
```

Backend modules → routes in `server/index.mjs`. Add a concern = new module + route + co-located test.

**New server route → also add its prefix to the Vite dev proxy** (`web/vite.config.mjs` `server.proxy`). Dev runs on :5317 and only proxies listed prefixes to the daemon (:4317); an unlisted route (e.g. `/skills`, `/skill`) falls through to the SPA shell → `fetch().json()` throws → "failed to load X" in the browser. `apply:'serve'` keeps proxy entries dev-only (daemon serves dist directly in prod).

## State

Owned app state → `SINGULARITY_HOME` (required, no default — set in `.env`; `APP_DIR`):
- `state/` (durable): `agents.json`, `tasks.json`, `crons.json`, `ollama.json`, `cost/<session_id>.json`
- `cache/` (disposable): `usage-cache.json`, `pw-ollama-profile/`

`.worktrees/` + `.tickets/<id>/` live at the **repo root** (git-registered / gitignored), NOT under `APP_DIR` — Claude only honors repo-controllable permissions (allow-rules/hooks) for paths inside the trusted project root; external paths fire Task-permission prompts.
Single source = `server/app-dir.mjs` (`APP_DIR`/`STATE_DIR`/`CACHE_DIR`/`WORKTREES_DIR`/`TICKETS_DIR`). Route all new state through `reg` from `agents.mjs` — never hardcode `~/.singularity`. `migrate-state.mjs` (imported by `index.mjs`) moves the pre-split flat layout into `state/`+`cache/` once.

External (read-only, not owned): `~/.claude/projects` (session transcripts), `~/.claude/.credentials.json` (OAuth), `~/.agents` (spend, skill-scopes), `~/wiki` (client-chosen root).

## Security

Daemon binds **127.0.0.1 only** — spawns `claude` with full FS access. Never bind `0.0.0.0`.
Origin allowlist (daemon + Vite hosts) blocks DNS-rebinding / drive-by browser hits to loopback.
Optional `SING_TOKEN` gates data endpoints + WS (`x-sing-token` header / `?token=`); shell + assets stay open. Env-var only — app never persists it. Served into `window.__SING_TOKEN__` for the shell.

## Working rules

- `claude`/`ollama` binaries: absolute paths from `CLAUDE_BIN`/`OLLAMA_BIN` (no PATH fallback — Windows node-pty does no PATH resolution).
- Per-agent cost = turns + total tokens, not `$`. Dollar cost needs per-model pricing — use spend tooling.
- Tests redirect state with `SINGULARITY_HOME=<scratch temp>` set before a **dynamic** `import('./agents.mjs')` (static imports hoist above the env assignment; `app-dir.mjs` throws without it). Same applies to ad-hoc `node -e` scripts importing server modules — run as `node --env-file-if-exists=.env -e "..."`.
- Config editor writes 2 scopes — `settings.json` (project) + `settings.local.json` (project-local) — with `.bak` backup + JSON validate; paths derived server-side, client never supplies a path. User-level `~/.claude/settings.json` is reachable by picking root `~` (project scope resolves to it), not a separate tab.

Surgical edits and goal-driven testing are covered in `~/.claude/CLAUDE.md`.