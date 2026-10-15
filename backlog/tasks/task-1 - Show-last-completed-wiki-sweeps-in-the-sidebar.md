---
id: TASK-1
title: Show last completed wiki sweeps in the sidebar
status: Done
assignee: []
created_date: '2026-10-15 12:05'
updated_date: '2026-10-15 12:15'
labels: []
dependencies: []
modified_files:
  - server/wiki.mjs
  - server/wiki.test.mjs
  - server/index.mjs
  - web/src/mock/routes/wiki.js
  - web/src/features/wiki/WikiPanel.jsx
  - e2e-mock/wiki.spec.mjs
  - e2e-mock/explorer-wiki-responsive.spec.mjs
type: feature
ordinal: 1000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The wiki sidebar does not show when its research domains were last swept at each depth, so users have to inspect metadata logs to compare coverage. Show the latest completed shallow, deep, and horizon sweep dates for agentic-coding, dotnet, and iap, alongside the existing graph.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 The collapsible sidebar table lists agentic-coding, dotnet, and iap with shallow, deep, and horizon columns.
- [x] #2 Each cell shows the latest completed date from typed sweep history, and missing history shows a dash.
- [x] #3 A compact Cytoscape graph remains available below the table and retains existing selection and page-opening behavior.
- [x] #4 Server, mock, and UI behavior are covered by focused tests.
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add a focused wiki sweep-history response parsed from each domain ledger, selecting only completed typed entries. 2. Mirror the API in mock mode and cover completed/missing history. 3. Add the collapsible sidebar table above the existing dock graph and preserve graph navigation. 4. Run focused checks plus the project lint and test commands.
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Added wikiSweepHistory and parseSweepHistory to read the three domain ledgers and retain latest typed date records.

Added parser regression coverage for latest dates, horizon continuation completion, interrupted attempts, unsupported sweep types, and empty ledgers.

Exposed the parsed history as GET /api/wiki/sweeps?root=... .

Added mock /wiki/sweeps response with the inspected dates and dash-producing empty iap history.

Added a compact collapsible semantic table between the page list and existing dock graph; graph state remains null by default.

Added mock browser coverage for the collapsible table, all three domains, latest dates, and missing-history labels.

Added phone viewport coverage that expands the table, verifies missing-history labels, checks horizontal overflow, and collapses it before the existing graph flow.

Added backend aggregation coverage for all three fixed rows and null data when a ledger is absent.

Sweep table opens expanded by default so the new dates are immediately visible; users can collapse it. The Cytoscape graph remains closed by default behind its existing toggle.

Desktop E2E also checks that the table is initially expanded before collapsing and reopening it.

Phone responsive coverage now accounts for the table opening expanded, then tests collapse and reopen before continuing the graph flow.

Validation passed: pnpm lint (exit 0); pnpm test (569 passed); focused mock E2E on port 5417 (22 passed). Runner used the same uncommitted source tree; no source edits occurred after validation.
<!-- SECTION:NOTES:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
Added a latest-completed wiki sweep table for agentic-coding, dotnet, and iap above the existing graph toggle, with date-only typed-ledger data and dashes for missing depths. Verified with pnpm lint, pnpm test (569 passed), and focused mock E2E (22 passed).
<!-- SECTION:FINAL_SUMMARY:END -->
