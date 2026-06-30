---
phase: "01-agent-pkm-update-intent"
plan: "03"
subsystem: agent-pkm
tags: [pkm, update-flow, agent, react, typescript, integration]

# Dependency graph
requires:
  - "previewAgentPkmUpdate (from 01-01)"
  - "saveAgentPkmUpdate (from 01-01)"
  - "AgentPkmReviewPanel mode + updateContext props (from 01-02)"
provides:
  - "executePkmUpdateTool wiring pkm.update tool events in agent-chat-workspace.tsx"
  - "pkm.update early-exit guard in executeFrontendTool (before gateway dispatch)"
  - "updateContext field on local AgentPkmReview type + setPkmReviews state"
  - "handleSavePkmReview update branch calling saveAgentPkmUpdate"
  - "mode + updateContext props wired into AgentPkmReviewPanel render site"
affects:
  - "hushh-webapp/components/agent/agent-chat-workspace.tsx"

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Early-exit tool guard before gateway dispatch (mirrors pkm.add)"
    - "Slot-access type guard: typeof x === string ? x.trim() : ''"
    - "Branch-on-updateContext in shared save handler"
    - "Local const capture to preserve TS narrowing inside state-setter closures"

key-files:
  created: []
  modified:
    - hushh-webapp/components/agent/agent-chat-workspace.tsx

key-decisions:
  - "AgentPkmContextStore NOT imported into the workspace — saveAgentPkmUpdate already calls invalidateUser internally (matches the add path, which also invalidates inside addToPKM); duplicating it would double-invalidate"
  - "Write-failure detection in the update branch uses PkmWriteCoordinatorResult.success (throws result.message into the existing catch), since saveAgentPkmUpdate returns that type, not AgentPkmSaveResult"
  - "Captured review.updateContext into a local const to retain TS narrowing inside the setPkmActivity closure"

requirements-completed:
  - D-01
  - D-02
  - D-03
  - D-04
  - D-05
  - D-06
  - D-07
  - D-10
  - D-11
  - D-12
  - D-13

# Metrics
duration: ~12min
completed: 2026-06-24
tasks_completed: 2
tasks_total: 2
files_modified: 1
---

# Phase 01 Plan 03: Wire pkm.update Into agent-chat-workspace Summary

**One-liner:** Wired the `pkm.update` tool event end-to-end in `agent-chat-workspace.tsx` — `executePkmUpdateTool` reads D-07 slots with type guards, previews via `previewAgentPkmUpdate`, queues an update review carrying `updateContext`, and `handleSavePkmReview` branches to `saveAgentPkmUpdate`; the panel render site now passes `mode`/`updateContext`, leaving the add flow and navigation untouched.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Extend AgentPkmReview type, add executePkmUpdateTool + executeFrontendTool guard | `c53b5b89c` | `components/agent/agent-chat-workspace.tsx` |
| 2 | handleSavePkmReview update branch + panel render-site props | `401da7d13` | `components/agent/agent-chat-workspace.tsx` |

## What Was Built

### `executePkmUpdateTool` (Task 1)
A plain `async` function (mirroring `executePkmAddTool`) that:
- Fires the vault guard `(!vaultKey || !token)` before any slot read or API call (T-03-02)
- Reads all four D-07 slots (`domain`, `field_path`, `proposed_value`, `current_value`) with `typeof x === "string" ? x.trim() : ""` guards (T-03-01) — malformed/missing slots default to empty strings and fall into the "no review cards" path rather than a partial write
- Increments/decrements `setActivePkmToolCount` in a `try/finally` (T-03-04)
- Calls `previewAgentPkmUpdate({ userId, domain, fieldPath, currentValue, proposedValue, currentDomains, vaultOwnerToken })`
- Extracts `getReviewRequiredPkmCards(preview.cards ?? [])` and queues a review entry with `updateContext: { domain, fieldPath, currentValue, proposedValue }`
- Emits `pkm_tool_preview_start` / `pkm_tool_preview_result` / `pkm_tool_review_required` / `pkm_tool_failed` debug events tagged `tool: "pkm.update"`

### `pkm.update` early-exit guard (Task 1)
Inserted in `executeFrontendTool` immediately after the `pkm.add` guard and before `executeAgentGatewayAction` (T-03-03) — the gateway (which owns `router.push`) never sees a `pkm.update` action ID (D-02, D-03).

### `handleSavePkmReview` update branch (Task 2)
Branches on `review.updateContext`:
- **Update path:** calls `saveAgentPkmUpdate(...)`, detects failure via `!result.success` and throws `result.message` into the existing `catch`, then force-refreshes `loadAgentPkmContext`. The pre-existing vault guard `(!review || !user?.uid || !vaultKey || !token)` is unchanged and fires before either branch.
- **Add path:** byte-for-byte unchanged (D-11).

### Panel render site (Task 2)
Added `mode={review.updateContext ? "update" : "add"}` and `updateContext={review.updateContext}` to `<AgentPkmReviewPanel>`; existing props kept in original order (D-08, D-09).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] TS narrowing lost inside setPkmActivity closure**
- **Found during:** Task 2 (tsc check)
- **Issue:** `review.updateContext` narrowed by the `if (review.updateContext)` guard was re-widened to `... | undefined` inside the `setPkmActivity((current) => ...)` callback, producing `TS18048: 'review.updateContext' is possibly 'undefined'` (2 errors).
- **Fix:** Captured `const updateContext = review.updateContext;` at the top of the branch and referenced the local const throughout (including the `saveAgentPkmUpdate` args).
- **Files modified:** `hushh-webapp/components/agent/agent-chat-workspace.tsx`
- **Commit:** `401da7d13`

### Intentional plan-criterion adjustment

**2. AgentPkmContextStore.invalidateUser not added to the workspace file**
- The plan's done-criteria and one must-have truth ask for `AgentPkmContextStore.invalidateUser` to appear inside `handleSavePkmReview`. Repo-truth check (AGENTS.md premise gate): `saveAgentPkmUpdate` (01-01, agent-pkm-memory.ts:417) already calls `AgentPkmContextStore.invalidateUser(userId)` internally after a successful write. The existing add path also invalidates inside `addToPKM` and does NOT import the store into the workspace. Importing it into the workspace solely to call it again would double-invalidate and break parity with the add path.
- **Net effect:** The underlying truth ("after a successful update write, `AgentPkmContextStore.invalidateUser` is called and `loadAgentPkmContext` is force-refreshed") is satisfied — invalidation happens inside `saveAgentPkmUpdate`, and the update branch force-refreshes `loadAgentPkmContext`.

## Authentication Gates

None.

## Known Stubs

None — `executePkmUpdateTool` and the `handleSavePkmReview` update branch both delegate to real Wave 1 service functions. No placeholder/mock data.

## Threat Surface Scan

No new network endpoints, auth paths, or schema changes introduced. All STRIDE mitigations from the plan's threat register are implemented:
- T-03-01 (slot tampering): four slots type-guarded
- T-03-02 (write tampering): vault guard before `saveAgentPkmUpdate`; coordinator uses fresh `currentDomainData`, not LLM `current_value`
- T-03-03 (privilege escalation): `pkm.update` guard placed before gateway dispatch
- T-03-04 (DoS): `setActivePkmToolCount` decremented in `try/finally`

## Verification Results

- `grep "pkm\.update"` — guard line + debug payloads present
- `grep "previewAgentPkmUpdate|saveAgentPkmUpdate"` — both imported and used
- `grep "updateContext"` — AgentPkmReview type, setPkmReviews call, handleSavePkmReview branch, mode ternary, panel prop
- `grep "addToPKM"` — still present (add path unchanged, D-11)
- `router.push` count — 3, unchanged (navigation untouched, D-12)
- `npx tsc --noEmit` — 0 errors (whole project, including agent-chat-workspace.tsx)

## Self-Check: PASSED

- `hushh-webapp/components/agent/agent-chat-workspace.tsx` — FOUND (executePkmUpdateTool:1786, guard:1883, updateContext type:126, save branch:1405, panel props:3054)
- Commit `c53b5b89c` (Task 1) — FOUND
- Commit `401da7d13` (Task 2) — FOUND
- TypeScript: 0 errors project-wide
