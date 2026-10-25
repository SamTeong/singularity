---
id: TASK-42.22
title: Move Skills root persistence to Rust with explicit scope/spec/AC
status: Done
assignee: []
created_date: '2026-10-24 14:17'
updated_date: '2026-10-25 01:07'
labels: []
dependencies: []
modified_files:
  - rust/backend/src/skills_roots.rs
  - rust/backend/src/lib.rs
  - rust/backend/src/main.rs
  - server/rust-backend.mjs
  - server/skills.mjs
  - server/index.mjs
  - server/skills.test.mjs
  - server/rust-backend.test.mjs
parent_task_id: TASK-42
type: feature
ordinal: 70000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Migrate Skills root persistence, policy, bridge, routes, and async helper selection to Rust according to spec-skills-roots-persistence.md. The current implementation slice owns only rust/backend/src/skills_roots.rs and rust/backend/src/lib.rs; integration remains part of this same task for the following lane. Preserve raw JS strings, explicit Node-supplied paths/default, current/legacy/default fallback, setter filter/dedup/cap, exact compact writes, public route shapes, and bridge rejection behavior. Filesystem write-error wording remains pending the user choice and must not be selected until answered. Do not modify Skills validation, picker roots, backup/write choreography, or other excluded behavior.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Getter preserves raw string values and follows current, legacy, then explicit default precedence, silently skipping read/parse/shape failures and honoring last duplicate property keys.
- [x] #2 Setter distinguishes non-array input structurally; filters empty values, stable-deduplicates by UTF-16 units, caps at 50, and writes exact compact roots JSON bytes.
- [x] #3 Focused Rust unit tests cover fallback, malformed and mixed data, duplicate keys, UTF-8 replacement, UTF-16 distinctions, filtering, deduplication, cap, exact bytes, and storage errors.
- [x] #4 Full migration adds the two bridge operations and updates Node roots wrappers/routes and the five async helper call sites while preserving public payloads and bridge rejection propagation.
- [x] #5 Node parity tests cover paths/default supply, exact bytes, async route and selection behavior, primitive-only setter encoding, fallback, and storage failures, including the pending public error contract after the user decision.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Reuse TranscriptRawText raw token parsing and UTF-16 units; implement a roots-specific raw member parser with last duplicate key wins. 2. Implement explicit-path getter fallback and setter policy/storage with structured failures and exact compact JSON bytes. 3. Add focused unit tests without running them; format only the owned module and inspect the diff.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Created the roots-specific raw-token parser and structured setter result. Groma has no enabled architecture owner for the affected Rust files; no architecture refs added.

Declared the new skills_roots module in the Rust library root. Public error wording remains undecided; setter retains std::io::Error structurally.

Parent clarified that TASK-42.22 tracks the full roots migration; this lane implements only its Rust core, with bridge/Node integration and final task verification remaining for the subsequent owner. Public error wording is still pending.

Getter tests now pin last duplicate roots and legacy root keys.

Integrated explicit-path skills_roots_get and skills_roots_set dispatch in main.rs. User approved native Rust filesystem-error wording on 2026-10-24; storage errors map to the public error string while bad roots remains the exact domain error. Getter/bridge/Node integration is in progress; no acceptance criteria checked.

Added bridge wrappers for explicit-path roots get/set. Setter DTO serializes only primitive strings; Rust domain errors map to public result shapes while transport rejection remains a rejection.

Moved skills root get/set wrappers to the existing injected backend and converted all five helper selections to awaited first-root lookups. Node now supplies explicit current/legacy/default paths; validation/write helpers are untouched.

Reviewer blocker repair: replaced String-decoded object keys with raw-token traversal after full serde_json validation; keys match decoded ASCII names without decoding arbitrary names.

Added getter cases for unrelated lone-surrogate keys and values, escaped duplicate roots/root names, BOM, and trailing garbage; tests remain unexecuted per lane restriction.

Updated GET/PUT /skills/roots to await the roots bridge calls with the shared backend dependency; public payloads are unchanged.

Converted direct roots tests to await APIs, pinned compact persisted bytes and bad-root public shape, exercised primitive-only candidate transport with throwing toJSON and BigInt, and asserted Node supplies explicit storage/default paths through injected backend methods.

Added selection regression coverage for all five existing async helpers: truthy roots bypass configured-root lookup, falsey roots select only index zero, and an empty first root prevents later-root selection.

Added bridge integration coverage for default/current/legacy fallback, duplicate roots keys, UTF-8 replacement, empty/whitespace/lone-surrogate/astral values, compact setter bytes, primitive-only candidates, bad-root/storage result DTOs, and get/set rejection after backend stop.

Finalization evidence: owner run run-20261024T152405509Z completed all nine checks with exitCode 0 and cleanup complete; independent audit rehashed all 395 frozen inputs against before/after manifests, confirmed receipt SHA256, binary SHA256, and stable HEAD. No Definition of Done items are configured.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Migrated Skills roots persistence and resolution to Rust with explicit Node paths, async bridge/routes/helpers, and parity coverage. Verified by the nine-check owner acceptance run and independent receipt/source/binary/HEAD binding audit; no follow-up test run was needed.
<!-- SECTION:FINAL_SUMMARY:END -->
