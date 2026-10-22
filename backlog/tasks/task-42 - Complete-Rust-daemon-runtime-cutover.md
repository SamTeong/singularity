---
id: TASK-42
title: Complete Rust daemon runtime cutover
status: To Do
assignee: []
created_date: '2026-10-20 23:52'
updated_date: '2026-10-22 15:53'
labels: []
dependencies: []
modified_files:
  - .claude/rules/server.md
priority: high
type: feature
ordinal: 42000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The current incremental migrations move selected operations into a private Rust child while Node still owns the production HTTP/WS listener, application services, agent lifecycle, startup and shutdown. The accepted target is a production Rust daemon with Node used only to build web assets. Track the end-to-end cutover while delivering verified service slices and preserving the existing browser contracts and state roots.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 Production startup and normal operation require no Node.js process or Node runtime helper; Node remains only in web asset build tooling.
- [ ] #2 The Rust daemon owns all production HTTP/API and WebSocket behavior, application domain services, agent/process lifecycle, startup, and shutdown.
- [ ] #3 Windows runtime validation passes for the daemon, HTTP/WS contracts, security invariants, state ownership, agent lifecycle, and distribution/startup/shutdown.
- [ ] #4 Linux and macOS runtime validation remain explicit follow-up work and do not block Windows cutover acceptance.
- [ ] #5 HTTP and WebSocket contracts, loopback-only binding, token/origin protections, configured state roots, and external-terminal failure preservation are covered by parity evidence.
<!-- AC:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Cutover residual from TASK-42.6: replace the configured external Node usage-report renderer with Rust before the final daemon cutover; interim refresh still invokes node <SING_USAGE_SKILL> report.

TASK-42.6 finalization: all nine reviewed source hashes and their unique VERIFY anchors match; the approved server rule correction hash is 97BCF369F4FD229B36596AA594D82A50C7078777489CB18E596C31C24EDF8A7F. Serial full Rust suite passed (160 library + 3 main); Node full suite passed (699, 2 skipped); lint, release build, and fmt check passed. A parallel full Rust run recorded 159 passed and one status header-timeout failure, and a rerun hung; serial pass does not prove the cause. TASK-42.9 tracks the bounded deterministic fixture follow-up. External Node usage-report renderer remains a cutover residual.

TASK-42.7 completed: Claude, Codex, and Ollama provider usage normalization now runs through the typed Rust bridge. Remaining Node ownership includes usage snapshot persistence and local reads (TASK-42.8), plus provider credentials, fetch/scrape, and coordinator behavior; final Rust daemon cutover remains incomplete.

TASK-42.8 completed on 2026-10-22: provider usage snapshot persistence and local reads now use the shared Rust backend; post-repair evidence is recorded on the subtask. Remaining cutover work includes the TASK-42.6 external Node usage-report renderer and other whole-daemon criteria; Linux/macOS validation remains explicit follow-up.

TASK-42.10 Windows finalization: independent review PASS with no blockers. The full serial Rust suite passed 192 library tests + 3 main tests after a test-only diagnostic was added to the status timeout assertion; the earlier full run had 190 pass and one failure at that assertion, then passed on rerun. Cause remains unknown, so this is not classified as a proven flake; determinism follow-up remains tracked by TASK-42.9 (separate pre-existing task, unchanged). Full Node suite passed 704, failed 0, with 2 known pre-epoch filesystem-mtime skips. Forced Codex transport is migrated to Rust on Windows, while Node retains retry/backoff, Retry-After Number()/Date.parse(), and JSON.parse compatibility as explicit temporary residuals. The broader Rust daemon runtime migration remains incomplete; Linux/macOS validation and TASK-42.2 remain outstanding.

TASK-42.11 Windows finalization: Claude forced live usage GET now uses a typed private one-attempt Rust bridge over the shared Codex HTTP core. Full serial Rust passed (194 library + 3 main); Node full suite passed (710 total, 2 known pre-epoch mtime skips); focused checks, lint, fmt, release build, diff check, and independent review passed. Explicit residuals in Node: Claude credential lookup/refresh/persistence, Keychain/CLI fallback, 401 coordinator, retry/Retry-After, JSON parsing, history append, normalization, and local fast path. No whole-daemon cutover claim; Linux/macOS validation and TASK-42.2 remain outstanding. Focused Node run without --test-force-exit lingered after results; cause unknown; the project-standard full run exited successfully.

TASK-42.13 created 2026-10-22: Move Claude credential lookup reads to Rust. It depends on TASK-42.11 and tracks migration of lookup/fingerprint/no-credential diagnostic reads while keeping raw JSON interpretation in Node; OAuth refresh/persistence, Keychain, CLI fallback, 401 handling, and provider calls remain separate. Design: C:/Users/sate/.agents/.plan/01a156fd-39be-7992-87b0-8f45edd7a26b/claude-credential-read-service-design.md. Groma reports no component owner for server/usage.mjs, so architecture references remain empty.

TASK-42.14 Windows finalization: Claude OAuth refresh transport attempt now uses the fixed Rust HTTPS POST; Node still owns OAuth JSON construction/parsing, retry and Retry-After policy, throttling, credential resolution and persistence/rotation, Keychain/CLI fallback, and 401 ordering. Independent review PASS; all seven receipt checks passed with eight source hashes matching. Nonblocking gap: private Node callback unexpected URL/method rejection has no direct test; Rust operation takes no URL/method. Remaining cutover work includes Node-owned coordinator/retry/persistence/credential/CLI policy across provider flows, the external Node usage-report renderer, and whole-daemon runtime criteria; TASK-42.2 Linux/macOS validation remains outstanding.

TASK-42.14 residual wording clarification: Rust executes Keychain and claude auth-status operations in usage_auth.rs/main.rs. Node retains fallback selection/order/throttle, credential resolution, persistence/rotation, retry, JSON policy, and coordinator behavior. A planned read-only design will route duplicate credential/refresh/merge reads through the existing claudeCredentialsRead operation; no additional task has been created.

TASK-42.15 finalization (2026-10-22): Claude OAuth refresh guard and merge credential reads now use claudeCredentialsRead; reviewer accepted with no blockers. Host receipt passed focused Node (103 pass, 0 fail, 2 skipped), full Node (717 pass, 0 fail, 2 skipped), lint, and diff check; matching current and pre/post SHA-256 confirms validation did not change the two source files. Baseline parity correction: parsed null/primitive merge assignment and serialization errors reject through refreshOauthGrant and bypass CLI fallback; filesystem writer failures continue returning false. This completes TASK-42.15 only; broader cutover remains incomplete.

TASK-43 completion (2026-10-22): OAuth refresh credential persistence now writes through the private Rust credential bridge; TASK-43 is Done with all five acceptance criteria checked after independent acceptance. The original seven-check receipt and post-test-repair three-check receipt passed with matching source hashes. The Unix mode test was not run on Windows; POSIX mode bits are not claimed as a Windows ACL guarantee. TASK-42.2 Linux/macOS daemon validation remains outstanding.

TASK-44 Windows finalization: Ollama browser-mode config filesystem reads and atomic writes now use the Rust backend, with Node JSON parsing, response shapes, and browser verification preserved. Independent review passed; seven-step receipt passed (206 Rust library + 3 daemon tests, focused Node 107 passed/2 skipped, full Node 721 passed/2 skipped, release build, fmt, lint, diff check) with all seven source hashes matching before/after. Unix permission behavior was code-reviewed only on Windows; TASK-42.2 Linux/macOS runtime validation remains outstanding.

TASK-45 completed 2026-10-22: Codex account fingerprint lookup moved to the private Rust bridge and integrated at the existing Node pre-gate point. Independent review accepted. Continuation evidence passed focused Node (109 passed, 2 skipped), full Node (723 passed, 2 skipped), lint, and diff-check; reused original fmt, Rust (207 library + 3 daemon), and release-build checks. Nine source hashes matched the continuation receipt. The initial Cargo.lock byte transition remains unexplained; the final diff adds only the intended direct ring dependency edge. No Groma architecture owner is currently registered for the affected files.

TASK-46 completed on 2026-10-22: process discovery parsing, normalization, and classification moved into Rust; Node retains registry snapshot timing and the public /procs/kill guard flow. Independent review passed. Hash-pinned verification: focused Node 38 passed/2 skipped, full Node 724 passed/2 skipped, lint and diff check passed; reused original matching Rust fmt, 210 library + 3 binary tests, and release build. Darwin live execution remains platform-validation follow-up.
<!-- SECTION:NOTES:END -->
