---
name: backend-api-contracts
description: Use when changing backend API contracts, Next.js proxy-to-backend contracts, or route-level request/response boundaries.
---

# Hushh Backend API Contracts Skill

## Purpose and Trigger

- Primary scope: `backend-api-contracts`
- Trigger on backend API contract changes, Next.js proxy alignment, and route-level request/response boundary work.
- Avoid overlap with `backend-runtime-governance` and `frontend-architecture`.

## Coverage and Ownership

- Role: `spoke`
- Owner family: `backend`

Owned repo surfaces:

1. `consent-protocol/api/routes`
2. `hushh-webapp/app/api`
3. `docs/reference/architecture/api-contracts.md`

Non-owned surfaces:

1. `backend`
2. `frontend`
3. `security-audit`

## Do Use

1. Backend route contract changes.
2. Next.js proxy-to-backend request and response alignment.
3. API-doc and proxy-contract updates tied to runtime behavior.

## Do Not Use

1. Broad backend intake where the correct spoke is still unclear.
2. Service-layer placement or runtime ownership work without a contract change.
3. Native plugin contract work.

## Read First

1. `docs/reference/architecture/api-contracts.md`
2. `docs/guides/new-feature.md`
3. `consent-protocol/api/routes`

## Workflow

1. Treat the backend route and the Next.js proxy as one contract surface.
2. Keep docs and tests aligned with any wire-shape or endpoint change.
3. Route trust/IAM-specific authorization policy questions into `security-audit`.

## Handoff Rules

1. If the request is still broad or ambiguous, route it back to `backend`.
2. If the task becomes route/service ownership instead of API contract work, use `backend-runtime-governance`.
3. If the task becomes frontend route architecture rather than proxy contract alignment, use `frontend`.

## Required Checks

```bash
cd hushh-webapp && npm run typecheck
cd consent-protocol && python3 -m pytest tests/test_developer_api_routes.py -q
```
