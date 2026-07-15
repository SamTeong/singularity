# Singularity — Claude Code Configuration

Local web UI to run + steer multiple Claude Code agents. Browser shell + loopback Node daemon (Fastify + ws). See `README.md` for features, `PLAN.md` for design.

## Run

```
npm install          # once — needs local @zapac/mui-theme tarball (file:../_references/...), not portable
npm start            # build web + serve on http://127.0.0.1:4317
npm run dev          # daemon (:4317) + Vite (:5317) → open :5317; Vite proxies /ws + REST to daemon
npm test             # node --test "server/*.test.mjs"
```

Pieces separately: `npm run server` / `npm run web`. Shell: PowerShell primary; Bash tool POSIX only.

## Repo structure

```
server/    daemon — Fastify routes (index.mjs) + feature modules, one *.mjs per concern, *.test.mjs co-located
web/       React + MUI + xterm shell (src/), vite.config.mjs (dev proxy :5317 → :4317), dist/ (gitignored build)
scripts/   ollama-login.mjs helper
```

Backend modules → routes in `server/index.mjs`. Add a concern = new module + route + co-located test.

## State

Owned app state → `~/.singularity` (`APP_DIR`, override `SINGULARITY_HOME`):
`agents.json`, `tasks.json`, `crons.json`, `worktrees/`, `tickets/<id>/`, `cost/<session_id>.json`.
Route all new state through `reg.APP_DIR` from `agents.mjs` — never hardcode `~/.singularity`.

External (read-only, not owned): `~/.claude/projects` (session transcripts), `~/.claude/.credentials.json` (OAuth), `~/.agents` (spend, skill-scopes), `~/wiki` (client-chosen root).

## Security

Daemon binds **127.0.0.1 only** — spawns `claude` with full FS access. Never bind `0.0.0.0`.
Origin allowlist (daemon + Vite hosts) blocks DNS-rebinding / drive-by browser hits to loopback.
Optional `SING_TOKEN` gates data endpoints + WS (`x-sing-token` header / `?token=`); shell + assets stay open. Env-var only — app never persists it. Served into `window.__SING_TOKEN__` for the shell.

## Working rules

- `claude` binary resolved from PATH at daemon start (Windows node-pty needs a real exe). Override `CLAUDE_BIN=<path>`.
- Per-agent cost = turns + total tokens, not `$`. Dollar cost needs per-model pricing — use spend tooling.
- Tests redirect state with `SINGULARITY_HOME=<scratch temp>` set before importing `agents.mjs`.
- Config editor writes 3 `settings.json` scopes (user / project / project-local) with `.bak` backup + JSON validate; paths derived server-side, client never supplies a path.

Surgical edits and goal-driven testing are covered in `~/.claude/CLAUDE.md`.