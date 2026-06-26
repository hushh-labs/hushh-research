---
phase: 01-agent-pkm-update-intent
verified: 2026-06-24T19:25:00Z
status: human_needed
score: 21/21 must-haves verified
overrides_applied: 0
human_verification:
  - test: "End-to-end PKM update flow with live Kai backend"
    expected: "User asks 'update my finance details' → LLM emits pkm.update tool call → review panel shows Current → Proposed diff → confirm writes to PKM, dismiss leaves PKM unchanged. No navigation to /profile or /finance occurs."
    why_human: "Requires the Kai Python backend pkm.update tool definition (separate backend PR, OUT of scope for this frontend phase per CONTEXT.md). The frontend cannot emit a pkm.update tool event without the backend tool. Frontend wiring is fully verified; the live tool-event-to-write loop needs a running backend + manual chat interaction."
  - test: "Visual rendering of the update-mode review panel diff block"
    expected: "Update PKM? header, side-by-side Current/Proposed columns with arrow, Update button label, Domain line — rendered correctly in the chat UI."
    why_human: "Visual appearance and layout quality cannot be verified by grep/tests alone (render tests confirm text presence, not visual correctness)."
---

# Phase 01: Agent PKM Update Intent Verification Report

**Phase Goal:** Make the AI agent chat handle PKM update intents intelligently — when a user asks to update PKM records, the LLM identifies the domain from loaded context, drafts a proposed change, shows a review panel with current → proposed values, and writes to the backend only on user confirmation. Navigation (router.push) remains intact for non-PKM intents. The LLM stays general for all other questions.

**Verified:** 2026-06-24T19:25:00Z
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| #   | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1   | `previewAgentPkmUpdate` exists and is exported in agent-pkm-memory.ts | ✓ VERIFIED | `agent-pkm-memory.ts:370` `export async function previewAgentPkmUpdate` |
| 2   | `saveAgentPkmUpdate` exists and is exported in agent-pkm-memory.ts | ✓ VERIFIED | `agent-pkm-memory.ts:388` `export async function saveAgentPkmUpdate` |
| 3   | `applyFieldPatch` patches nested dot-notation paths without mutating original (module-private) | ✓ VERIFIED | `agent-pkm-memory.ts:345-368` uses `structuredClone`; not exported; 15 passing memory tests incl. no-mutation assertion |
| 4   | Both new functions guard on `vaultOwnerToken` and follow ApiService/PkmWriteCoordinator patterns | ✓ VERIFIED | `previewAgentPkmUpdate` delegates to `previewAgentPkmMemory` (sends `Authorization: Bearer`); `saveAgentPkmUpdate` calls `PkmWriteCoordinator.savePreparedDomain` with vaultOwnerToken |
| 5   | `AgentPkmContextStore.invalidateUser` called after successful write in `saveAgentPkmUpdate` | ✓ VERIFIED | `agent-pkm-memory.ts:417` `AgentPkmContextStore.invalidateUser(params.userId)` after `savePreparedDomain` |
| 6   | `previewAgentPkmUpdate` delegates to `previewAgentPkmMemory` with constructed message | ✓ VERIFIED | `agent-pkm-memory.ts:379-385` message `Update ${domain} - ${fieldPath}: change from "..." to "..."` |
| 7   | `saveAgentPkmUpdate` applies `applyFieldPatch` to `context.currentDomainData` in build callback | ✓ VERIFIED | `agent-pkm-memory.ts:401-406` `applyFieldPatch(context.currentDomainData, fieldPath, proposedValue)` |
| 8   | Panel accepts optional `mode` and `updateContext` props with backward-compatible defaults | ✓ VERIFIED | `agent-pkm-review-panel.tsx:15-22` props; `:57` `mode = "add"` default; existing call sites unchanged |
| 9   | Update mode header reads "Update PKM?" with change-proposal description | ✓ VERIFIED | `agent-pkm-review-panel.tsx:76,79-80` ternary on `mode === "update"` |
| 10  | Update mode shows Current → Proposed diff block side by side | ✓ VERIFIED | `agent-pkm-review-panel.tsx:110-127` diff block with Current/Proposed columns + `→` arrow |
| 11  | Update mode confirm button reads "Update" instead of "Save" | ✓ VERIFIED | `agent-pkm-review-panel.tsx:105` `{mode === "update" ? "Update" : "Save"}` |
| 12  | Add mode (default) renders unchanged — no visual change | ✓ VERIFIED | Add-path branches preserve original strings/classNames; 4 add-mode regression tests pass |
| 13  | All existing AgentPkmReviewPanel call sites compile without modification | ✓ VERIFIED | `tsc --noEmit` 0 errors project-wide |
| 14  | `executePkmUpdateTool` handles `pkm.update` events in agent-chat-workspace.tsx | ✓ VERIFIED | `agent-chat-workspace.tsx:1823-1908` full async function |
| 15  | `pkm.update` intercepted before `executeAgentGatewayAction` — no gateway dispatch | ✓ VERIFIED | `agent-chat-workspace.tsx:1920-1923` early-exit guard at `:1920`, before gateway call at `:1927` (D-02, D-03) |
| 16  | All four D-07 slots read with string-type guards | ✓ VERIFIED | `agent-chat-workspace.tsx:1834-1845` `typeof x === "string" ? x.trim() : ""` for domain/field_path/proposed_value/current_value |
| 17  | Vault guard `(!vaultKey \|\| !token)` fires before any slot read or API call | ✓ VERIFIED | `agent-chat-workspace.tsx:1824-1831` guard is first statement in function |
| 18  | `pkmReviews` state receives entry with `updateContext` on pkm.update event | ✓ VERIFIED | `agent-chat-workspace.tsx:1884` `updateContext: { domain, fieldPath, currentValue, proposedValue }` |
| 19  | Render site passes `mode` and `updateContext` to `<AgentPkmReviewPanel>` | ✓ VERIFIED | `agent-chat-workspace.tsx:3055-3056` `mode={review.updateContext ? "update" : "add"}` `updateContext={review.updateContext}` |
| 20  | `handleSavePkmReview` branches on `updateContext` → `saveAgentPkmUpdate`; add path unchanged | ✓ VERIFIED | `agent-chat-workspace.tsx:1405-1438` update branch; `:1442` add branch (`addToPKM`) intact |
| 21  | User dismiss calls `handleDismissPkmReview` — no write occurs (D-10) | ✓ VERIFIED | `agent-chat-workspace.tsx:1372-1384` only filters state, no write call; wired at render `:3058` |

**Score:** 21/21 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `hushh-webapp/lib/agent/agent-pkm-memory.ts` | previewAgentPkmUpdate, saveAgentPkmUpdate, applyFieldPatch | ✓ VERIFIED | Exists, substantive, exports present, imported+used by workspace |
| `hushh-webapp/components/agent/agent-pkm-review-panel.tsx` | mode + updateContext props, diff block | ✓ VERIFIED | Exists, substantive, wired into workspace render site |
| `hushh-webapp/components/agent/agent-chat-workspace.tsx` | executePkmUpdateTool, guard, save branch, panel props | ✓ VERIFIED | All five integration points present |
| `hushh-webapp/__tests__/lib/agent-pkm-memory.test.ts` | service-layer tests | ✓ VERIFIED | Exists; passes (15 tests) |
| `hushh-webapp/__tests__/components/agent-pkm-review-panel.test.tsx` | add regression + update render tests | ✓ VERIFIED | Exists; passes (10 tests) |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| previewAgentPkmUpdate | previewAgentPkmMemory | delegate after building message | ✓ WIRED | memory.ts:380 |
| saveAgentPkmUpdate | PkmWriteCoordinator.savePreparedDomain | build callback applies field patch | ✓ WIRED | memory.ts:396 |
| saveAgentPkmUpdate | AgentPkmContextStore.invalidateUser | called on success | ✓ WIRED | memory.ts:417 |
| executeFrontendTool (pkm.update guard) | executePkmUpdateTool | early-exit before gateway | ✓ WIRED | workspace.tsx:1920-1923 |
| executePkmUpdateTool | previewAgentPkmUpdate | called with 4 slots + domains + token | ✓ WIRED | workspace.tsx:1859 |
| handleSavePkmReview update branch | saveAgentPkmUpdate | called when updateContext defined | ✓ WIRED | workspace.tsx:1410 |
| AgentPkmReview type | updateContext field | optional field on local type | ✓ WIRED | workspace.tsx:126-131 |
| pkmReviews render | AgentPkmReviewPanel mode/updateContext props | passed from review state | ✓ WIRED | workspace.tsx:3055-3056 |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| AgentPkmReviewPanel (update mode) | `updateContext` | `review.updateContext` set in executePkmUpdateTool from live `toolEvent.slots` | Yes (from LLM tool event, type-guarded) | ✓ FLOWING |
| saveAgentPkmUpdate write | `updatedData` | `applyFieldPatch(context.currentDomainData, ...)` — coordinator's fresh optimistic-lock read | Yes (authoritative DB read, not LLM-supplied current_value) | ✓ FLOWING |

Note: The live LLM-emitted `pkm.update` tool event depends on the out-of-scope Kai backend tool. Frontend reads real slot data when the event arrives; the upstream event emission is a separate backend PR (see Human Verification).

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Service + panel unit tests pass | `vitest run agent-pkm-memory.test.ts agent-pkm-review-panel.test.tsx` | 25 passed (2 files) | ✓ PASS |
| TypeScript compiles for all 3 phase files | `tsc --noEmit \| grep <files>` | 0 errors (project-wide 0 errors) | ✓ PASS |
| Live end-to-end tool flow | requires running Kai backend with pkm.update tool | — | ? SKIP (routed to human) |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| D-01 | 01-03 | Kai LLM source of truth for intent classification | ✓ SATISFIED (frontend side) | Frontend handles pkm.update tool event; no frontend regex interceptor. Backend tool def OUT of scope per CONTEXT.md |
| D-02 | 01-03 | Route update intents to pkm.update, not router.push | ✓ SATISFIED | Guard intercepts before gateway (workspace.tsx:1920); router.push count unchanged (3, all unrelated) |
| D-03 | 01-03 | No frontend regex interceptor | ✓ SATISFIED | Intent classification stays in LLM; frontend only matches `actionId === "pkm.update"` |
| D-04 | 01-03 | LLM uses loaded PKM context to self-identify domain | ✓ SATISFIED | `currentDomains: turnPkmContext.domains` passed to preview (workspace.tsx:1865) |
| D-05 | 01-03 | Domain keys read from context, not hardcoded | ✓ SATISFIED | No hardcoded domain list; domain read from tool slot |
| D-06 | 01-03 | LLM infers domain (candidate_domain_choices available) | ✓ SATISFIED | `AgentPkmDomainChoice` / `candidate_domain_choices` typed in memory.ts:16-30,46 |
| D-07 | 01-01, 01-03 | Slots: domain, field_path, proposed_value, current_value | ✓ SATISFIED | All four read with type guards (workspace.tsx:1834-1845) |
| D-08 | 01-02, 01-03 | Reuse AgentPkmReviewPanel | ✓ SATISFIED | Same component extended; no new panel |
| D-09 | 01-02, 01-03 | Update mode shows current → proposed | ✓ SATISFIED | Diff block (panel.tsx:110-127) |
| D-10 | 01-01, 01-02, 01-03 | Confirm writes; dismiss = no write | ✓ SATISFIED | handleSavePkmReview update branch writes; handleDismissPkmReview only filters state |
| D-11 | 01-03 | pkm.add flow untouched | ✓ SATISFIED | Phase commits do not touch addToPKM lines; add branch intact |
| D-12 | 01-03 | Navigation router.push intact | ✓ SATISFIED | router.push count unchanged; not in update path |
| D-13 | 01-03 | General questions unchanged | ✓ SATISFIED | Only pkm.update actionId intercepted; all other paths fall through to gateway |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| — | — | None found | — | No TODO/FIXME/XXX/TBD/placeholder markers in any of the 3 phase files |

### Human Verification Required

#### 1. End-to-end PKM update flow with live Kai backend

**Test:** With the Kai backend `pkm.update` tool deployed, send the agent a message like "update my finance details" or "my name changed to X".
**Expected:** LLM emits a `pkm.update` tool call → update-mode review panel appears with Current → Proposed diff → confirm writes the field to PKM (verify via PKM read), dismiss leaves PKM unchanged. The agent must NOT navigate to `/profile` or `/finance`.
**Why human:** The Kai backend `pkm.update` tool definition is a separate backend PR, explicitly OUT of scope for this frontend phase (CONTEXT.md). The frontend cannot emit the tool event itself; the full loop requires a running backend and manual chat interaction. All frontend wiring is verified programmatically.

#### 2. Visual rendering of update-mode review panel diff block

**Test:** Trigger the update review panel and visually inspect.
**Expected:** "Update PKM?" header, side-by-side Current/Proposed columns with an arrow, "Update" button, and a Domain line, laid out cleanly.
**Why human:** Render tests confirm text presence but not visual layout/appearance quality.

### Gaps Summary

No blocking gaps. All 21 must-have truths are verified directly in the codebase: the service layer (Plan 01), the review panel extension (Plan 02), and the workspace integration (Plan 03) all exist, are substantive, are wired together, and pass 25 unit tests with 0 TypeScript errors. The add-flow and navigation (router.push) are byte-for-byte unchanged by the phase commits (D-11, D-12 satisfied).

The phase is moved to `human_needed` rather than `passed` because two checks cannot be completed programmatically: (1) the live end-to-end loop depends on the out-of-scope Kai backend `pkm.update` tool, and (2) visual appearance of the diff panel. Neither is a frontend implementation gap — the frontend contract is complete and correct.

---

_Verified: 2026-06-24T19:25:00Z_
_Verifier: Claude (gsd-verifier)_
