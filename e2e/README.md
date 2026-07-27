# e2e suite

Playwright coverage of the web UI, driven against a **sandbox daemon** — its own
port, its own `SINGULARITY_HOME`, its own trusted root, seeded fixture corpora,
and a keepalive stub for `CLAUDE_BIN`. Nothing here can reach the user's real
`:4317` daemon, `~/.claude`, `~/wiki`, or spawn a real `claude` turn.

```
pnpm test:e2e        # build web/dist, then run everything
pnpm test:e2e:ui     # interactive, reuses the dist already on disk
pnpm exec playwright test e2e/wiki.spec.mjs    # one spec, no rebuild
```

## Layout

| file | role |
|---|---|
| `../playwright.config.mjs` | serial (`workers: 1`), bundled chromium, `webServer: node e2e/serve.mjs` |
| `serve.mjs` | wipes + seeds the sandbox, then boots the daemon with an explicit env |
| `fixtures/paths.mjs` | sandbox layout constants + fixture ids — import these, never hard-code a path |
| `fixtures/seed.mjs` | writes the corpora and the `state/*.json` root files |
| `fixtures/test.mjs` | **import `test`/`expect` from here**, plus `onceConfirm` |
| `helpers/nav.mjs` | `goto` / `gotoView` / `setSkin` / `visible` |

## Writing a spec

```js
import { test, expect } from './fixtures/test.mjs';
import { goto, gotoView, visible } from './helpers/nav.mjs';
import { WORKSPACE_DIR } from './fixtures/paths.mjs';

test('does the thing', async ({ page }) => {
  await page.goto('/');
  await goto(page, 'Wiki');            // rail vs More-menu handled for you
  await expect(page.getByRole('button', { name: 'Refresh' })).toBeVisible();
});
```

Two fixtures ride along automatically:

- **`consoleGuard`** fails any test that logged a console error/warning or threw.
  Widen per-test with `consoleGuard.allow(/regex/)` (request the fixture to reach it).
- **`stubNetwork`** intercepts `/status` and `/usage`, which otherwise hit the
  live internet. Payloads are `STATUS_STUB` / `USAGE_STUB` in `fixtures/test.mjs`.

## Selector rules

1. **`getByRole` first.** Persistent views (Config, Hooks, Rules, Memory, Wiki,
   Transcripts) stay mounted with `display:none` after their first visit, and
   `display:none` drops out of the accessibility tree — so role queries ignore
   hidden panels for free. Text and CSS queries do not: wrap those in
   `visible(...)` from `helpers/nav.mjs`.
2. **No `data-testid`.** MUI stamps `data-testid="<Name>Icon"` on `SvgIcon` in
   development only; the suite drives the production bundle, where it is gone.
   Icon-only buttons are reachable by their Tooltip title, which MUI turns into
   an `aria-label` (`More`, `Refresh`, `Remove from list`, `Clear search`…).
3. Task cards expose the task title as their accessible name.
4. Don't add `data-testid` to app code for a test — find the accessible name, or
   say the element is genuinely unreachable.

## Confirms

Native `window.confirm` gates the destructive flows (task conclude/delete, cron
delete, "Discard unsaved changes?"). Register **before** the click:

```js
import { onceConfirm } from './fixtures/test.mjs';
const msg = onceConfirm(page, true);          // or false to dismiss
await page.getByRole('button', { name: 'Delete' }).click();
expect(await msg).toMatch(/delete/i);
```

## What the sandbox contains

Seeded by `fixtures/seed.mjs`, all paths exported from `fixtures/paths.mjs`:

- **Transcripts / Memory** — `PROJECTS_DIR`: `workspace-alpha` (30 sessions, so
  the 25-per-page default has a second page) + `workspace-beta` (a rich
  multi-tool transcript titled *Retry backoff cap*, `RICH_SESSION`). Memory
  markdown lives under `<project>/memory/`.
- **Wiki** — `WIKI_DIR`: one wiki, `handbook`, three interlinked pages.
- **Skills** — `SKILLS_DIR`: grouped layout, scopes `coding` (`lint-guard`) and
  `design` (`color-audit`). The tree renders collapsed.
- **Config / Hooks / Rules** — `WORKSPACE_DIR` with `.claude/settings.json`,
  `settings.local.json`, two hook scripts, two rule files.
- **Tasks** — four cards, one per column, titled `Seeded <column> card`, tagged
  `fixture`/`ui`; two history rows.
- **Automation** — two crons and two background jobs, all **disabled**, with
  far-future expressions.
- `SCRATCH_DIR` is a non-git dir — a task created there gets `kind: 'plain'`, so
  no worktree and no branch.

`CLAUDE_BIN` and `OLLAMA_BIN` both point at the keepalive stub, so
`/capabilities` reports both backends available and neither can start a real
turn. `SING_SCOPE_ROOT`, `SING_USAGE_SKILL` and `SING_USAGE_REPORTS` stay unset —
skill-scopes and the usage report render their not-configured states, which the
specs assert.

Wiki **categories are derived from a page's folder**, not its frontmatter
(`category(p.rel)` in WikiPanel.jsx) — the category filter only appears when the
corpus has pages in subdirectories.

Mutations are real: a Save writes the file under `e2e/.tmp/corpus/...` and a spec
may assert it with `node:fs`. The sandbox is rebuilt from scratch on every boot,
so specs must not depend on another spec's writes.

## Never drive these

They have no safe path even in the sandbox:

- **New session / Resume / Duplicate / Fork / Restart** on a session row — real
  `claude` spawn, and `ensureTrusted` writes the user's real `~/.claude.json`.
- **"Run now"** on a cron or background job — starts a real agent run.
- **Processes ✕ / "Stop all leftover"** — `POST /procs/kill` kills real machine
  PIDs by number, and the bulk button has no confirmation.
- **Restart server** (More ▸ Restart) — kills the daemon under the test.
- **"Open in external terminal"** — detach-spawns `wt.exe` outside the browser.
- **Transcripts → Chat → Send** and **usage report → Generate** — real model call
  / real skill run.
- Accepting the **"Restart sessions to match the new theme?"** dialog — fires
  `respawnAll`. Dismiss it.

## Developing several specs at once

The suite is serial and the sandbox is a single directory, so two concurrent
`playwright test` runs would fight over port 4319 and over `e2e/.tmp`. Set
`E2E_PORT` to give a run its own port *and* its own `e2e/.tmp-<port>`:

```sh
E2E_PORT=4321 pnpm exec playwright test e2e/wiki.spec.mjs
```

Use `playwright test`, not `pnpm test:e2e` — the latter rebuilds `web/dist`,
which every parallel run shares.
