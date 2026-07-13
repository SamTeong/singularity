# Singularity

Local web UI to run + steer multiple Claude Code agents. Browser + loopback Node daemon.
See `PLAN.md` for full design and phase plan.

## Run

```
npm install          # once
npm start            # build web + serve on http://127.0.0.1:4317
```

Dev (live-reload web):
```
npm run dev          # daemon (127.0.0.1:4317) + Vite (127.0.0.1:5317) → open :5317
```
Vite proxies `/ws` + all REST to the daemon. Run pieces separately with `npm run server` / `npm run web`.

## Features

- **Agents** — spawn/steer live `claude` PTY sessions per repo (cwd picker + recent list), status dots, kill, per-agent turns/tokens (parsed from the session `.jsonl`).
- **Reattach** — survives daemon restart: agents load as `detached`; ⟳ runs `claude --resume <id>` (or a fresh `--session-id` if no conversation was logged).
- **Claude processes** (🧠) — task manager: lists all `claude.exe`, classifies tracked / stale / external, kill stale/orphaned ones.
- **Config** — edit the 3 `settings.json` scopes (user / project / project-local) with JSON lint + `.bak` backup; user scope read-only by default (guardrail).
- **Memory** — cross-project search + markdown editor over `~/.claude/projects/*/memory/*.md`, writes confined to memory dirs.

## Security

Daemon binds loopback **only** — it spawns `claude` with full FS access. Never bind `0.0.0.0`.

Optional token (defense-in-depth): set `SING_TOKEN=<secret>` — data endpoints + WS then require it
(`x-sing-token` header / `?token=`); the daemon injects it into the served shell so the UI works transparently.

## Notes

- `claude` binary is PATH-resolved at daemon start (Windows node-pty needs a real exe path). Override with `CLAUDE_BIN=<path>`.
- App data (registry + recent repos) lives in `%APPDATA%\singularity\agents.json`.
- Per-agent cost is shown as **turns + total tokens**, not `$` — accurate dollar cost needs per-model pricing; use your spend tooling for that.
