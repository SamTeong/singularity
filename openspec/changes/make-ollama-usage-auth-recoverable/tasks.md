## 1. Server authentication flow

- [x] 1.1 Refactor browser scraping so normal refresh is headless-only and classifies auth, challenge, parser, and availability failures
- [x] 1.2 Add one shared interactive connect workflow with profile locking, atomic browser-mode persistence, cache invalidation, and verified sanitized usage
- [x] 1.3 Preserve the last successful Ollama reading as timestamped stale data when refresh fails
- [x] 1.4 Expose the explicit connect operation through the daemon and reuse it from the CLI login script
- [x] 1.5 Add focused server tests for success, timeout/cancel, state migration, failure classification, stale fallback, and no background headful launch

## 2. Usage-page recovery UX

- [x] 2.1 Add the Ollama Connect/Reconnect action and connecting/success/failure states
- [x] 2.2 Add the mandatory mock route with production-compatible responses
- [x] 2.3 Add mock-backed end-to-end coverage for reconnect and stale-data presentation

## 3. Verification

- [x] 3.1 Run focused server and mock-backed tests
- [x] 3.2 Run the relevant build or full test suite and record any unrelated failures
