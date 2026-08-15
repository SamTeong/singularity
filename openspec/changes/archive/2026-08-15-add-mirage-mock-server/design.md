## Context

The client is a plain-fetch application: there is no API client module. All 58
call sites in `web/src/**` call `window.fetch` with a relative, root-anchored
path (`/tasks`, `/fs/read`, …) — no absolute URLs anywhere. That is the single
fact that makes an in-page mock viable with no refactor: an interceptor that
patches `window.fetch` sees 100% of the HTTP traffic.

The live layer is different. `web/src/providers/AgentsProvider.jsx` owns the
only `WebSocket` in the app (`ws://${location.host}/ws`, computed at module
scope) and it carries the entire fleet state: agents, tasks, task history,
crons, background jobs, history backfill, and all terminal bytes. There is no
`GET /agents`. Three consequences drive the design:

1. HTTP-only mocking yields an empty dock and a dead tasks board.
2. `connected` gates four polls (`/agent-stats`, `/subagents`, `/usage`,
   `/background`) — without a socket those Mirage routes are never even hit.
3. Task mutations POST over REST but the board converges from the `tasks`
   frame, so a mock that answers the POST and stops there produces a card that
   snaps back.

Two paths bypass `fetch` entirely: `/fs/raw` (an `<img src>` in
`ExplorerPanel.jsx:34`) and `/usagereport/report` (an `<iframe src>` in
`UsageReportView.jsx:31`, with an in-file comment explaining why it cannot be a
`fetch`). Browser subresource loads are invisible to any in-page interceptor.

On the test side, `playwright.config.mjs` pins `fullyParallel: false,
workers: 1`, and the comment states why: one daemon, one mutable state dir
(`e2e/.tmp`), and terminals blank while a tab is backgrounded. The first two
constraints are properties of the daemon-backed harness, not of the specs.

Constraints inherited from the project: PowerShell is the primary shell, so
inline `VAR=1 cmd` is not portable. `web/vite.config.mjs` has no `define` block
and `import.meta.env` is used in exactly two places, both `PROD` gates.

## Goals / Non-Goals

**Goals:**
- A daemon-free, `.env`-free UI development loop covering every panel.
- A second e2e suite that runs in parallel and finishes measurably faster.
- Mock responses faithful enough that ported specs keep their assertions.
- Zero footprint in the production bundle and no behaviour changes to the
  production server, daemon-backed fixtures, or their product contracts.

**Non-Goals:**
- Replacing the daemon-backed suite. It stays the contract check against the
  real server.
- Simulating daemon-side logic — cron scheduling arithmetic, cost accounting,
  git worktree creation, LLM calls. The mock returns plausible data; it does not
  compute it.
- Mocking flows the existing suite already forbids driving (real agent spawn,
  real PID kills, real skill runs).
- Sharing a single fixture corpus with `e2e/fixtures/seed.mjs` in this change.

## Decisions

### D1. MirageJS for HTTP, `mock-socket` for the WebSocket

Mirage patches `window.fetch`/`XMLHttpRequest` via pretender and gives route
handlers, an in-memory store, and — importantly — a loud throw on unhandled
requests, which satisfies the "gaps must be visible" requirement for free.
`mock-socket` patches `window.WebSocket` and is the standard pairing.

*Alternative rejected — a second Node process mimicking the daemon.* It would
cover the WS and both subresource paths natively with no browser patching. But
it reintroduces exactly what we are removing: a process to boot, a port to
allocate, and shared mutable state across Playwright workers, which forfeits the
parallelism that is the point of the exercise. The user also specified MirageJS.

*Alternative rejected — Playwright `page.route()` only.* It intercepts
subresources too, and the existing suite already uses it for `/status` and
`/usage`. But it exists only inside Playwright, so it does nothing for
`pnpm dev-mock`, which is half the ask.

*Noted:* miragejs is at 0.1.48 with no release since 2022. Its API is frozen and
it runs only in dev/test, so the maintenance risk is contained; if it ever
breaks on a future browser, the route handlers are plain functions and could be
re-hosted on MSW with mechanical changes.

### D2. Entry via a guarded top-level dynamic import in `main.jsx`

```js
if (import.meta.env.VITE_MOCK) (await import('@/mock/index.js')).startMock();
```

Placed above `createRoot`. It must be **dynamic**: static imports hoist above
imperative code, and `KeysProvider` fires `fetch('/keys')` on first mount, so
the mock has to be installed before render, not merely before the first effect.
`import.meta.env.VITE_MOCK` is statically substituted, so Rollup eliminates the
branch and the entire `web/src/mock/` tree from the production build. This is
the only mock-integration edit to existing application code; D11 and D12 record
the isolation and UI-contract repairs found during strict verification.

*Alternative rejected — a separate `main.mock.jsx` entry.* Cleaner isolation,
but `web/index.html` hardcodes `/src/main.jsx`, so it needs an HTML transform
per mode — more moving parts than the one-line guard, for the same result.

### D3. `startMock()` sets `__SING_HOME__` and deliberately omits `__SING_TOKEN__`

`web/src/lib/paths.js` `tildify`/`untildify` are no-ops without
`window.__SING_HOME__`, which makes panels send a literal `~` to the server and
display unabbreviated paths — a silent correctness bug, not a crash. The mock
sets a fixed fake home.

It must **not** set `__SING_TOKEN__`. Two reasons: the token would append a
query string to the WS URL, and `mock-socket` matches on exact URL; and it would
activate the `window.fetch` monkey-patch at `main.jsx:11`, layering a second
patch on Mirage's for no benefit — the mock does not check auth.

### D4. `--mode mock` rather than an inline environment variable

Vite's native `--mode mock` loads `web/.env.mock` (containing `VITE_MOCK=1`) and
works identically on PowerShell and POSIX shells, matching the project's
cross-platform rule. `build:mock` sets `build.outDir` conditionally to
`dist-mock` so it can never clobber the real `web/dist`.

### D5. `dev-mock` uses the dev server; `test:e2e-mock` uses a built bundle

These have different requirements and get different treatment.

`dev-mock` wants HMR and instant start, so it runs the Vite dev server.

`test:e2e-mock` needs specs to behave exactly as they do in the existing suite,
and dev mode differs in two ways that would break ported specs:
`web/src/shell/AppMenu.jsx:230` gates the Restart menu item on
`import.meta.env.PROD`, and `web/src/theme/contract.js:213` early-returns in
production, meaning a dev run executes a theme-contract validator that can log
warnings straight into the `consoleGuard` fixture. Building keeps `PROD === true`
and both differences disappear. The ~20s build is a fixed cost the current
`test:e2e` already pays; the speedup comes from parallelism, not from skipping
the build.

### D6. Parallelism is the actual optimisation

`playwright.mock.config.mjs` sets `fullyParallel: true` with multiple workers.
This is safe precisely because the mock's state lives in the page: each worker
drives its own browser context with its own Mirage store, and every page load
re-seeds from fixtures. The current config's stated reason for serial execution
("one daemon, one mutable state dir") no longer holds. `timeout` drops from 60s
to 30s — the existing generosity was sized for daemon boot, filesystem work, and
network calls, none of which remain.

### D7. Mutating REST handlers broadcast the matching WS frame

The mock's Mirage routes and its `mock-socket` server share one `db` module.
Any handler that mutates tasks, crons, or background jobs writes to `db` and
then calls the socket broadcaster. This mirrors the daemon's own bus and is what
makes a dragged card stay put.

### D8. Route files grouped by feature, registered static-before-parameterised

Nine route modules under `web/src/mock/routes/` mirroring the server's feature
split. Registration order matters: `PUT /config/:scope` co-exists with
`/config/roots` and `/config/state`, so static siblings register first.

Response fidelity is the main source of subtle bugs, since the daemon's
conventions are not uniform. The rules the handlers must honour:
`GET /crons` returns a bare array; `/tasks`, `/background`, `/config`,
`/codex-config`, `/sysstats`, `/usage`, `/status`, `/capabilities` return bare
objects with no `ok`; `GET /hooks/file` returns `{path,exists,content,mtime}`
with no `ok`; `/wiki/files`, `/wiki/graph`, `/skills` and most
`POST /procs/kill` failures return HTTP 200 with an `error` key; every
`mtime`-guarded write returns a real 409 on mismatch.

### D9. A Vite plugin for the two subresource paths

`web/mock-assets.plugin.mjs` implements both `configureServer` and
`configurePreviewServer`, serving a 1×1 PNG for `/fs/raw` and a canned HTML
document for `/usagereport/report`. One mechanism covers `dev-mock` (dev server)
and `test:e2e-mock` (preview server).

### D10. Independent fixtures reusing the sandbox corpus's names and IDs

`web/src/mock/fixtures.js` is a standalone, dependency-free data module. It
reuses the identifiers the existing corpus uses — `workspace-alpha`,
`workspace-beta`, `handbook`, `Seeded <column> card`, the `RICH_SESSION` id,
30 sessions in project A so pagination has a second page — so ported specs keep
their expectations verbatim.

*Alternative deferred — extract a shared pure-data corpus module that both
`seed.mjs` and the mock import.* Architecturally the right end state, and it
eliminates drift. But it is a refactor of the 17KB `seed.mjs` landing *before*
any mock code exists, and a mistake there breaks the suite we depend on as the
safety net. Revisit once the mock has proven itself.

Being dependency-free also means Playwright specs (running in Node) can import
`fixtures.js` directly for their expected values, the way today's specs import
`e2e/fixtures/paths.mjs`.

### D11. The daemon-backed launcher owns the child process's real home

Strict verification exposed that `e2e/serve.mjs` isolated application state via
`SINGULARITY_HOME` but still inherited the user's OS home, and that its
`SING_HOME_DISPLAY` override had never reached the client at all. The shell
learns the home from the synchronous `window.__SING_HOME__` injection added in
`39f16a7`, which read `os.homedir()` directly and, in the same commit, replaced
the client's async `GET /env` read; `SING_HOME_DISPLAY` was introduced three
days later in `aeed0e7` and only ever fed `/env`. It was therefore dead on
arrival, not a regression this change caused — the launcher's display home was
silently ignored, seeded paths under the real home were abbreviated to `~/...`,
and daemon code could still read real `~/.claude` state.

Two independent fixes, because the two defects are independent:

1. *Isolation.* Rather than add test-only behaviour to the production server,
   the launcher sets both `HOME` (POSIX) and `USERPROFILE` (Windows) to its
   existing `HOME_DIR` and drops `SING_HOME_DISPLAY`. Node's `os.homedir()`
   then resolves to the sandbox naturally on both supported platforms. Note the
   sandbox home is deliberately bare — no `.claude/`, `.claude.json` or
   `.agents/` tree — so the direct `homedir()` reads in `usage.mjs`,
   `tasks.mjs`, `agents.mjs` and `rules.mjs` now resolve to nonexistent paths
   and take their existing `existsSync`/try-catch degraded branches. None of
   them is observable from a current assertion (`/usage` and `/status` are
   stubbed at the network layer, and the prompt-building reads never reach the
   browser), so this is defense-in-depth: it closes a real non-hermeticity hole
   rather than fixing a visible failure.
2. *Coherence.* `SING_HOME_DISPLAY` is production configuration, not test-only,
   so leaving one consumer honouring it and another ignoring it is a latent
   trap for anyone who sets it. Both the daemon's HTML injection and `GET /env`
   now read one `displayHome()` helper, and the Vite dev-server injection
   mirrors it. With the launcher no longer setting the variable, this changes
   nothing either suite observes.

Existing daemon-backed fixtures remain unchanged, while the harness gains a
stronger isolation boundary.

### D12. Strict verification repairs product contracts and stale assertions

Running the daemon suite for 8.5 established that it, and `pnpm lint`, were
already red on `main` before this change — six spec failures and eight lint
errors, none of them caused by the mock work and none reachable by D11 either
(each was reproduced with the launcher's pre-D11 env). The original 8.5 wording,
"passes unchanged," was therefore unachievable as written; what this change owes
the suite is a truthful repair of each failure, recorded here.

Two are product defects. The terminal header and session-list header both
exposed `Collapse sessions dock`, so Playwright's strict accessible locator
matched two controls; the terminal header takes the name of the surface it
collapses (`Collapse terminal dock`) and the session-list contract is unchanged.
Config and Settings also exposed the same visible Japanese label (`設定`), so
Settings returns to its prior distinct `操作` label.

One is a copy regression, covered under the Usage alert below.

One is a spec expressing a contract the framework does not offer. The daemon
copy of the create-dialogs spec pressed Escape while `ModelSelect`'s Autocomplete
popper was still open, and MUI gives that first Escape to the popper — the
standard nested-overlay contract, and the same behaviour the already-ported mock
copy accommodates by moving focus to a plain field first. Forcing the dialog to
close from a capture-phase handler was tried and rejected: it made Escape
unconditionally destroy the whole dialog, cost the popper its own dismissal, and
broke the mock spec that had encoded the real contract. The daemon spec adopts
the mock copy's focus move instead, so both suites assert the same thing and
`CreateDialog` keeps MUI's semantics.

The remaining two are stale assertions. History expected seven `<article>` nodes
from six populated archive days, one gap day, and today's zero-session header.
Since articles represent project cards rather than day headers, and every daemon
fixture session is backdated so today has none, the truthful count is six; the
assertion and its comment are corrected without changing fixtures or product
rendering. The mock copy's `7` is correct for its own fixtures, which seed a
populated today — hence the two suites differ here on purpose.

The Tasks transcript handoff similarly leaves the detail drawer's invisible
backdrop mounted for MUI's exit transition while the transcript drawer and its
visible backdrop open. A global `.MuiBackdrop-root` selector therefore matches
two nodes even though only one is actionable. The daemon spec adopts the mock
copy's already-proven relationship selector from the active Transcript dialog
to its preceding-sibling backdrop. No transition timing or product lifecycle is
changed.

The daemon copy's narrow-viewport dossier check also measured geometry as soon
as the Drawer became visible, which occurs while its slide-in transition is
still running. The mock copy already polls until the final right edge enters
the viewport. The daemon check adopts the same wait before retaining all four
geometry assertions and both sticky-action assertions; this removes timing
flakiness without relaxing the responsive-layout contract.

The Usage suite also retains an established requirement that an Ollama auth
alert explicitly tells the user to “sign in.” A prior copy-only change replaced
that phrase with “log in” / “logged-in,” leaving useful instructions but
breaking the contract. Both help branches return to direct “sign in” wording;
the login flow, command, cookie fields, and provider behavior are unchanged.

The final lint gate exposed six unnecessary quote escapes inside template
literals used to construct and assert Codex skill configuration, plus an unused
masthead connection prop left behind when its connection stamp moved to the
sidebar. Removing the escapes does not change the emitted strings, as the
agent tests confirm; removing the prop only deletes an unused data path while
the sidebar remains the connection-state owner. `no-unused-vars` here carries no
`^_` ignore pattern, so the `_connected` rename never suppressed it.

Two further edits are neither repairs nor contract changes: `DayCard` moves to
`motion.create()` and the History scroll container gains `position: relative`,
clearing framer-motion's deprecation and scroll-container warnings. Neither is
load-bearing for a green suite — History passes without them — and both are kept
because the console-guard fixtures are the reason the warnings were seen at all.

All other daemon specs, every daemon fixture, and all behaviour contracts
remain unchanged.

## Risks / Trade-offs

- **Mock and daemon drift; the mock suite goes green while the app is broken.**
  → The highest-severity risk, and the reason this change does not replace
  `e2e/`. Three mitigations: Mirage throws on unhandled routes so an endpoint
  the client gains but the mock lacks fails the mock suite immediately; the
  daemon-backed suite continues to run as the contract check; and the response
  shapes are documented per-route in D8 so a reviewer can diff them. Residual
  exposure is a *changed* shape on an *existing* route, which only `e2e/` will
  catch — accepted.

- **Hand-writing ~72 route handlers is a lot of surface to get subtly wrong.**
  → Mitigated by shape repetition — `{base}/roots` GET+PUT appears 5×, the
  mtime-guarded file GET+PUT appears 6× — which collapses into shared helpers,
  and by building incrementally with browser verification per route group.

- **`mock-socket` URL matching is exact and brittle.** A trailing query string or
  a host mismatch produces a socket that silently never connects, which then
  disables four HTTP polls and empties the dock — a confusing failure. → The
  mock constructs its server URL with the same `ws://${location.host}/ws`
  expression the provider uses, and D3 keeps the token unset so no query string
  appears. Step 2 of the build order verifies the connection before anything is
  layered on top.

- **Two suites means duplicated spec text that can drift.** → Accepted, in
  exchange for not threading backend conditionals through 19 existing files.
  `helpers/nav.mjs` is backend-agnostic and is shared rather than copied.

- **Parallel workers could expose ordering assumptions the serial suite hid.**
  → The verification step runs the mock suite twice and compares results; any
  test that only passes at `workers: 1` is a genuine ordering bug in that spec.

- **The mock could leak into production output.** → Verified explicitly: the
  production build is grepped for the mock library and source directory, and the
  daemon-backed suite is re-run against the real `web/dist`.

- **miragejs is unmaintained.** → Contained: dev/test only, frozen API, and
  handlers are plain functions that could be re-hosted on MSW if needed.

## Migration Plan

Purely additive; nothing to migrate and nothing to roll back at runtime. Build
order is chosen so each step is independently verifiable in the browser:

1. `db.js` + `fixtures.js` + core routes + `index.js` wiring — shell boots clean.
2. `ws.js` and the on-connect burst — dock, tasks, crons, background populate.
   Verify the socket actually connects before proceeding.
3. Remaining route groups, one group at a time, checking the matching panel.
4. `mock-assets.plugin.mjs`.
5. `playwright.mock.config.mjs` and the ported specs, cheapest first.
6. Documentation: `CLAUDE.md` Run section and File structure, `e2e/README.md`.

Rollback is deleting the added files and reverting the three modified ones
(`main.jsx`, `vite.config.mjs`, `package.json`) plus the verification-driven
isolation, UI-contract, assertion, and lint repairs recorded in D11 and D12.

## Open Questions

- Worker count for the mock suite. Start at 4 locally / 2 in CI and tune once
  the wall-time measurement exists; the right number depends on the box.
- Whether `web/src/mock/fixtures.js` should eventually become the single corpus
  shared with `e2e/fixtures/seed.mjs` (the deferred alternative in D10). Decide
  after the mock suite has been stable for a few weeks.
- Whether the three filesystem-asserting specs (`config`, `explorer`, `editors`,
  35 tests) are worth porting at all, given that their UI-level rewrite tests
  less than the on-disk assertion does. Port the cheap ones first and reassess.
