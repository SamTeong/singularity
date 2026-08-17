## Why

The web UI cannot run without the Fastify daemon — every panel calls a relative
endpoint, and the entire live layer (session dock, tasks board, crons, background
jobs, terminal output) arrives over one WebSocket. UI work therefore requires a
configured `.env`, a real `~/.claude`, and real spawned processes. The same
coupling makes the e2e suite slow by construction: `playwright.config.mjs` pins
`fullyParallel: false, workers: 1` because 19 spec files share a single daemon
and a single mutable state dir, so ~145 tests run strictly serially behind a
build and a wipe-and-reseed of the sandbox corpus.

A browser-side mock removes the daemon from both paths, and — because each
Playwright worker gets its own browser with its own in-memory store — lifts the
shared-mutable-state constraint that forces serial execution today.

## What Changes

- Add an in-browser mock backend under `web/src/mock/`: **MirageJS** for the ~72
  HTTP endpoints the client calls, plus **mock-socket** for the `/ws` protocol
  (13 server frames, 13 client frames). Both are required — there is no
  `GET /agents`, so the dock, tasks, crons and background populate only from the
  WebSocket on-connect burst.
- Add `pnpm dev-mock`: the Vite dev server in `--mode mock`, serving a fully
  interactive shell **with no daemon and no `.env`**.
- Add `pnpm build:mock` (emits `web/dist-mock`, never clobbering `web/dist`) and
  `pnpm test:e2e-mock`, a second Playwright project (`e2e-mock/`,
  `playwright.mock.config.mjs`) running `fullyParallel: true` with multiple
  workers.
- Add a Vite plugin serving `/fs/raw` and `/usagereport/report`, the two paths
  loaded as `<img>`/`<iframe>` subresources that Mirage cannot intercept.
- Production integration remains one guarded dynamic import in
  `web/src/main.jsx`, statically eliminated from the production bundle.
  Verification found the daemon suite and `pnpm lint` already red on `main`, so
  this change also repairs that baseline: it gives the dock's two collapse
  surfaces distinct accessible names, restores Settings' distinct `操作` label
  next to Config's `設定`, restores the Usage alert's established “sign in” auth
  guidance after a prior copy change, and removes behaviour-neutral lint errors
  from agent skill-config strings and an obsolete masthead prop. It also clears
  two History console warnings and makes the daemon's injected `__SING_HOME__`
  and `GET /env` read one helper, so `SING_HOME_DISPLAY` can no longer be
  honoured by one and ignored by the other.
- Port the daemon-independent specs into `e2e-mock/`. The existing `e2e/`
  fixtures and behaviour contracts remain unchanged; verification corrects a
  stale History project-card count that treated today's empty day
  header as an `<article>` and scopes a Tasks scrim click to the active drawer
  while MUI retains the exiting drawer during its transition. It also waits for
  the task dossier's slide-in transition to settle before measuring its narrow-
  viewport bounds, and moves focus off the model autocomplete before asserting
  Escape closes the New task dialog — both matching the already-proven mock
  assertions, so the two suites encode one contract. Its launcher now
  pins the sandbox daemon's POSIX and Windows home variables to
  `e2e/.tmp/home`, preventing reads from the real user home while preserving it
  as the integration layer that proves the daemon itself works.

Not breaking. The syntax-only cleanup in `server/agents.mjs`, the single-source
home helper in `server/index.mjs` (no producer sets `SING_HOME_DISPLAY` once the
launcher stops), the existing daemon-backed fixtures, and the production build
path do not change behaviour.

## Capabilities

### New Capabilities
- `mock-backend`: An in-browser stand-in for the daemon — HTTP route parity with
  `server/index.mjs`, the `/ws` frame protocol, an in-memory mutable store, a
  seeded fixture corpus, and the `dev-mock` run mode. Covers fidelity rules
  (exact response shapes, 409 conflict semantics, loud failure on unhandled
  routes) and the requirement that the mock never ships in production output.
- `mock-backed-e2e`: A second Playwright suite that runs against the mock —
  parallel execution, its own config and fixtures, and the rule that specs
  requiring real daemon behaviour stay in `e2e/`.

### Modified Capabilities
<!-- None. Existing specs (skin-aware-terminal-presentation, phosphor-console-appearance,
     task-detail-panel, zapac-shell-appearance) describe UI behaviour that is unaffected —
     the mock changes where data comes from, not what the UI does with it. -->

## Impact

**New:** `web/src/mock/**`, `web/mock-assets.plugin.mjs`, `web/.env.mock`,
`e2e-mock/**`, `playwright.mock.config.mjs`.

**Modified:** `web/src/main.jsx` (one guarded dynamic import),
`web/vite.config.mjs` (mode-conditional `build.outDir`, register the asset
plugin, honour `SING_HOME_DISPLAY` in the dev injection like the daemon),
`web/src/features/history/DayCard.jsx` and `HistoryView.jsx` (clear
strict-QA warnings), `web/src/features/appearance/AppearanceView.jsx` (heading
level for the view title), `web/src/shell/SessionDock.jsx` (distinct accessible
name for the terminal header),
`web/src/shell/AppMenu.jsx` (restore distinct Japanese navigation labels),
`web/src/features/usage/UsageView.jsx` (restore the Ollama sign-in guidance contract),
`web/src/shell/PhosphorMasthead.jsx` and `AppShell.jsx` (remove an obsolete prop),
`e2e/history.spec.mjs`, `e2e/tasks.spec.mjs` and `e2e/create-dialogs.spec.mjs`
(correct stale structural assertions, transition timing, and an Escape
assertion that fought MUI's nested-overlay contract),
`e2e/serve.mjs` (sandbox the child daemon's actual home),
`server/index.mjs` (one `displayHome()` source for the injected home and `/env`),
`server/agents.mjs` and `server/agents.test.mjs` (remove unnecessary quote escapes),
`package.json` (three scripts, two devDependencies), `CLAUDE.md` (Run section +
File structure), `e2e/README.md` (point at the sibling suite).

**Unmodified:** all other `server/**`, all existing `e2e/**` fixtures and specs
except the structural corrections above, and the production build output.

**Dependencies:** `miragejs@^0.1.48` and `mock-socket@^9.3.1` as
devDependencies. Note miragejs is in maintenance mode (no release since 2022);
acceptable here because it runs only in dev/test and its API is frozen.

**Risk:** the mock's response shapes can drift from the daemon's. Mitigated by
Mirage throwing on unhandled requests (a missing route fails loudly via the
`consoleGuard` fixture) and by keeping `e2e/` as the contract check against the
real server.
