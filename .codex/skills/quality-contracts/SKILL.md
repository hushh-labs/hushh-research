---
name: quality-contracts
description: Use when changing cross-surface verification policy, contract-test placement, test selection, or quality gates across frontend and backend.
---

# Hushh Quality Contracts Skill

## Purpose and Trigger

- Primary scope: `quality-contracts`
- Trigger on contract-test placement, test selection, route/browser verification, and cross-surface quality rules.
- Avoid overlap with `streaming-contracts` and `repo-operations`.

## Coverage and Ownership

- Role: `spoke`
- Owner family: `security-audit`

Owned repo surfaces:

1. `docs/reference/quality`
2. `hushh-webapp/__tests__`
3. `consent-protocol/tests`

Non-owned surfaces:

1. `security-audit`
2. `frontend`
3. `backend`

## Do Use

1. Test selection and contract-test placement decisions.
2. Cross-surface verification policy and quality-gate ownership.
3. Reviewing whether a code change is missing authoritative checks.

## Do Not Use

1. Broad security intake where the correct spoke is still unclear.
2. Repo-wide CI/deploy operations work.
3. Narrow streaming-protocol work when the issue is clearly about streaming only.

## Read First

1. `docs/reference/quality/README.md`
2. `docs/reference/quality/pr-impact-checklist.md`
3. `docs/reference/kai/kai-runtime-smoke-checklist.md`

## Workflow

1. Start from the contract or user-facing behavior that needs proof, then select the smallest authoritative checks.
2. Keep frontend and backend contract tests aligned with the same user-visible or policy-visible rule.
3. Treat CI pipeline ownership as `repo-operations` work unless the task is primarily about what should be verified.

## Handoff Rules

1. If the request is still broad or ambiguous, route it back to `security-audit`.
2. If the task becomes CI or deploy pipeline ownership, use `repo-operations`.
3. If the task becomes streaming-specific contract work, use `streaming-contracts`.
4. If the task becomes pure frontend or backend implementation, route to `frontend` or `backend`.

## Required Checks

```bash
cd hushh-webapp && npm test
cd consent-protocol && python3 -m pytest tests/quality -q
```
