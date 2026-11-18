# Testing

Run commands from the repository root after `pnpm install`. Backend tests need
the Rust toolchain described in [Backend runtime](backend.md).

## Full suites

| Command | Coverage |
| --- | --- |
| `pnpm lint` | Repository ESLint checks |
| `pnpm test` | Node unit and integration tests in `server/`, `web/src/`, `scripts/` and the usage-report skill; builds the Rust backend first |
| `cargo test --manifest-path rust/backend/Cargo.toml` | Rust unit and integration tests |
| `pnpm test:e2e-mock` | Builds `web/dist-mock` and runs the browser suite against the in-browser mock backend |
| `pnpm test:e2e` | Builds `web/dist` and runs the sandbox daemon browser suite |

Rust integration tests that launch Node need `NODE_BINARY` set to the absolute
Node executable. For example, in PowerShell:

```powershell
$env:NODE_BINARY = (Get-Command node).Source
cargo test --manifest-path rust/backend/Cargo.toml
```

See [the E2E guide](../e2e/README.md) for daemon isolation, native HTTP backend
selection and fixture authoring. Mock UI checks and real daemon contracts cover
different behavior; a matching UI assertion does not replace the latter.

## Affected tests

```sh
pnpm test:changed                       # changes since merge-base with origin/main
pnpm test:changed --base main            # choose another base
pnpm test:changed --plan                 # inspect selection without running it
pnpm test:changed --all                  # all selector-managed Node and browser suites
node scripts/test-changed.mjs --unit web,scripts  # explicit unit groups, no browsers
```

The selector includes committed, staged, unstaged and untracked changes. It runs
tests that can be affected by a change, including tests of unchanged consumers.
`--all` does not invoke `cargo test`; run that command separately for Rust changes.

Unit groups are `server`, `web`, `scripts` and `usageReport`. CI passes these group
names to the same runner used locally. Only the server unit group builds Rust;
server or web test-only edits select their unit group without browser builds.

Feature source changes select matching mock specs, the shared responsive
contract and relevant cross-feature contracts. Consumer dependencies are
transitive: for example, session theme changes affect Transcripts, Tasks and
Projects. Changes to `e2e/helpers/` select both browser suites; mock-only helpers
select all mock specs. Shared or unrecognized source paths fall back to broader
coverage, while documented non-runtime paths such as README files are ignored.
Local runtime source selection can also schedule the real daemon suite.

These are logical folder boundaries, not independent packages. Keep
`FEATURE_CONSUMERS`, `FEATURE_SPEC_ALIASES` and `SHARED_FEATURE_SPECS` in
`scripts/test-changed.mjs` current when adding imports or browser contracts.
Regression checks detect missing static cross-feature import edges and missing
spec targets; feature source and mock-spec changes also run those checks. The
bounded import check is not a complete JavaScript dependency parser. A package
split would still need explicit public APIs and dependency direction.

## CI and artifacts

Pull requests select against their base branch; pushes run the complete selected
Node/mock baseline. Unit jobs retain their required Windows and Linux check
names, run lint and dispatch selected unit groups. Mock browser tests run in
Linux Playwright containers, with up to ten shards based on selected spec count.
Real daemon E2E remains a local suite.

Playwright writes generated reports to `playwright-report/` and results, traces
and screenshots to `test-results/`. They can be removed after investigation;
CI uploads mock failure artifacts for seven days. `pnpm clean` reaps orphaned
build processes; it does not delete these directories.

Tests that create worktrees, tickets or reports must point both
`SINGULARITY_HOME` and `SING_TRUSTED_ROOT` at their sandbox before importing
server modules and remove that sandbox during teardown. The checkout's
`.tickets/`, `.reports/` and `.worktrees/` are application data, not general
scratch directories.
