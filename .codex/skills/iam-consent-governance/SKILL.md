---
name: iam-consent-governance
description: Use when changing IAM, consent scopes, actor model, verification policy, or marketplace access contracts inside the security-audit owner family.
---

# Hushh IAM Consent Governance Skill

## Purpose and Trigger

- Primary scope: `iam-consent-governance`
- Trigger on IAM, consent scopes, actor model, verification policy, or marketplace access contract changes.
- Avoid overlap with `vault-pkm-governance` and `quality-contracts`.

## Coverage and Ownership

- Role: `spoke`
- Owner family: `security-audit`

Owned repo surfaces:

1. `docs/reference/iam`
2. `consent-protocol/api/routes/iam.py`
3. `consent-protocol/api/routes/consent.py`
4. `hushh-webapp/lib/consent`
5. `hushh-webapp/components/consent`
6. `hushh-webapp/components/iam`

Non-owned surfaces:

1. `security-audit`
2. `backend`
3. `docs-governance`

## Do Use

1. Consent-scope, actor-model, and verification-gate changes.
2. IAM runtime surface and marketplace access contract work.
3. IAM docs and code alignment across frontend and backend.

## Do Not Use

1. Broad security intake where the correct spoke is still unclear.
2. Vault and PKM storage or encryption-boundary work.
3. Generic backend runtime or deploy work.

## Read First

1. `docs/reference/iam/README.md`
2. `docs/reference/iam/architecture.md`
3. `docs/reference/iam/consent-scope-catalog.md`
4. `docs/reference/iam/validation-checklist.md`

## Workflow

1. Confirm whether the change is about actor model, scope catalog, verification gate, or runtime surface.
2. Keep IAM docs, code, and validation checklists aligned in the same change.
3. Treat vault and PKM boundary questions as `vault-pkm-governance` work when they become primary.

## Handoff Rules

1. If the request is still broad or ambiguous, route it back to `security-audit`.
2. If the task becomes vault or PKM storage-boundary work, use `vault-pkm-governance`.
3. If the task becomes general backend runtime work, route it to `backend`.

## Required Checks

```bash
cd consent-protocol && python3 -m pytest tests/test_granular_scopes.py -q
cd consent-protocol && python3 -m pytest tests/test_ria_iam_routes.py -q
```
