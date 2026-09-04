---
name: vault-pkm-governance
description: Use when changing vault boundaries, PKM storage rules, encrypted information handling, or ordinary vault/PKM persistence behavior inside the security-audit owner family.
---

# Hussh Vault PKM Governance Skill

## Purpose and Trigger

- Primary scope: `vault-pkm-governance`
- Trigger on vault boundaries, PKM storage rules, encrypted information handling, or ordinary persistence behavior.
- Avoid overlap with `reviewer-app-testing`, `pkm-upgrade-rehearsal`, and `iam-consent-governance`.

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
2. PKM storage, manifest, revision, and information-boundary changes.
3. Vault/PKM docs and implementation alignment across frontend and backend.
4. Provider blob, private PKM, and rebuildable local SQLite authority boundaries.

## Do Not Use

1. Broad security intake where the correct spoke is unclear.
2. Reviewer browser/BYOK rehearsal mechanics; use `reviewer-app-testing`.
3. PKM upgrade acceptance and zero-loss rehearsal; use `pkm-upgrade-rehearsal`.
4. IAM scope, actor model, or generic backend route/service ownership work.

## Read First

1. `consent-protocol/docs/reference/personal-knowledge-model.md`
2. `docs/reference/architecture/pkm-cutover-runbook.md`
3. `docs/project_context_map.md`
4. `.codex/skills/vault-pkm-governance/references/vault-pkm-browser-data-boundary.md`

## Workflow

1. Confirm whether the change touches encrypted storage, unlock behavior, manifests, revisions, or PKM domain information rules.
2. Keep frontend and backend boundaries aligned around the same vault/PKM contract.
3. Treat vault keys and owner tokens as memory-only runtime state.
4. Use route/service tests or metadata proof before browser proof when sufficient.
5. Treat PKM manifests as authority and `pkm_index` as discovery cache.
6. Keep diagnostics out of consumer UI and plaintext out of chat, docs, commits, tests, logs, and model prompts.
7. Treat PKM visibility as `private`, `consent_required`, or `default_available`; the last is an owner-published safe projection, never raw PKM.
8. Route reviewer runtime proof and upgrade acceptance to their dedicated spokes.
9. Keep Source Library provider files authoritative, its PKM memory private, and its SQLite mapping non-authoritative and rebuildable.

## Handoff Rules

1. Broad or ambiguous security work routes back to `security-audit`.
2. Reviewer browser/BYOK proof routes to `reviewer-app-testing`.
3. PKM protocol upgrades and preservation rehearsal route to `pkm-upgrade-rehearsal`.
4. IAM or consent-scope work routes to `iam-consent-governance`; general runtime work routes to `backend`.

## Required Checks

```bash
cd consent-protocol && python3 -m pytest tests/test_vault.py -q
cd hushh-webapp && npm run verify:cache
./bin/hushh codex data-model-audit
cd consent-protocol && python3 -m pytest tests/test_source_library_scope_policy.py -q
```
