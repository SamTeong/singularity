# e2e suite

Playwright coverage of the web UI, driven against a **sandbox daemon** — its own
port, its own `SINGULARITY_HOME`, its own `HOME`/`USERPROFILE`, its own trusted
root, seeded fixture corpora, and a keepalive stub for `CLAUDE_BIN`. Nothing here
can reach the user's real `:4317` daemon, `~/.claude`, `~/wiki`, or spawn a real
`claude` turn.

```
pnpm test:e2e        # build web/dist, then run everything
pnpm test:e2e:ui     # interactive, reuses the dist already on disk
pnpm exec playwright test e2e/wiki.spec.mjs    # one spec, no rebuild
E2E_BACKEND=rust pnpm exec playwright test e2e/wiki.spec.mjs   # native daemon
```

## Backends

`E2E_BACKEND` selects the daemon under test. The default is `node`, and any
other value fails before the sandbox is seeded.

| value | daemon |
|---|---|
| `node` (default) | `<E2E_NODE_ROOT>/server/index.mjs`, the reference Node implementation |
| `rust` | `rust/backend/target/{release,debug}/singularity-backend --http` — spawned directly, no Node gateway (`SINGULARITY_NATIVE_BIN` overrides the path) |

`E2E_NODE_ROOT` defaults to this checkout. Point it at another clone — for
example the pinned `main` — to run the same specs against a reference Node
daemon while comparing a native build from this worktree.

The native backend must be built first:

```sh
cargo build --release --manifest-path rust/backend/Cargo.toml
```

It serves the shell from the checkout's `web/dist`, so the same `pnpm test:e2e`
build step covers both backends. The binary is started from a sandbox cwd with
no `.env`, so a checkout's `.env` cannot re-supply the sandbox env that
`serve.mjs` deleted.

## Two suites — which one gets your spec

`e2e-mock/` is a sibling suite covering the same UI against the in-browser mock
backend (`web/src/mock/`, `playwright.mock.config.mjs`). It needs no daemon and
no `.env`, and it runs `fullyParallel` — roughly 1.5× faster than this one on the
same box.

| | `e2e/` (here) | `e2e-mock/` |
|---|---|---|
| backend | real daemon in a sandbox | Mirage + mock-socket in the page |
| proves | the daemon's own behaviour and the client↔daemon contract | UI behaviour given a response |
| execution | serial (`workers: 1`), one shared mutable sandbox | parallel, one DB per page |
| mutations | real files under `<TMP>/corpus/` | in-memory, reset per page load |
<!-- VERIFY: wave3-e2e-5 -->

**Default to `e2e-mock/`.** A spec belongs *here* only if it needs something a
mock cannot honestly stand in for:

- real filesystem effects (a Save that must land on disk as bytes)
- daemon-side logic: path resolution, `~` handling, mtime-conflict detection,
  state migration, spawn/env construction
- anything under **Never drive these** below — those stay unported entirely,
  because passing against a mock would assert nothing about them

Both suites must stay green. When a flow exists in both, keep the assertions
identical — a divergence means one of them is lying. Fixture-driven differences
are fine when documented (History renders 6 project cards here vs 7 in the mock,
because the mock seeds a populated *today* and these fixtures backdate every
session).

A new server route needs a mock handler as well as a dev-proxy prefix — see
CLAUDE.md "New server route". Mirage throws on unhandled requests, so a missing
handler fails the mock suite immediately rather than drifting silently.

## Layout

| file | role |
|---|---|
| `../playwright.config.mjs` | serial (`workers: 1`), bundled chromium, `webServer: node e2e/serve.mjs`; test output + html report under `TMP` |
| `serve.mjs` | wipes + seeds the sandbox, then boots the `E2E_BACKEND` daemon with an explicit env |
| `fixtures/paths.mjs` | sandbox layout constants, backend selection + fixture ids — import these, never hard-code a path |
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

The sandbox root is `TMP = <root>/<port>`, outside the repository. `<root>`
defaults to `<os tmp>/singularity-e2e/<checkout-id>`, where `<checkout-id>` is a
short hash of the checkout path — so two checkouts at their default port never
share (or wipe) each other's fixtures. `E2E_TMP_ROOT` replaces `<root>` verbatim.
Every run gets its own per-port directory, which `serve.mjs` wipes on boot, and
`serve.mjs` exits with a clear message if that port is already taken. Playwright
writes its `test-results/` and `playwright-report/` inside the same directory.

Seeded by `fixtures/seed.mjs`, all paths exported from `fixtures/paths.mjs`:

- **Transcripts / Memory** — `PROJECTS_DIR`: `workspace-alpha` (30 sessions, so
  the 25-per-page default has a second page) + `workspace-beta` (a rich
  multi-tool transcript titled *Retry backoff cap*, `RICH_SESSION`). Memory
  markdown lives under `<project>/memory/`.
- **Wiki** — `WIKI_DIR`: one wiki, `handbook`, three interlinked pages.
- **Skills** — `SKILLS_DIR`: grouped layout, scopes `coding` (`lint-guard`) and
  `design` (`color-audit`). The tree renders one level open — roots expanded,
  scopes collapsed.
- **Config / Hooks / Rules** — `WORKSPACE_DIR` with `.claude/settings.json`,
  `settings.local.json`, two hook scripts, two rule files.
- **Tasks** — four cards, one per column, titled `Seeded <column> card`, tagged
  `fixture`/`ui`; two history rows.
- **Automation** — two crons and two background jobs, all **disabled**, with
  far-future expressions.
- `SCRATCH_DIR` is a non-git dir — a task created there gets `kind: 'plain'`, so
  no worktree and no branch.

`CLAUDE_BIN` and `OLLAMA_BIN` both point at the keepalive stub, so
`/api/capabilities` reports both backends available and neither can start a real
turn. `SING_SCOPE_ROOT` stays unset, so skill-scopes renders its not-configured
state, which the specs assert. `SING_USAGE_REPORTS` also stays unset, so the
usage report uses its default dir under the sandbox `USAGE_REPORT_STATE`.

Wiki **categories are derived from a page's folder**, not its frontmatter
(`category(p.rel)` in WikiPanel.jsx) — the category filter only appears when the
corpus has pages in subdirectories.

Mutations are real: a Save writes the file under `<TMP>/corpus/...` and a spec
may assert it with `node:fs`. The sandbox is rebuilt from scratch on every boot,
so specs must not depend on another spec's writes.

## Never drive these

They have no safe path even in the sandbox:

- **New session / Resume / Duplicate / Fork / Restart** on a session row — real
  `claude` spawn, and `ensureTrusted` writes the user's real `~/.claude.json`.
- **"Run now"** on a cron or background job — starts a real agent run.
- **Processes ✕ / "Stop all leftover"** — `POST /api/procs/kill` kills real machine
  PIDs by number, and the bulk button has no confirmation.
- **Restart server** (More ▸ Restart) — kills the daemon under the test.
- **"Open in external terminal"** — detach-spawns `wt.exe` outside the browser.
- **Transcripts → Chat → Send** and **usage report → Generate** — real model call
  / real skill run.
- Accepting the **"Restart sessions to match the new theme?"** dialog — fires
  `respawnAll`. Dismiss it.

## Developing several specs at once

The suite is serial and the sandbox is a single directory per port, so two
concurrent `playwright test` runs on one port would fight over it — the second
now fails fast on the busy port. Set `E2E_PORT` to give a run its own port *and*
its own `<root>/<port>` directory (fixtures, test output and html report all
move with it):

```sh
E2E_PORT=4321 pnpm exec playwright test e2e/wiki.spec.mjs
```

Use `playwright test`, not `pnpm test:e2e` — the latter rebuilds `web/dist`,
which every parallel run shares.
