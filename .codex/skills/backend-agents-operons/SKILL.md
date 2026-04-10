---
name: backend-agents-operons
description: Use when changing backend agents, operons, ADK surfaces, or orchestration contracts inside the consent-protocol runtime.
---

# Hushh Backend Agents Operons Skill

## Purpose and Trigger

- Primary scope: `backend-agents-operons`
- Trigger on agents, operons, ADK surfaces, orchestration boundaries, or tool/agent runtime changes.
- Avoid overlap with `backend-runtime-governance` and `security-audit`.

## Coverage and Ownership

- Role: `spoke`
- Owner family: `backend`

Owned repo surfaces:

1. `consent-protocol/hushh_mcp/agents`
2. `consent-protocol/hushh_mcp/operons`
3. `consent-protocol/hushh_mcp/tools`
4. `consent-protocol/hushh_mcp/hushh_adk`
5. `consent-protocol/hushh_mcp/adk_bridge`

Non-owned surfaces:

1. `backend`
2. `security-audit`
3. `repo-operations`

## Do Use

1. Agent and operon ownership or orchestration changes.
2. ADK integration boundaries and backend tool surfaces.
3. Agent-runtime docs and tests tied to orchestration behavior.

## Do Not Use

1. Broad backend intake where the correct spoke is still unclear.
2. Generic service-layer placement or API wire contract changes.
3. Trust-policy work where authorization or vault boundary is the primary concern.

## Read First

1. `consent-protocol/docs/reference/agent-development.md`
2. `consent-protocol/docs/reference/kai-agents.md`
3. `docs/reference/ai/README.md`

## Workflow

1. Confirm whether the change is about orchestration, tool surface, or agent packaging before editing code.
2. Keep orchestration docs and relevant tests aligned with the implementation.
3. Route trust, consent, or scope-enforcement questions into `security-audit`.

## Handoff Rules

1. If the request is still broad or ambiguous, route it back to `backend`.
2. If the task becomes service/runtime boundary work, use `backend-runtime-governance`.
3. If the task becomes trust or consent enforcement work, use `security-audit`.

## Required Checks

```bash
cd consent-protocol && python3 -m pytest tests/agents -q
cd consent-protocol && python3 -m pytest tests/test_hushh_adk_foundation.py -q
```
