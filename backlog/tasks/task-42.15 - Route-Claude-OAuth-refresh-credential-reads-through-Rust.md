---
id: TASK-42.15
title: Route Claude OAuth refresh credential reads through Rust
status: Done
assignee: []
created_date: '2026-10-22 12:34'
updated_date: '2026-10-22 12:54'
labels: []
dependencies:
  - TASK-42.14
references:
  - >-
    C:/Users/sate/.agents/.plan/01a156fd-39be-7992-87b0-8f45edd7a26b/claude-refresh-credential-read-design.md
modified_files:
  - server/usage.mjs
  - server/usage.test.mjs
parent_task_id: TASK-42
priority: high
type: feature
ordinal: 57000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
OAuth refresh still reads the Claude credential file directly in Node twice: the refresh guard reads it without Keychain fallback, and persistence rereads it to preserve sibling fields before writing. Both reads can use the existing raw-text claudeCredentialsRead bridge operation while Node retains JSON interpretation and persistence policy. This follow-up keeps the established missing, malformed, and primitive JSON behavior and the existing write fallback intact.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The refresh guard and merge read both use the configured claudeCredentialsRead backend; production helper code no longer directly reads the Claude credential file.
- [x] #2 Offline tests prove missing, read-failure, malformed, and expired refresh credentials make no refresh request and no Keychain lookup.
- [x] #3 Offline refresh tests preserve rotated-token merge and sibling fields, missing/malformed merge behavior, and valid null/primitive JSON failure behavior through the public refresh flow where applicable.
- [x] #4 Existing OAuth response failure handling, CLI fallback, throttle, and 401 rotation ordering remain covered and unchanged.
- [x] #5 Focused Node checks, full pnpm test, and pnpm lint pass; Rust source and binary are unchanged.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Await claudeCredentialsRead for refresh guard and merge reads while preserving Node parsing and persistence semantics. 2. Extend offline bridge fixtures and cover guard/merge outcomes and caller fallback. 3. Run focused usage tests; full suite/lint remain delegated per implementation dispatch.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Final acceptance: reviewer PASS with no blockers. Objective receipt refresh-credential-read-checks.receipt.json reports focused Node 103 passed/0 failed/2 skipped, full Node 717 passed/0 failed/2 skipped, pnpm lint passed, and diff check passed; sourceHashesMatch=true and before/after SHA-256 values match current server/usage.mjs (2F5B461C6A4EE6B405664E1E6E85200B6CB0A0DEB6B1CA37242F828D7DC3B9C3) and server/usage.test.mjs (D8D0F335E21A5812637696C1112EDC30D472B745824F57014DB4737E9C8903B4). Baseline correction: parsed null/primitive assignment and serialization errors reject through refreshOauthGrant and bypass CLI fallback; filesystem writer failures still return false. Rust source and binary are unchanged; no Rust tests/build were needed or run.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Routed Claude OAuth refresh guard and merge credential reads through the existing Rust bridge while retaining Node JSON and write policy. Reviewer PASS; focused Node 103 passed, full pnpm test 717 passed (2 known skips), pnpm lint and diff check passed; receipt confirms source hashes unchanged during validation.
<!-- SECTION:FINAL_SUMMARY:END -->
