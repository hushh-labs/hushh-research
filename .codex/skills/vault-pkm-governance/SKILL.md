---
name: vault-pkm-governance
description: Use when changing vault boundaries, PKM storage rules, encrypted data handling, or vault/PKM upgrade behavior inside the security-audit owner family.
---

# Hussh Vault PKM Governance Skill

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

1. Broad security intake where the correct spoke is unclear.
2. IAM scope, actor model, or verification-gate work.
3. Generic backend route/service ownership work.

## Read First

1. `consent-protocol/docs/reference/personal-knowledge-model.md`
2. `docs/reference/architecture/pkm-cutover-runbook.md`
3. `docs/project_context_map.md`
4. `.codex/skills/vault-pkm-governance/references/vault-pkm-browser-data-boundary.md`

## Workflow

1. Confirm whether the change touches encrypted storage, upgrade flow, unlock behavior, or PKM domain data rules.
2. Keep frontend and backend boundaries aligned around the same vault/PKM contract.
3. Treat vault keys and owner tokens as memory-only runtime state.
4. Use route/service tests or metadata proof before browser proof when sufficient.
5. For protected route behavior, distinguish same-session navigation from cold-entry re-unlock.
6. Treat PKM manifests as authority and `pkm_index` as discovery cache.
7. Require data-plane classification for PKM/vault/legacy-memory migrations before production readiness.
8. Route IAM, consent, and verification policy questions to `iam-consent-governance` when they become primary.

## Handoff Rules

1. Broad or ambiguous security work routes back to `security-audit`.
2. IAM or consent-scope work routes to `iam-consent-governance`.
3. General backend runtime work routes to `backend`.

## Required Checks

```bash
cd consent-protocol && python3 -m pytest tests/test_vault.py -q
cd hushh-webapp && npm run verify:cache
./bin/hushh codex data-model-audit
```
