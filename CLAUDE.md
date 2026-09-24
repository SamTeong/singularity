# Singularity — Claude Code Configuration

Local web UI — control plane for a fleet of coding agents (spec-driven dev). Browser shell + loopback Node daemon (Fastify + ws).

## Run

```
pnpm install         # deps + postinstall
pnpm start           # build web + serve on http://127.0.0.1:4317
pnpm dev             # daemon (:4317) + Vite (:5317); browse 127.0.0.1:5317
pnpm dev-mock        # UI only, no daemon/.env: Vite (:5317) + in-browser mock backend
pnpm test            # node --test-force-exit "server/*.test.mjs"
pnpm test:e2e-mock   # build:mock + parallel Playwright suite in e2e-mock/
```

Before finishing code changes: `pnpm lint && pnpm test`.

- `pnpm build`/`pnpm start` take ~20s+: run with `run_in_background` (or `timeout: 300000`).
- Use mock mode for UI-only work, and `pnpm dev` when a change touches daemon behaviour.
- Shell: PowerShell primary; Bash tool POSIX only.
- `SINGULARITY_HOME`, `DAEMON_PORT`, `CLAUDE_BIN` are required in `.env` (no baked-in defaults). `pnpm bootstrap` generates it.

## Invariants

- **Never restart the live daemon (:4317) or Vite (:5317).** This session usually runs inside it. Probe with an isolated daemon (own `SINGULARITY_HOME` + `DAEMON_PORT`).
- **New server route:** add it in `server/index.mjs`, add the module, a co-located `*.test.mjs`, **and** a handler in `web/src/mock/routes/`. Mirage throws on unhandled requests.
- HTTP API lives under `/api`. `/ws`, `GET /` and `/assets/*` stay at root. The root namespace belongs to UI views (real URLs, catalog in `web/src/shell/views.mjs`).
- New state goes through `reg` (`agents.mjs`) / `server/app-dir.mjs`. Never hardcode `~/.singularity`.
- `claude`/`ollama` are invoked only via absolute `CLAUDE_BIN`/`OLLAMA_BIN` (no PATH fallback).

## Security

The daemon binds **127.0.0.1 only**, because it spawns `claude` with full FS access. Never bind `0.0.0.0`. An origin allowlist blocks DNS rebinding. Optional `SING_TOKEN` gates data, WS and the shell (details: `.claude/rules/server.md`).

## Rules index

Auto-loaded only when you touch matching files (`paths:` frontmatter):
- `.claude/rules/server.md`: `server/**` (state layout, models, cost, config editor, tests, security detail)
- `.claude/rules/web-ui.md`: `web/src/**` (routing + query state, responsive, CodeMirror, canvas)
- `.claude/rules/mock-and-e2e.md`: mock backend, `e2e/`, `e2e-mock/`

Not auto-loaded. Read when the trigger applies:
- `.claude/rules-reference/worktree-workflow.md`: before branch-scoped or multi-session feature work (worktree under `.worktrees/`, like Tasks do; its `.env` needs its own `DAEMON_PORT`/`VITE_PORT`/`SINGULARITY_HOME`)
- `.claude/rules-reference/setup-and-layout.md`: first-time setup, env vars, repo layout, runtime probes

Surgical edits and goal-driven testing are covered in `~/.claude/CLAUDE.md`.
