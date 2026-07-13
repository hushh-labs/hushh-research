---
name: morphy-ax
description: Use when changing Morphy AX shared agent-experience state, semantic assessment presentation, performance budgets, or cross-modal compatibility.
---

# Morphy AX

## Purpose and Trigger

- Primary scope: `morphy-agent-experience`
- Trigger on Morphy AX snapshots, presentation derivation, semantic-assessment validation, compatibility projections, or AX performance budgets.
- Avoid overlap with `frontend-design-system`, `kai-voice-governance`, and `backend-agents-operons`.

## Coverage and Ownership

- Role: `spoke`
- Owner family: `frontend`

Owned repo surfaces:

1. `hushh-webapp/lib/morphy-ax`
2. `docs/reference/quality/morphy-agent-experience.md`

Non-owned surfaces:

1. `hushh-webapp/lib/voice`
2. `consent-protocol/hushh_mcp/agents`
3. `hushh-webapp/lib/morphy-ux`

## Do Use

1. Shared, redacted agent-experience snapshot and presentation contracts.
2. Intelligence-assessment validation and compatibility/non-regression budgets.
3. Cross-modal AX behavior that reuses the existing runtime owner and action gateway.

## Do Not Use

1. Voice action authoring, generated gateway changes, or ADK orchestration ownership.
2. Visual primitive work owned by Morphy UX.
3. A second React provider, store, router, action registry, or model-facing route tool.

## Read First

1. `docs/reference/quality/morphy-agent-experience.md`
2. `docs/reference/one/one-voice-runtime-architecture.md`
3. `docs/reference/quality/frontend-ui-architecture-map.md`
4. `docs/reference/kai/kai-action-gateway-vnext.md`

## Workflow

1. Verify the existing runtime, voice FSM, route playbook, and generated action authority before changing AX.
2. Keep Morphy AX pure, redacted, memoizable, and hosted by `AgentRuntimeStateProvider`.
3. Let intelligence assess meaning; deterministic code may validate, reject, normalize, and enforce authority only.
4. Preserve `OneVoiceContextSnapshot` through an explicit compatibility projection while migration is active.
5. Benchmark the same fixtures flag-off and flag-on; block wrong actions, unsafe fallbacks, or budget regressions.
6. Route voice, backend-agent, design-system, docs, or quality changes to their owning skills.

## Handoff Rules

1. Broad frontend work routes to `frontend`.
2. Voice/action contracts route to `kai-voice-governance`.
3. ADK or product-agent changes route to `backend-agents-operons`.
4. Visual primitives route to `frontend-design-system`; verification policy routes to `quality-contracts`.

## Required Checks

```bash
cd hushh-webapp && npm run verify:morphy-ax
cd hushh-webapp && npm run typecheck
cd hushh-webapp && npm run verify:voice-gateway
cd hushh-webapp && npm run verify:design-system
cd consent-protocol && python3 -m pytest tests/test_onboarding_goal_agent.py tests/test_one_adk_agent_tree.py -q
./bin/hushh docs verify
```
