---
id: TASK-18
title: Migrate Skills services to Rust backend
status: Done
assignee:
  - '@SamTeong'
created_date: '2026-10-20 03:58'
updated_date: '2026-10-20 04:27'
labels: []
dependencies: []
references:
  - >-
    C:/Users/sate/.agents/.plan/01a156fd-39be-7992-87b0-8f45edd7a26b/explore-next-read.notes.md
modified_files:
  - rust/backend/src/skills.rs
  - rust/backend/src/lib.rs
  - rust/backend/src/main.rs
  - server/rust-backend.mjs
  - server/skills.mjs
  - server/index.mjs
  - server/skills.test.mjs
  - server/rust-backend.test.mjs
type: feature
ordinal: 18000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Narrowed per user decisions and explore-skills.notes.md: move the Skills read services behind the persistent private Rust stdio bridge — skills_list (layout detection + readSkillsDir + per-skill files), skill_read, skill_file_read. Roots persistence (incl. legacy fallback), NAME_RE/bad-name/bad-file validation, writeSkill/writeSkillFile + backup, and root defaulting stay Node. Node stays public gateway; client root passed verbatim.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 GET /api/skills, /skill, and /skill-file preserve payload shapes (scopes/skills/files/raw/name/description/triggers/body, image-type no-content shape), in-body error sentinels, HTTP status mappings, and the no-error scopes:[]/flat:false case.
- [x] #2 Rust walk FOLLOWS symlinked dirs at every level (user decision; faithful port of current behavior) with depth-6/100-file bounds and cycle-duplicate semantics pinned by a test; SKILLS_CAP 200 checked-after-push with capped flag, FILES_CAP/FILE_DEPTH silent truncation; no cache; NAME_RE validation stays Node (negative lookahead unsupported in Rust regex crates).
- [x] #3 Sort parity: Rust returns readdir order, Node applies per-directory localeCompare before flattening (established bridge escape); tests pin exact fixture-tree output.
- [x] #4 Rust unit tests cover parseSkill port (triggers list, quoted values, last-wins, no-frontmatter), layout detection, walk bounds, symlink-follow cycle duplicates, and filesystem failures; real-child bridge tests mirror rust-backend.test.mjs; existing skills.test.mjs keeps passing; release build, focused Rust and Node tests, lint, rustfmt, diff checks pass; independent review required before Done.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Rust: new rust/backend/src/skills.rs with ops skills_list (layout detection, readSkillsDir + parseSkill port, symlink-following listSkillFiles walk, caps, in-body sentinels), skill_read, skill_file_read (image no-content). 2. main.rs: add Request fields scope/skill/flat/file plus three dispatch arms; lib.rs module wiring. 3. server/rust-backend.mjs: bridge methods skillsList, skillRead, skillFileRead; Node applies per-directory localeCompare sort before flattening the walk for byte parity. 4. server/skills.mjs: read paths become thin dispatch wrappers keeping signatures and NAME_RE/root validation Node-side; roots persistence and writeSkill/writeSkillFile stay Node. 5. server/index.mjs: swap read routes at 896-907 to handler factories with skills backend unavailable sentinels; write side untouched. 6. Tests: Rust unit tests for parseSkill port, layout detection, walk bounds, symlink cycle duplicates; bridge-sentinel handler tests in skills.test.mjs; real-child bridge tests in rust-backend.test.mjs. 7. Checks: release build, cargo test, node --test skills + rust-backend, eslint, rustfmt, git diff --check.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Implemented the narrowed read migration: three Rust ops skills_list/skill_read/skill_file_read in rust/backend/src/skills.rs (parseSkill port, symlink-following depth-bounded walk tree, layout detection, image no-content shape), wired via lib.rs, main.rs fields scope/skill/flat/file, and three thin bridge methods in rust-backend.mjs. server/skills.mjs read paths are thin dispatch wrappers with the same signatures (NAME_RE/root validation Node-side, localeCompare sort + SKILLS_CAP/FILES_CAP applied Node-side before flattening the readdir-order trees); roots persistence and the guarded writes stay Node. index.mjs swaps the read routes to createSkillsListHandler/createSkillReadHandler with explicit 500 sentinels and injects the shared backend via setSkillsBackend; /skill-scopes awaited (readSkillsDir is now async). Tests: 5 new Rust unit tests, real-child bridge test in rust-backend.test.mjs, 5 new Node tests incl. cycle duplicates and 500 sentinels; all 22 pre-existing skills tests keep passing. Release build, cargo test 34 passed, node --test 35 passed, eslint, rustfmt --check, git diff --check all green.

Independent review passed all 4 ACs (review-skills.notes.md): cargo 34/34, node 35/35, rustfmt/build green; 36 VERIFY anchors all exact-count 1. Accepted deviations: Node-side caps/sort placement (byte-identical output), /skill-scopes forced await (payload unchanged). Non-blocking findings: flat='1' string dispatch corner, per-entry ? aborting a scope on one bad entry, missing trailing newlines.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Migrated the Skills read services behind the private Rust stdio bridge: new rust/backend/src/skills.rs with skills_list (layout detection grouped-wins, SKILL.md reads with the parseSkill port, symlink-following depth-bounded supporting-file walk), skill_read, and skill_file_read (markdown|image|code classification, image no-content shape); 3 dispatch arms + 4 Request fields; 3 bridge methods; Node keeps roots persistence, NAME_RE validation, writes + backup, and applies per-directory localeCompare sort and SKILLS_CAP/FILES_CAP caps for byte-identical payloads. Verified: cargo 34/34, node 35/35, release build, eslint, rustfmt, diff check; independent review passed all ACs with 36/36 unique anchors.
<!-- SECTION:FINAL_SUMMARY:END -->
