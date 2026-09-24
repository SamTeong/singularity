# Setup, env vars, repo layout

Not auto-loaded. Read when you need first-time setup, env vars, or where things live.

## Commands beyond the core set

```
pnpm bootstrap       # first setup: generate .env (detects CLAUDE_BIN) + wire usage-report skill + install + start
pnpm postinstall     # mac: run if agents fail with "posix_spawnp failed"
pnpm build           # build web only (vite build → web/dist); run before serving with `pnpm server`
pnpm clean           # reap orphan esbuild/vite procs (fixes build hangs before a fresh build)
pnpm server          # daemon only
pnpm web             # Vite dev server only (no build)
pnpm build:mock      # mock build → web/dist-mock (never touches web/dist)
```

`pnpm install` also runs the postinstall hook. `@zapac/mui-theme` and `phosphor-console-theme` are vendored (`file:vendor/*.tgz`), so install works offline.

## Env vars — no baked-in defaults

- REQUIRED: `SINGULARITY_HOME`, `DAEMON_PORT`, `CLAUDE_BIN`. If any is missing, the daemon refuses to start (`requireEnv` in `server/index.mjs`; `SINGULARITY_HOME` is enforced in `app-dir.mjs`).
- OPTIONAL:
  - `OLLAMA_BIN`: absent means ollama models are unavailable.
  - `SING_SCOPE_ROOT`: absent means no skill-scopes. The skills viewer auto-detects either flat `~/.claude/skills` + `<project>/.claude/skills` or the grouped layout.
  - `SING_TRUSTED_ROOT`: absent means this clone.
  - `SING_USAGE_SKILL` / `SING_USAGE_REPORTS`: absent means the usage report degrades silently; `/capabilities` reports them.
  - `SING_TOKEN`: see the Security section of CLAUDE.md.
- Scripts load `.env` via `node --env-file-if-exists=.env`.

## Layout

```
server/    daemon — Fastify routes (index.mjs) + one *.mjs per concern, *.test.mjs co-located
web/src/
  features/     one dir per surface (appearance, automation, config, config-hooks, explorer, history,
                memory, palette, processes, rules, sessions, settings, skills, status, tasks,
                transcripts, usage, wiki)
  components/   shared widgets (panelkit, Sparkline, CmEditor, TableScroller, …)
  shell/        AppShell + AppMenu + Sidebar (lazy-loads each feature), views.mjs, breakpoints.js
  hooks/ lib/ providers/ theme/
  mock/         mock backend (dev-mock + e2e-mock only; tree-shaken out of prod)
e2e/       Playwright suite vs a throwaway sandbox daemon
e2e-mock/  same flows vs web/src/mock (parallel)
scripts/   bootstrap.mjs, demo-tasks.mjs, fix-pty-helper.mjs, ollama-login.mjs, reap-build-orphans.mjs
vendor/    vendored tgz deps
docs/one-shot/  standalone HTML mockups, not built or served
github-pages/   self-contained deck with its own package.json + lockfile, deliberately OUTSIDE the root
                workspace. Install and build from inside that dir.
```

## Runtime probes

This session often runs inside the live daemon as a node-pty child, so killing or restarting :4317 (or Vite :5317) kills the session itself. Server changes go live only when the user restarts the daemon. To probe, start an isolated daemon with its own `SINGULARITY_HOME` (scratch dir) and `DAEMON_PORT` (e.g. 4599): `node --env-file-if-exists=.env server/index.mjs`, with those two vars overridden. Hard-killing a daemon doesn't orphan claude.exe children, because ConPTY teardown kills them.
