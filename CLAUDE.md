# Singularity — Claude Code Configuration

Local web UI — control plane for a fleet of coding agents (spec-driven dev). Browser shell + loopback Node daemon (Fastify + ws).

## Run

```
pnpm install         # deps + postinstall
pnpm start           # build web + serve on http://127.0.0.1:4317
pnpm dev             # daemon (:4317) + Vite (:5317); browse 127.0.0.1:5317
pnpm dev-mock        # UI only, no daemon/.env: Vite (:5317) + in-browser mock backend
pnpm test            # node --test --test-force-exit "server/*.test.mjs" "web/src/**/*.test.mjs"
pnpm test:e2e-mock   # build:mock + parallel Playwright suite in e2e-mock/
```

Before finishing code changes: `pnpm lint && pnpm test`.

- `pnpm build`/`pnpm start` take ~20s+: run with `run_in_background` (or `timeout: 300000`).
- Use mock mode for UI-only work, and `pnpm dev` when a change touches daemon behaviour.
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
- `.claude/rules/deck-invariants.md`: `github-pages/**` (deck React/CSS3DObject contract, `three` import limit, BASE_URL, no-WebGL fallback)

Not auto-loaded. Read when the trigger applies:
- `.claude/rules-reference/worktree-workflow.md`: before branch-scoped or multi-session feature work (worktree under `.worktrees/`, like Tasks do; its `.env` needs its own `SINGULARITY_HOME` + `DAEMON_PORT`/`VITE_PORT`/`E2E_PORT`/`E2E_MOCK_PORT`)
- `.claude/rules-reference/setup-and-layout.md`: first-time setup, env vars, repo layout, runtime probes

Backlog is installed locally; run commands from its instructions as `pnpm exec backlog <command>`.

<!-- BACKLOG.MD GUIDELINES START -->
<!-- backlog.md-instructions-version: 1.53.0 -->
<CRITICAL_INSTRUCTION>

## Backlog.md Workflow

This project uses Backlog.md for task and project management.

**At the beginning of each conversation in this project, run `backlog instructions overview` before answering or taking action. Re-read it only if you have not read it yet in the current conversation.**

Use the overview to decide whether to search, read, create, or update Backlog tasks.

Before task lifecycle actions, read the matching detailed guide:
- `backlog instructions task-creation` before creating or splitting tasks
- `backlog instructions task-execution` before planning, changing status or assignee, adding a plan or implementation notes, or implementing task work
- `backlog instructions task-finalization` before checking acceptance criteria, writing final summaries, or moving tasks to terminal statuses

Use `backlog <command> --help` before running unfamiliar commands. Help shows options, fields, and examples.

Do not edit Backlog task, draft, document, decision, or milestone markdown files directly. Use the `backlog` CLI so metadata, relationships, and history stay consistent.

</CRITICAL_INSTRUCTION>
<!-- BACKLOG.MD GUIDELINES END -->

<!-- groma:start -->
## Groma

Groma is installed locally; run its commands as `pnpm exec groma <command>`.

This project uses Groma. Before you scan, inspect, or curate architecture, or change files for a Backlog task, run `groma agent-instructions` and read the guide it names for that job. When it reports a first scan, ask the user whether they want you to curate the architecture. Do not edit Groma-owned architecture files directly.
<!-- groma:end -->
