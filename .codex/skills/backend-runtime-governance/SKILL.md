---
name: backend-runtime-governance
description: Use when changing backend route placement, service boundaries, runtime ownership, or backend docs/tests alignment.
---

# Hushh Backend Runtime Governance Skill

## Purpose and Trigger

- Primary scope: `backend-runtime-governance`
- Trigger on backend route placement, service boundaries, runtime ownership, and backend runtime docs/tests alignment.
- Avoid overlap with `backend-api-contracts` and `backend-agents-operons`.

## Coverage and Ownership

- Role: `spoke`
- Owner family: `backend`

Owned repo surfaces:

1. `consent-protocol/api`
2. `consent-protocol/hushh_mcp/services`
3. `consent-protocol/hushh_mcp/integrations`
4. `consent-protocol/tests/services`

Non-owned surfaces:

1. `backend`
2. `security-audit`
3. `repo-operations`

## Do Use

1. Route and service placement decisions inside the backend runtime.
2. Runtime ownership boundaries between routes, services, and integrations.
3. Aligning backend runtime docs and service-layer tests with implementation changes.

## Do Not Use

1. Broad backend intake where the correct spoke is still unclear.
2. Agent/operon orchestration work.
3. Proxy contract work that primarily belongs to API contracts.

## Read First

1. `docs/reference/architecture/architecture.md`
2. `docs/reference/architecture/api-contracts.md`
3. `consent-protocol/docs/README.md`

## Workflow

1. Confirm the runtime boundary before moving code between routes, services, or integrations.
2. Keep backend tests and backend docs aligned with runtime changes.
3. Treat consent validation, trust, and audit rules as `security-audit` concerns when they become the primary boundary.

## Handoff Rules

1. If the request is still broad or ambiguous, route it back to `backend`.
2. If the task is primarily a proxy/backend wire contract, use `backend-api-contracts`.
3. If the task is primarily about agents or operons, use `backend-agents-operons`.
4. If the task becomes trust/IAM/vault policy work, route to `security-audit`.

## Required Checks

```bash
cd consent-protocol && python3 -m pytest tests/services -q
```
