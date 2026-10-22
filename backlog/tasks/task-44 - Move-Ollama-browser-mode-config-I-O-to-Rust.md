---
id: TASK-44
title: Move Ollama browser mode config I/O to Rust
status: Done
assignee:
  - '@codex'
created_date: '2026-10-22 13:22'
updated_date: '2026-10-22 13:55'
labels: []
dependencies:
  - TASK-43
references:
  - >-
    C:/Users/sate/.agents/.plan/01a156fd-39be-7992-87b0-8f45edd7a26b/ollama-config-design.md
modified_files:
  - rust/backend/src/ollama_mode_config.rs
  - rust/backend/src/lib.rs
  - rust/backend/src/main.rs
  - server/rust-backend.mjs
  - server/rust-backend.test.mjs
  - server/usage.mjs
  - server/usage.test.mjs
type: feature
ordinal: 59000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The Ollama sampler and browser-connect flow currently read and write state/ollama.json in Node. Moving this paired state I/O behind the Rust backend advances runtime ownership while keeping browser/profile verification and provider policy in Node. The approved filesystem error contract is stable Rust wording: bad <configured path>: <operation> failed (<kind>); JSON parse errors and response shapes stay unchanged. Use lossy UTF-8 replacement and preserve BOM behavior so Node JSON.parse remains authoritative. Depends on completed TASK-43 to sequence this slice after Claude credential persistence and is standalone from TASK-42 umbrella metadata.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Initial exists-equivalent false maps to the existing no-config result; a read failure after that check, including raced not-found, returns a stable filesystem error.
- [x] #2 Rust returns configured path, operation (read/mkdir/write/rename), and a stable kind (not-found, permission-denied, already-exists, invalid-input, invalid-data, interrupted, storage-full, or other), with no raw OS message or Windows ACL claim.
- [x] #3 Lossy UTF-8 replacement and BOM are preserved; Node V8 JSON.parse, strict browser-mode comparison, parse-error text, and response shapes remain unchanged.
- [x] #4 Writes preserve recursive parent creation, exact Node PID/Date.now temp path, serialized JSON, 0o600 on Unix, and rename; write failure rejects without direct fallback.
- [x] #5 Windows scratch-state tests cover read and write failure categories and existing missing/parse behavior; portable behavior remains available.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
Implement the Rust Ollama filesystem operation and private bridge, add offline scratch coverage, and run cargo fmt only.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Finalization evidence: independent review verdict pass; ollama-config-checks.receipt.json passed all seven steps with matching before/after hashes (206 Rust library + 3 daemon tests, focused Node 107 passed/2 skipped, full Node 721 passed/2 skipped, release build, fmt, lint, diff check). Windows scratch acceptance is covered; Unix mode behavior is code-reviewed only on this Windows host.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Moved Ollama browser-mode config filesystem I/O to the typed Rust backend while retaining Node JSON parsing, response shapes, and browser verification. Accepted review and seven-step Windows checks passed; source hashes matched the receipt.
<!-- SECTION:FINAL_SUMMARY:END -->
