## 1. Scaffolding and run mode

- [x] 1.1 Add `miragejs@^0.1.48` and `mock-socket@^9.3.1` to `devDependencies`; install
- [x] 1.2 Create `web/.env.mock` containing `VITE_MOCK=1`
- [x] 1.3 Add `dev-mock`, `build:mock`, `test:e2e-mock` scripts to `package.json` using Vite's `--mode mock` (no inline env vars — PowerShell must work)
- [x] 1.4 Make `build.outDir` in `web/vite.config.mjs` conditional on mode so `build:mock` emits `web/dist-mock` and never touches `web/dist`
- [x] 1.5 Add the guarded dynamic import to `web/src/main.jsx` above `createRoot`: `if (import.meta.env.VITE_MOCK) (await import('@/mock/index.js')).startMock();`
- [x] 1.6 Create `web/src/mock/index.js` with `startMock()` — set `window.__SING_HOME__` to a fixed fake home, leave `__SING_TOKEN__` unset, boot Mirage then the WS mock
- [x] 1.7 Verify `pnpm dev-mock` starts and the shell loads (panels may still error at this stage)

## 2. State and fixtures

- [x] 2.1 Create `web/src/mock/db.js` — in-memory stores for files, tasks, task history, crons, background jobs, agents, per-panel roots, and panel UI state; reset on page load
- [x] 2.2 Create `web/src/mock/fixtures.js` as a dependency-free data module (importable from Node specs), reusing sandbox identifiers: `workspace-alpha`, `workspace-beta`, `handbook`, `Seeded <column> card`, the `RICH_SESSION` id
- [x] 2.3 Seed 30 sessions in `workspace-alpha` so the transcript list has a second page, plus the rich multi-tool transcript in `workspace-beta`
- [x] 2.4 Seed the editor corpora: config + local settings, two hook scripts, two rule files, grouped skills (`coding`/`lint-guard`, `design`/`color-audit`), memory markdown, and the `handbook` wiki with interlinked pages
- [x] 2.5 Seed four task cards (one per column) with history rows, two crons and two background jobs

## 3. Mirage server and core routes

- [x] 3.1 Create `web/src/mock/server.js` with `makeServer()`; configure Mirage to throw on unhandled requests and mount route groups in order, static siblings before parameterised (`/config/roots` and `/config/state` before `/config/:scope`)
- [x] 3.2 Add shared helpers for the repeated shapes: `{base}/roots` GET+PUT (5 uses) and the mtime-guarded file GET+PUT with 409-on-mismatch and force-override (6 uses)
- [x] 3.3 `routes/core.js` — `/health`, `/capabilities`, `/env`, `/models`, `/keys`, `/skill-scopes`, `/claude/theme`, `/restart`
- [x] 3.4 Verify the shell boots under `pnpm dev-mock` with a clean browser console

## 4. WebSocket mock

- [x] 4.1 Create `web/src/mock/ws.js` — `mock-socket` server bound to the same `ws://${location.host}/ws` expression `AgentsProvider.jsx` uses; confirm the socket reaches `connected` before building further
- [x] 4.2 Emit the on-connect burst in order: `list`, `tasks`, `crons`, `background`
- [x] 4.3 Handle `attach` (scrollback `output` + `status`), `input` (echo as `output`), `create`/`fork`/`reattach` (reply `attached`, rebroadcast `list`)
- [x] 4.4 Handle `kill`, `respawn`, `reorder`, `txmeta` against `db.agents` with a `list` rebroadcast
- [x] 4.5 Handle `chat` — emit several `chat:delta` frames then `chat:done`; handle `chat:stop`
- [x] 4.6 Export a broadcaster the Mirage handlers can call
- [x] 4.7 Verify the dock populates, a session attaches, typing echoes, and the four socket-gated polls (`/agent-stats`, `/subagents`, `/usage`, `/background`) start firing

## 5. Remaining route groups

Each subtask lands with browser verification of its panel before moving on.

- [x] 5.1 `routes/agents.js` — `/agent-stats`, `/subagents`, `/session/external`, `/session/codex-thread`
- [x] 5.2 `routes/sessions.js` — `/sessions`, `/sessions/root`, `/sessions/search`, `/sessions/stats`, `/session`
- [x] 5.3 `routes/tasks.js` — `POST /tasks`, `/tasks/:id/status`, `/tasks/:id/conclude`, `DELETE /tasks/history/:id`; each mutation broadcasts the `tasks` frame
- [x] 5.4 `routes/automation.js` — `/crons*` (note: `GET /crons` returns a **bare array**) and `/background*` including reports and flagging; each mutation broadcasts its frame
- [x] 5.5 `routes/fs.js` — `/fs/list`, `/fs/read`, `/fs/write`, `/fs/search`, `/fs/browse`, `/fs/entry`, `/fs/rename`, `/fs/state`, backed by the in-memory file store
- [x] 5.6 `routes/editors.js` — `/config*` and `/codex-config*` (bare keyed objects, no `ok`), `/hooks/*` (`GET /hooks/file` has no `ok`), `/rules/*`, `/memory/*`, `/skills` + `/skill`
- [x] 5.7 `routes/wiki.js` — `/wiki/root`, `/wiki/files`, `/wiki/file`, `/wiki/search`, `/wiki/graph` (errors return HTTP 200 with an `error` key)
- [x] 5.8 `routes/telemetry.js` — `/usage`, `/status`, `/sysstats`, `/history`, `/history/regenerate`, `/procs`, `/procs/kill` (failures are HTTP 200 with `ok:false`), `/usagereport/status`, `/usagereport/refresh`
- [x] 5.9 Walk every rail and More-menu view in `pnpm dev-mock` and confirm zero unhandled-request throws

## 6. Subresource paths

- [x] 6.1 Create `web/mock-assets.plugin.mjs` implementing both `configureServer` and `configurePreviewServer`
- [x] 6.2 Serve a 1×1 PNG for `/fs/raw` and a canned HTML document for `/usagereport/report`; register the plugin in `web/vite.config.mjs` for mock mode only
- [x] 6.3 Verify image preview renders in the Explorer and the usage report iframe renders content

## 7. Mock e2e suite

- [x] 7.1 Create `playwright.mock.config.mjs` — `testDir: 'e2e-mock'`, `fullyParallel: true`, workers 4 local / 2 CI, `timeout: 30_000`, `webServer` running `vite preview --config web/vite.config.mjs --mode mock` (both flags load-bearing: without `--mode mock` Vite resolves `build.outDir` back to `dist` and drops the mock-assets plugin, so preview serves the production build with no `/fs/raw` or `/usagereport/report`)
- [x] 7.2 Create `e2e-mock/fixtures/test.mjs` with the `consoleGuard` fixture and `onceConfirm`; drop the `stubNetwork` fixture (the mock already owns `/status` and `/usage`)
- [x] 7.3 Share `e2e/helpers/nav.mjs` rather than copying it
- [x] 7.4 Port `smoke` and `nav` first; confirm the suite is green and running in parallel
- [x] 7.5 Port the remaining daemon-independent specs: `appearance`, `phosphor`, `resize`, `status`, `usage`, `history`, `wiki`, `create-dialogs`, `processes`, `transcripts`, `tasks`, `dock`; verify the usage report iframe has visible geometry and its document renders
- [x] 7.6 Port `config`, `explorer`, `editors`, rewriting each `node:fs` assertion as a UI re-read (close tab → reopen → assert shown content)
- [x] 7.7 Confirm no flow from the existing suite's "Never drive these" list appears in `e2e-mock/`

## 8. Verification

- [x] 8.1 `pnpm dev-mock` with no `.env` present and no daemon running → every view renders, browser console clean
- [x] 8.2 Drag a task card between columns → it moves and stays moved (REST → WS broadcast round-trip)
- [x] 8.3 Run `pnpm test:e2e-mock` twice; results identical both times (no ordering flake from parallel workers) — **144/144 both runs**
- [x] 8.4 Measure and record wall-clock time for `pnpm test:e2e-mock` vs `pnpm test:e2e`; report both numbers — mock **2:31** and **2:57** across the two 8.3 runs (2.4m / 2.8m in-suite, 4 workers), daemon **4:12** (4.0m in-suite, 1 worker); every figure includes the `vite build` each script runs first. ~1.5× faster on the same box
- [x] 8.5 `pnpm build && pnpm test:e2e` → 146/146 green with the child daemon home confined to the sandbox. Note the baseline: the suite and `pnpm lint` were **already red on `main`** (6 spec failures, 8 lint errors), each reproduced independently of this change; design.md D12 records the repair for every one
- [x] 8.6 `grep -ri miragejs web/dist` and a search for the mock source dir → both empty, proving tree-shaking
- [x] 8.7 `pnpm test` (server unit tests) → still green
- [x] 8.8 `pnpm lint` → clean

## 9. Documentation

- [x] 9.1 Add `dev-mock` / `build:mock` / `test:e2e-mock` to the Run section of `CLAUDE.md`, noting that mock mode needs no `.env` and no daemon
- [x] 9.2 Add `web/src/mock/` and `e2e-mock/` to the File structure block in `CLAUDE.md`
- [x] 9.3 Add a note to `CLAUDE.md` working rules: a new server route now needs the Vite dev proxy prefix **and** a mock route
- [x] 9.4 Update `e2e/README.md` to state the division of responsibility between the two suites and where a new spec belongs
