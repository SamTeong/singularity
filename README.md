# Singularity

Local web UI to run + steer multiple Claude Code agents. Browser + loopback Node daemon.
See `PLAN.md` for full design and phase plan.

## Run

```
pnpm bootstrap       # first-time: generate .env (detects CLAUDE_BIN) + install + start
pnpm install         # once
pnpm start           # build web + serve on http://127.0.0.1:4317
```

Dev (live-reload web):
```
pnpm dev             # daemon (127.0.0.1:4317) + Vite (127.0.0.1:5317) → open :5317
```
Vite proxies `/ws` + all REST to the daemon. Run pieces separately with `pnpm server` / `pnpm web`.

## Features

- **Agents** — spawn/steer live `claude` PTY sessions per repo (cwd picker + recent list), status dots, kill, per-agent turns/tokens (parsed from the session `.jsonl`).
- **Reattach** — survives daemon restart: agents load as `detached`; ⟳ runs `claude --resume <id>` (or a fresh `--session-id` if no conversation was logged).
- **Claude processes** (🧠) — task manager: lists all `claude.exe`, classifies tracked / stale / external, kill stale/orphaned ones.
- **Config** — edit the 3 `settings.json` scopes (user / project / project-local) with JSON lint + `.bak` backup; user scope read-only by default (guardrail).
- **Memory** — cross-project search + markdown editor over `~/.claude/projects/*/memory/*.md`, writes confined to memory dirs.
- **Cron jobs** — schedule prompts on a cron expression (UTC), skip a fire if the previous run is still active, auto-kill the session once it goes idle.
- **Tasks board** — kanban over git-worktree task sessions (one worktree + branch + agent per card) with a workflow prompt, plus a history view of concluded tasks.
- **Session history** — browse/search every Claude Code transcript on the machine, and chat over a past session, streamed via the daemon.
- **Wiki** — read-only recursive `.md` browser + search over a chosen root (default `~/wiki`).
- **Usage** — Claude + Ollama Cloud usage meters (5h/7d limits).

## Security

Daemon binds loopback **only** — it spawns `claude` with full FS access. Never bind `0.0.0.0`.

Optional token (defense-in-depth): set `SING_TOKEN=<secret>` — data endpoints + WS then require it
(`x-sing-token` header / `?token=`); the daemon injects it into the served shell so the UI works transparently.

## Notes

- `CLAUDE_BIN` must be an **absolute path** in `.env` — the daemon does no PATH resolution (Windows node-pty needs a real exe path). `pnpm bootstrap` detects it for you; otherwise set it by hand.
- App data (registry, tasks, cron jobs, picker roots) lives under `SINGULARITY_HOME` (set in `.env`; `pnpm bootstrap` defaults it to `~/.singularity`). Git worktrees + ticket requirements/plans (`.worktrees/`, `.tickets/<id>/`) live at the repo root, or `SING_TRUSTED_ROOT` if set (trusted, gitignored) so Claude honors the repo's permission rules.
- Per-agent cost is shown as **turns + total tokens**, not `$` — accurate dollar cost needs per-model pricing; use your spend tooling for that.
- The UI theme (`@zapac/mui-theme`) is vendored as a tgz in `vendor/`, so `pnpm install` works anywhere — no external path dependency.
