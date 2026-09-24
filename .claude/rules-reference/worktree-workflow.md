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
    Copy-Item C:/git/singularity/.env C:/git/singularity/.worktrees/<slug>/.env
    pnpm install   # run with cwd = the worktree

- Use a `feat/`, `fix/` or `docs/` branch prefix, never `task/` (that prefix belongs to the Tasks board).
- Keep the worktree inside `TRUSTED_ROOT`. Claude honors repo allow-rules and hooks only there; outside it, Task permission prompts fire.
- Give subagents absolute worktree paths. Run git as `git -C <worktree>`.
- Clean up: `git -C C:/git/singularity worktree remove .worktrees/<slug>`.

## Not a skill

No skill creates a bare worktree. `add-task` POSTs to `/api/tasks` and creates a whole Task card: worktree plus its own spawned Claude session that plans, implements, reviews and can auto-merge. Use it only when you want the board to own the work. The `EnterWorktree` tool creates its own worktree location and does not follow the `.worktrees/` convention.
