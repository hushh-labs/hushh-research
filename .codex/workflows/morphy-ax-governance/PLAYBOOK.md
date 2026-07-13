# Morphy AX Governance

Use this workflow for shared agent-experience state, presentation, assessment, and performance work.

## Goal

Improve One's cross-modal experience while retaining one runtime owner, one semantic head, one generated action authority, and the existing consent/vault boundaries.

## Steps

1. Route through `frontend` with `morphy-ax` as the narrow spoke.
2. Inventory the current provider, voice FSM, route playbook, generated actions, redaction, and settlement path.
3. Keep AX logic pure and memoizable inside the existing `AgentRuntimeStateProvider`.
4. Require typed intelligence assessment before deterministic validation; never infer meaning with lexical rules.
5. Preserve the current wire shape through the compatibility projection and keep flag-off behavior intact.
6. Benchmark production derivation functions with the same fixtures before and after the change.
7. Prove critical action accuracy, wrong-screen rejection, clarification, redaction, and success-after-settlement.
8. Run the workflow verification bundle and record remaining browser/UAT risks explicitly.

## Common Drift Risks

1. turning AX into a second router or state system
2. making presentation state mutate the canonical voice FSM
3. passing prose, transcripts, credentials, or sensitive values into the AX snapshot
4. accepting an intelligence proposal without route/action validation
5. adding an inference hop to clear visible actions
6. shipping benchmark improvements that remove compatibility behavior
