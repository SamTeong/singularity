# Feature work in a git worktree

Not auto-loaded. Read before starting multi-session or branch-scoped feature work.

Do feature work in a worktree under `.worktrees/` (gitignored, `.gitignore:10`), not in the main checkout. This mirrors what the Tasks board does for its own cards.

## How Tasks create one

`server/tasks.mjs:436-445`, for a git repo:

- base branch = `git rev-parse --abbrev-ref HEAD`
- branch = `task/<id8>`
- worktree = `join(reg.WORKTREES_DIR, <id8>)`, where `WORKTREES_DIR` = `TRUSTED_ROOT/.worktrees` (`server/app-dir.mjs`)
- `git -C <repo> worktree add <worktree> -b <branch>`

## Doing it by hand for agent-led feature work

    git -C C:/git/singularity worktree add C:/git/singularity/.worktrees/<slug> -b feat/<slug>
    pnpm --dir C:/git/singularity/.worktrees/<slug> install

Then write the worktree `.env` (next section) before running anything.

## Worktree `.env`: avoid port clashes

The main checkout's dev app (`pnpm --dir C:/git/singularity dev`) owns daemon `:4317` and Vite `:5317`. A worktree's `.env` is a copy of main's with the port keys changed. Every dev and test port is read from `.env`, so no command-line overrides are needed:

| Key | Main (default) | Worktree (+10 per extra worktree) | Used by |
|---|---|---|---|
| `DAEMON_PORT` | 4317 | 4327 | daemon; Vite dev proxy target |
| `VITE_PORT` | 5317 | 5327 | `dev` and `dev-mock` (`strictPort`, so a clash fails at startup) |
| `E2E_PORT` | 4319 | 4329 | `test:e2e` sandbox daemon + its `e2e/.tmp-<port>` dir |
| `E2E_MOCK_PORT` | 4173 | 4183 | `test:e2e-mock` Vite preview |

- Both daemon and Vite ports feed the daemon's origin allowlist (`SELF_HOSTS`, `server/index.mjs:186`), so browser requests keep working.
- Mock and e2e tooling read only their port key from `.env` (`scripts/env-port.mjs`: process env, then `.env`, then the default). They stay isolated from the rest of the machine config.
- `SINGULARITY_HOME` stays the same as main's (user decision, 2026-09-24). Caveat: both daemons persist `agents.json`/`tasks.json`/`background.json` from their own in-memory registry, so the last one to write wins. If crons are enabled, both daemons would fire them. When either matters, point the worktree at its own home.
- `SING_TRUSTED_ROOT` stays unset, so it defaults to the worktree itself, and Tasks created from the worktree's UI nest under `<worktree>/.worktrees/`.

```powershell
$wt = '/c//git/singularity/.worktrees/<slug>'
(Get-Content /c//git/singularity/.env) -replace '^DAEMON_PORT=.*','DAEMON_PORT=4327' -replace '^VITE_PORT=.*','VITE_PORT=5327' |
  Where-Object { $_ -notmatch '^E2E_(MOCK_)?PORT=' } | Set-Content "$wt.env"
Add-Content "$wt.env" 'E2E_PORT=4329', 'E2E_MOCK_PORT=4183'
```

## Running from a worktree

| Command (PowerShell) | URL / port |
|---|---|
| `pnpm --dir C:/git/singularity/.worktrees/<slug> dev` | http://localhost:5327 (daemon :4327) |
| `pnpm --dir <wt> dev-mock` | http://localhost:5327. It shares `VITE_PORT` with `dev`, so run one or the other |
| `pnpm --dir <wt> test` | no ports |
| `pnpm --dir <wt> test:e2e-mock` | preview :4183 |
| `pnpm --dir <wt> test:e2e` | sandbox daemon :4329 |

`pnpm dev` from a worktree never touches the main daemon, so it's safe even when this session runs inside main's :4317.

- Use a `feat/`, `fix/` or `docs/` branch prefix, never `task/` (that prefix belongs to the Tasks board).
- Keep the worktree inside `TRUSTED_ROOT`. Claude honors repo allow-rules and hooks only there; outside it, Task permission prompts fire.
- Give subagents absolute worktree paths. Run git as `git -C <worktree>`.
- Clean up: `git -C C:/git/singularity worktree remove .worktrees/<slug>`.

## Not a skill

No skill creates a bare worktree. `add-task` POSTs to `/api/tasks` and creates a whole Task card: worktree plus its own spawned Claude session that plans, implements, reviews and can auto-merge. Use it only when you want the board to own the work. The `EnterWorktree` tool creates its own worktree location and does not follow the `.worktrees/` convention.
