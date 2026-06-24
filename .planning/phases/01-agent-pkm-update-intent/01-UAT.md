---
status: partial
phase: 01-agent-pkm-update-intent
source: [01-01-SUMMARY.md, 01-02-SUMMARY.md, 01-03-SUMMARY.md]
started: 2026-06-24T23:41:02Z
updated: 2026-06-24T23:41:02Z
---

## Current Test

[testing complete]

## Tests

### 1. PKM update intent → correct domain + confirmation panel
expected: |
  User says "Save my pkm records, address should be 123 Main st, New york, NY, 10001".
  Agent identifies the `identity` domain (address belongs there), drafts a proposed
  change, and shows the AgentPkmReviewPanel in update mode (Current → Proposed diff).
  Nothing is written until the user confirms.
result: issue
reported: "It didn't work. I entered 'Save my pkm records, address should be 123 Main st, New york, NY, 10001'. It said 'Saved 1 PKM memory (Financial)' which is wrong, and there was no confirmation workflow. The address should have updated the identity domain."
severity: major

## Summary

total: 1
passed: 0
issues: 1
pending: 0
skipped: 0

## Gaps

- truth: "PKM update intent routes to pkm.update, identifies the correct domain, and shows a confirmation panel before writing"
  status: failed
  reason: "User reported: input 'Save my pkm records, address should be 123 Main st...' produced an auto-save to the wrong domain ('Financial') with no confirmation panel."
  severity: major
  test: 1
  artifacts:
    - consent-protocol/hushh_mcp/services/agent_chat_service.py
  missing:
    - "Kai backend `update_pkm` LLM function declaration (pkm.update tool)"
    - "Kai backend `_PKM_UPDATE_PATTERNS` regex fallback emitting action_id=pkm.update"
    - "Backend slot mapping for domain, field_path, proposed_value, current_value"

## Diagnosis

**Root cause: the Kai backend has no `pkm.update` tool — confirmed in code.**

The frontend update flow built in Phase 01 (plans 01-01, 01-02, 01-03) is complete and
correct (21/21 must-haves verified, 25 tests passing). But it is **dead code** end-to-end
because the backend never emits a `pkm.update` action. Evidence:

1. `consent-protocol/hushh_mcp/services/agent_chat_service.py:646` `_agent_action_tool()`
   declares the LLM tool list. It contains `add_to_pkm` (→ `pkm.add`) but **no update tool**.
2. `agent_chat_service.py:1361` `plan_action()` regex fallback has `_PKM_ADD_PATTERNS`
   (→ `pkm.add`) but **no `_PKM_UPDATE_PATTERNS`**.
3. There is no `action_id="pkm.update"` anywhere in the backend.

**What actually happened with the user's input:**
The phrase "Save my pkm records …" matched the `add_to_pkm` tool / `_PKM_ADD_PATTERNS`, so
the backend emitted `pkm.add`. The frontend's `executePkmAddTool` ran the existing add
preview, which classified the address into "Financial" (wrong — address belongs in
`identity`) and auto-saved because the add preview returned a non-`confirm_first` write
mode. The new `executePkmUpdateTool` guard never fired because `toolEvent.actionId` was
`pkm.add`, never `pkm.update`.

This is exactly the out-of-scope item flagged in 01-CONTEXT.md and 01-VERIFICATION.md
(human_needed #1: "the live end-to-end loop depends on the Kai backend `pkm.update` tool").

**The fix is backend work** in `consent-protocol/hushh_mcp/services/agent_chat_service.py`:
add an `update_pkm` function declaration + `_PKM_UPDATE_PATTERNS` fallback that emits
`action_id="pkm.update"` with slots `{domain, field_path, proposed_value, current_value}`,
and instruct the planner to prefer update over add when the user references an existing
record/field. No frontend changes are required.
