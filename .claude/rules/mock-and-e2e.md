---
paths:
  - "web/src/mock/**"
  - "e2e/**"
  - "e2e-mock/**"
  - "playwright*.config.*"
---

# Mock backend + e2e suites

## Mock mode
`--mode mock` sets `VITE_MOCK=1`, which switches on `web/src/mock/`: a Mirage server (`server.js`) answering every REST route through `routes/` (one file per concern), a `mock-socket` `/ws` (`ws.js`), seed corpora (`db.js` + `fixtures.js`), and `startMock` (`index.js`). No `.env`, no daemon, and nothing reads `SINGULARITY_HOME`/`CLAUDE_BIN`/`~/.claude`.

A mock handler must match the daemon's exact response shape: several routes return bare arrays or keyed objects with no `ok`. If the daemon broadcasts a WS frame, the handler broadcasts the matching one. Mirage throws on unhandled requests by design; it's the drift alarm, not a flake.

## e2e (real sandbox daemon)
Details are in `e2e/README.md`; read it before editing specs. Gotchas that aren't obvious from it:
- `e2e/serve.mjs` strips every `SING_*`/`DAEMON_PORT`/`CLAUDE_BIN`/… key from `process.env`, then boots an isolated daemon with a stub `CLAUDE_BIN`. `E2E_PORT` (process env or `.env`, via `scripts/env-port.mjs`) gives a run its own port + sandbox dir; only a process-env `E2E_PORT` switches `playwright.config.mjs` into side-run reporting.
- Playwright drives the pre-built `web/dist`. Rebuild before re-testing source changes, or the fix will look like it failed.
- MUI `data-testid="<Name>Icon"` exists in DEV only. Reach icon-only buttons via their Tooltip `aria-label`.
- `PERSISTENT_VIEWS` stay mounted with `display:none`. `getByRole` filters them out, but text/CSS queries need the `visible()` helper.
- `/procs` scans the real machine, so never assert a row count. `ensureTrusted` writes the real `~/.claude.json`, so no spec may create a task, session or cron: those specs are cancel-only on seeded rows.
- The `consoleGuard` fixture fails a test on any console error or warning. Opt out per test with `allow(/re/)`. The cytoscape "custom wheel sensitivity" warning is allowlisted.
