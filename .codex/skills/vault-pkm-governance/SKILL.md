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
5. Reviewer/browser proof must use the current reviewer fixture from runtime env (`REVIEWER_UID` plus the vault passphrase overlay) and validate as the vault owner. With the flipped Email Helper data model, the actor under test is the resolved vault-owner sender account, not copied recipients, counterparties, or global fixtures.
6. For protected route behavior, distinguish same-session navigation from cold-entry re-unlock.
7. Treat PKM manifests as authority and `pkm_index` as discovery cache.
8. If fixture data is missing for the env-wired reviewer, repair or reseed that reviewer account instead of testing against a different UID or email.
9. Require data-plane classification for PKM/vault/legacy-memory migrations before production readiness.
10. Keep PKM/vault upgrade diagnostics out of consumer UI. Use plain terms such as `personal data`, `saved details`, and `sharing`; reserve `PKM`, manifests, schemas, timings, and correlation ids for logs, docs, and developer-only tools.
11. Treat PKM section visibility as three protocol postures, not a Boolean: `private`, `consent_required`, and `default_available`. `default_available` means a user-published safe projection only; never raw PKM, `pkm.read`, workflow artifacts, hashes, provenance, or broad encrypted blobs.
12. Before bumping PKM protocol or readable projection versions, run the reviewer-backed active shape audit in read-only mode: `cd consent-protocol && python3 scripts/audit_active_pkm_shape_readonly.py --env-file .env`. If the local maintainer env lacks reviewer secrets, use `--gcp-secret-project hushh-pda-uat` so Secret Manager values stay process-local. Use only redacted structural output; never paste plaintext values into chat, docs, commits, tests, or model prompts.
13. Pair PKM protocol changes with natural prompt-chain evidence from `cd consent-protocol && python3 scripts/eval_pkm_structure_agent.py --phase fresh_chain_60 --env-file .env`; the eval must use `REVIEWER_UID` as the first shadow user when present and should exercise create/extend/correct/delete/no-op behavior over the reviewer-shaped manifest/scope surface. For protocol or prompt hardening, add `--enforce-gates` once the change is expected to pass so fallback, mutation, domain, fragmentation, finance-contamination, and unresolved-domain drift cannot regress silently.
14. Route IAM, consent, and verification policy questions to `iam-consent-governance` when they become primary.

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
