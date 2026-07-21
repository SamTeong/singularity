# Singularity

One control plane for your whole fleet of coding agents for spec-driven development.

## Run

```
pnpm bootstrap       # run on first setup to generate .env (CLAUDE_BIN is detected) + install + start
pnpm install         # installs dependencies, runs postinstall hook
pnpm postinstall     # mac: run if agents fail with "posix_spawnp failed"
pnpm start           # build web + serve on http://127.0.0.1:4317
```

Dev (with live-reload web):

```
pnpm dev             # daemon (127.0.0.1:4317) + Vite (127.0.0.1:5317) → browse UI at 127.0.0.1:5317
```

Vite proxies `/ws` and all REST requests to daemon. Run components separately with `pnpm server` / `pnpm web`.

## License

MIT

## Features

- **Sessions** — manage and interact with live agent PTY sessions.
- **Tasks** — kanban board over git-worktree task sessions (worktree + branch + session per card).
- **Automation** — *Scheduled* jobs with cron expression (UTC) and *Background* job which picks up task by various criteria from defined tasks.
- **Usage** — displays 5h/7d usage meters and usage report.
- **Config** — view and edit `settings.json` and `settings.local.json`.
- **Hooks** — view and edit hooks.
- **Skills** — view skills (grouped or ungrouped).
- **Rules** — view and edit rules.
- **Memory** — view and edit project memory.
- **Transcripts** — view transcripts.
- **Wiki** — view wiki with linked pages.
- **Claude processes** — task manager for Claude processes.
- **Light/Dark mode** — supports light and dark mode.

## Security

Daemon binds loopback **only**. It spawns agent with full file system access. Never bind `0.0.0.0`.

Optional token (defense-in-depth): set `SING_TOKEN=<secret>` — data endpoints + WS then require it
(`x-sing-token` header / `?token=`); the daemon injects it into the served shell so the UI works transparently.

## Notes

- `CLAUDE_BIN` must be an **absolute path** in `.env` — the daemon does no PATH resolution and Windows node-pty needs a real exe path. `pnpm bootstrap` detects it for you; otherwise set it by hand.
- App data (registry, tasks, cron jobs, picker roots) lives under `SINGULARITY_HOME` (set in `.env`; `pnpm bootstrap` defaults it to `~/.singularity`). Git worktrees + ticket requirements/plans (`.worktrees/`, `.tickets/<id>/`) live at the repo root, or `SING_TRUSTED_ROOT` if set (trusted, gitignored) so Claude honors the repo's permission rules.
- Per-session cost is shown as **turns + total tokens + `$`** — the dollar figure comes from the global statusline (`claude-code-usage-report` skill), the single source of truth for every session; a pricing-table estimate is the fallback when no statusline cost exists.
- The UI theme (`@zapac/mui-theme`) is vendored as a tgz in `vendor/`, so `pnpm install` works anywhere — no external path dependency.
- **`spawn failed: posix_spawnp failed`** on macOS/Linux means node-pty's `spawn-helper` prebuilt lost its execute bit (pnpm's store sometimes extracts it `0644`), so every agent spawn fails. The `postinstall` hook (`scripts/fix-pty-helper.mjs`) restores `+x` automatically after each install; run `pnpm run postinstall` by hand if it recurs. This is not related to `CLAUDE_BIN`.
