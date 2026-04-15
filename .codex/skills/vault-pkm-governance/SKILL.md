---
name: vault-pkm-governance
description: Use when changing vault boundaries, PKM storage rules, encrypted data handling, or vault/PKM upgrade behavior inside the security-audit owner family.
---

# Hushh Vault PKM Governance Skill

## Purpose and Trigger

- Primary scope: `vault-pkm-governance`
- Trigger on vault boundaries, PKM storage rules, encrypted data handling, or vault/PKM upgrade behavior.
- Avoid overlap with `iam-consent-governance` and `quality-contracts`.

## Coverage and Ownership

- Role: `spoke`
- Owner family: `security-audit`

Owned repo surfaces:

1. `consent-protocol/hushh_mcp/vault`
2. `consent-protocol/api/routes/pkm.py`
3. `consent-protocol/api/routes/pkm_routes_shared.py`
4. `hushh-webapp/lib/vault`
5. `hushh-webapp/lib/pkm`
6. `hushh-webapp/lib/personal-knowledge-model`
7. `hushh-webapp/components/vault`

Non-owned surfaces:

1. `security-audit`
2. `backend`
3. `repo-operations`

## Do Use

1. Vault encryption, unlock, wrapper, and metadata-boundary work.
2. PKM storage, cutover, upgrade, and data-boundary changes.
3. Vault/PKM docs and implementation alignment across frontend and backend.

## Do Not Use

1. Broad security intake where the correct spoke is still unclear.
2. IAM scope, actor model, or verification-gate work.
3. Generic backend route/service ownership work.

## Read First

1. `consent-protocol/docs/reference/personal-knowledge-model.md`
2. `docs/reference/architecture/pkm-cutover-runbook.md`
3. `docs/project_context_map.md`

## Workflow

1. Confirm whether the change touches encrypted storage, upgrade flow, unlock behavior, or PKM domain data rules.
2. Keep frontend and backend boundaries aligned around the same vault/PKM contract.
3. Treat the vault key and vault-owner token as memory-only runtime state, not route-persistent state.
4. When testing protected routes, distinguish clearly between:
   - same-session client navigation after unlock
   - cold deep-link entry that must re-establish unlock state
5. Do not treat `page.goto(...)` behavior as equivalent to Next client navigation for vault-protected flows.
6. Treat IAM, consent, and verification policy questions as `iam-consent-governance` work when they become primary.

## Handoff Rules

1. If the request is still broad or ambiguous, route it back to `security-audit`.
2. If the task becomes IAM or consent-scope work, use `iam-consent-governance`.
3. If the task becomes general backend runtime work, route it to `backend`.

## Required Checks

```bash
cd consent-protocol && python3 -m pytest tests/test_vault.py -q
cd hushh-webapp && npm run verify:cache
```

If the request touches protected signed-in route behavior, include one browser proof that explicitly states whether it validated same-session navigation or cold-entry re-unlock.
