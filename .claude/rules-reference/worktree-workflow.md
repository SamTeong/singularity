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

## Worktree `.env`: avoid port and state clashes

The main checkout's dev app (`pnpm --dir C:/git/singularity dev`) owns daemon `:4317`, Vite `:5317` and `SINGULARITY_HOME=~/.singularity`. A worktree copy of `.env` must change three keys:

| Key | Main | Worktree (+10 per extra worktree) | Why |
|---|---|---|---|
| `DAEMON_PORT` | 4317 | 4327 | daemon listen port; also Vite's proxy target (`web/vite.config.mjs:11`) |
| `VITE_PORT` | 5317 | 5327 | Vite dev port (`strictPort`, so a clash fails at startup) |
| `SINGULARITY_HOME` | `~/.singularity` | `~/.singularity-wt-<slug>` | must differ (see below) |

Both ports feed the daemon's origin allowlist (`SELF_HOSTS`, `server/index.mjs:185`), so changing them in `.env` keeps browser requests working. No other config needs editing.

**Never share `SINGULARITY_HOME` between two daemons.** Each daemon runs `crons.json` (jobs would fire twice) and persists `agents.json`/`tasks.json`/`background.json` (each would overwrite the other's). To seed the new home, copy only `state/models.json` and `state/*-root*.json`; never copy agents, tasks, crons or background.

```powershell
$wt = 'C:\git\singularity\.worktrees\<slug>'; $h = "$HOME\.singularity-wt-<slug>"
(Get-Content C:\git\singularity\.env) -replace '^SINGULARITY_HOME=.*',"SINGULARITY_HOME=$h" `
  -replace '^DAEMON_PORT=.*','DAEMON_PORT=4327' -replace '^VITE_PORT=.*','VITE_PORT=5327' | Set-Content "$wt\.env"
New-Item -ItemType Directory -Force "$h\state" | Out-Null
Get-ChildItem "$HOME\.singularity\state" -File | ? { $_.Name -eq 'models.json' -or $_.Name -like '*-root*.json' } | Copy-Item -Destination "$h\state"
```

`SING_TRUSTED_ROOT` stays unset, so it defaults to the worktree itself, and Tasks created from the worktree's UI nest under `<worktree>/.worktrees/`.

## Running from a worktree

| Command (PowerShell) | URL / port |
|---|---|
| `pnpm --dir C:/git/singularity/.worktrees/<slug> dev` | http://localhost:5327 (daemon :4327) |
| `$env:VITE_PORT=5337; pnpm --dir <wt> dev-mock` | http://localhost:5337. `dev-mock` doesn't load `.env`, so without the override it takes 5317 and clashes with main |
| `pnpm --dir <wt> test` | no ports |
| `$env:E2E_MOCK_PORT=4183; pnpm --dir <wt> test:e2e-mock` | preview :4183 (default 4173) |
| `$env:E2E_PORT=4329; pnpm --dir <wt> test:e2e` | sandbox daemon :4329 (default 4319) |

Override the e2e ports only when another checkout's suite runs at the same time. `pnpm dev` from a worktree never touches the main daemon, so it's safe even when this session runs inside main's :4317.

- Use a `feat/`, `fix/` or `docs/` branch prefix, never `task/` (that prefix belongs to the Tasks board).
- Keep the worktree inside `TRUSTED_ROOT`. Claude honors repo allow-rules and hooks only there; outside it, Task permission prompts fire.
- Give subagents absolute worktree paths. Run git as `git -C <worktree>`.
- Clean up: `git -C C:/git/singularity worktree remove .worktrees/<slug>`, then delete `~/.singularity-wt-<slug>`.

## Not a skill

No skill creates a bare worktree. `add-task` POSTs to `/api/tasks` and creates a whole Task card: worktree plus its own spawned Claude session that plans, implements, reviews and can auto-merge. Use it only when you want the board to own the work. The `EnterWorktree` tool creates its own worktree location and does not follow the `.worktrees/` convention.
