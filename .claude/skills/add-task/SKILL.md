---
name: add-task
description: Create a task card on the Singularity Tasks board (kanban) by POSTing to the running daemon's /tasks route. Use when an agent needs to enqueue a new orchestrated task — a feature, fix, or chore that spawns its own git worktree + Claude session that plans, implements, reviews, and (optionally) auto-merges. Triggers on "add a task", "create a task on the board", "enqueue a task", "put this on the Tasks page".
metadata:
  version: 1.0.0
---

# add-task

Create a task on the Singularity board. The daemon (`server/tasks.mjs` `createTask`)
makes a git worktree + branch off the repo's current HEAD, spawns a Claude session
seeded with the workflow prompt, and drops the card in the **todo** column. The
session drives itself through plan → implement → review → done via `POST /tasks/:id/status`.

## Prerequisites

The daemon must be running (default `http://127.0.0.1:$PORT`, `PORT=4317`). Read
`PORT` and `SING_TOKEN` from the project `.env` — never hardcode the token. If
`SING_TOKEN` is set, every data request needs the `x-sing-token` header.

## Create

`POST /tasks` — body maps straight to `createTask`. Fields:

| field | required | meaning |
|-------|----------|---------|
| `repo` | yes | working directory (task cwd). A git repo → runs in a worktree; else edits in place. |
| `title` | yes | card title. |
| `description` | yes | the requirements — written to `state/tickets/<short>/Requirements.md`. Make it detailed; the session plans from this. |
| `model` | — | orchestrator model (`opus`/`sonnet`/`haiku`/ollama id). |
| `scopes` | — | skill-scope names to expose (e.g. `["coding","design"]`), dirs under `SING_SCOPE_ROOT`. |
| `tags` | — | free-form labels (normalized: trimmed, lowercased, deduped). |
| `implModel` / `reviewerModel` | — | override the impl/reviewer subagent models (default claude split: impl=sonnet, reviewer=opus). |
| `requirePlanApproval` | — | `true` → session pauses for human plan approval before coding. |
| `mergeMode` | — | git tasks only: `"auto"` (merge branch → base on review PASS) or `"manual"` (leave branch, default). |
| `background` | — | `true` → unattended background prompt (no clarifying/approval/review dance). |
| `conclude` | — | background only: `"done"` (auto-conclude) or `"inreview"` (hand to human, default). |

Response: `{ ok: true, task: { id, sessionId, column, ... } }`, or `400 { ok:false, error }`.

## Example

Multi-line descriptions quote badly — write the body to a JSON file and `--data @file`:

```bash
# read PORT + token from .env, build the payload, POST it
node --env-file-if-exists=.env -e '
  const body = {
    repo: "C:/git/singularity",
    title: "Short imperative title",
    description: "## Requirements\n\nDetailed markdown the session plans from.",
    model: "opus",
    scopes: ["coding", "design"],
    tags: ["feature"],
    mergeMode: "auto",
  };
  require("fs").writeFileSync(process.env.TEMP + "/task.json", JSON.stringify(body));
'
curl -s -X POST "http://127.0.0.1:$PORT/tasks" \
  -H "x-sing-token: $SING_TOKEN" \
  -H "content-type: application/json" \
  --data @"$TEMP/task.json"
```

The card then moves itself; watch it on the Tasks page or `GET /tasks`.

<!-- ponytail: thin wrapper over one POST. If task shapes proliferate, add a
     scripts/add-task.mjs helper — until then the inline node+curl is enough. -->
