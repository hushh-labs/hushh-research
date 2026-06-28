---
phase: "01-agent-pkm-update-intent"
plan: "01"
subsystem: "agent-pkm"
tags: ["pkm", "write", "update-flow", "tdd"]
dependency_graph:
  requires: []
  provides:
    - "previewAgentPkmUpdate (exported from agent-pkm-memory.ts)"
    - "saveAgentPkmUpdate (exported from agent-pkm-memory.ts)"
    - "applyFieldPatch (module-private utility in agent-pkm-memory.ts)"
  affects:
    - "hushh-webapp/lib/agent/agent-pkm-memory.ts"
    - "hushh-webapp/__tests__/lib/agent-pkm-memory.test.ts"
tech_stack:
  added: []
  patterns:
    - "TDD RED/GREEN cycle (vitest)"
    - "structuredClone for immutable patch application"
    - "PkmWriteCoordinator.savePreparedDomain delegation pattern"
    - "AgentPkmContextStore.invalidateUser cache invalidation"
key_files:
  created:
    - "hushh-webapp/__tests__/lib/agent-pkm-memory.test.ts"
  modified:
    - "hushh-webapp/lib/agent/agent-pkm-memory.ts"
decisions:
  - "applyFieldPatch hand-rolled (no new dependencies) per risk mitigation in RESEARCH.md"
  - "segment type assertions (as string) used to satisfy TypeScript noUncheckedIndexedAccess strictness"
  - "node_modules symlinked from main repo into worktree to enable vitest execution without npm install"
metrics:
  duration: "385 seconds (~6 minutes)"
  completed_date: "2026-06-24"
  tasks_completed: 2
  tasks_total: 2
  files_modified: 2
---

# Phase 01 Plan 01: Add previewAgentPkmUpdate and saveAgentPkmUpdate Summary

**One-liner:** Added `previewAgentPkmUpdate`, `saveAgentPkmUpdate`, and private `applyFieldPatch` to agent-pkm-memory.ts as the service layer for the PKM field-update flow, with full TDD coverage (15 tests).

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 (RED) | Add failing tests for applyFieldPatch and previewAgentPkmUpdate | `33246de8e` | `__tests__/lib/agent-pkm-memory.test.ts` |
| 1+2 (GREEN) | Implement applyFieldPatch, previewAgentPkmUpdate, saveAgentPkmUpdate | `4bf3f28a9` | `lib/agent/agent-pkm-memory.ts` |

## What Was Built

### `applyFieldPatch` (module-private)
A dot-notation path-set utility that:
- Uses `structuredClone` to prevent mutation of original data (T-01-01 mitigation)
- Traverses or creates intermediate objects for nested paths
- Uses type assertions (`as string`) to satisfy TypeScript strict index access

### `previewAgentPkmUpdate` (exported)
Constructs the message `Update {domain} - {fieldPath}: change from "{currentValue}" to "{proposedValue}"` and delegates to the existing `previewAgentPkmMemory`, returning its result unchanged.

### `saveAgentPkmUpdate` (exported)
Delegates to `PkmWriteCoordinator.savePreparedDomain` with a `build` callback that:
- Calls `applyFieldPatch(context.currentDomainData, fieldPath, proposedValue)` — uses coordinator's fresh read, not the LLM-supplied `currentValue` (T-01-02 mitigation)
- Returns `{ domainData, summary: { source: "agent_chat_update", field_path, proposed_value } }`
- Calls `AgentPkmContextStore.invalidateUser(userId)` after successful write
- Propagates errors from `savePreparedDomain` (no silent swallow)

## TDD Gate Compliance

- RED commit (`test(01-01)`) present: `33246de8e` — 15 tests failing before implementation
- GREEN commit (`feat(01-01)`) present: `4bf3f28a9` — all 15 tests passing after implementation
- No REFACTOR phase needed (code is clean as-is)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] TypeScript strict index access on segments array**
- **Found during:** Task 1 GREEN phase (TypeScript compilation check)
- **Issue:** `segments[i]` and `segments[segments.length - 1]` typed as `string | undefined` in strict mode, causing 7 TS errors
- **Fix:** Added `as string` type assertions — safe because the loop bounds guarantee non-undefined access (`i < segments.length - 1`)
- **Files modified:** `hushh-webapp/lib/agent/agent-pkm-memory.ts`
- **Commit:** `4bf3f28a9`

**2. [Rule 3 - Blocking] Worktree missing node_modules**
- **Found during:** RED phase test execution
- **Issue:** The git worktree had no `node_modules` directory; `vitest` could not resolve its own config
- **Fix:** Created a symlink `hushh-webapp/node_modules -> ../../hushh-webapp/node_modules` (main repo's installed dependencies); symlink is not tracked by git (appears in `.gitignore` or is naturally excluded as it's not staged)
- **Files modified:** none (runtime link only)
- **Commit:** N/A (no file commit)

## Known Stubs

None — both functions are fully wired with real delegation patterns. No placeholder values.

## Threat Surface Scan

No new network endpoints, auth paths, or schema changes introduced. `applyFieldPatch` operates purely in-memory. `saveAgentPkmUpdate` uses the existing `PkmWriteCoordinator` write surface which was already in the threat model.

## Self-Check: PASSED

- `hushh-webapp/lib/agent/agent-pkm-memory.ts` — FOUND (370: previewAgentPkmUpdate, 388: saveAgentPkmUpdate, 345: applyFieldPatch)
- `hushh-webapp/__tests__/lib/agent-pkm-memory.test.ts` — FOUND
- Commit `33246de8e` — FOUND (test RED phase)
- Commit `4bf3f28a9` — FOUND (feat GREEN phase)
- All 15 tests pass
- TypeScript: no errors for agent-pkm-memory.ts
