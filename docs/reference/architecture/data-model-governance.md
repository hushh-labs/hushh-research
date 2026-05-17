# Data Model Governance

## Visual Context

Canonical visual owner: [Architecture Index](README.md). Use that map for the top-down system view; this page is the human SOP for maintaining runtime data models.

## Purpose

This document is the canonical maintainer guide for Hussh data-model changes. It keeps schema work aligned with the product promise:

- PKM is durable user memory.
- Vault and PKM data stay encrypted or metadata-only on the backend.
- Consent decides what agents and services may touch.
- Provider caches, workflow state, audit records, and analytics data are not durable user memory.

The machine-readable table-family contract lives in [runtime-db-data-plane-contract.json](./runtime-db-data-plane-contract.json). Do not duplicate the full contract here; update the JSON contract and let `./bin/hushh codex data-model-audit` enforce it.

## Source Of Truth

Use these in order:

1. [runtime-db-data-plane-contract.json](./runtime-db-data-plane-contract.json): table-family ownership, data class, retention, deletion, access path, and trust boundary.
2. [runtime-db-fact-sheet.md](./runtime-db-fact-sheet.md): sanitized runtime DB shape and current table-family summary.
3. [migration-governance.md](../operations/migration-governance.md): release migration authority, UAT exact contract, and production frozen contract rules.
4. [personal-knowledge-model.md](../../../consent-protocol/docs/reference/personal-knowledge-model.md): encrypted PKM storage rules.
5. [cache-coherence.md](./cache-coherence.md): frontend and backend cache boundaries.

## Data Classes

| Class | Use For | Default Rule |
| --- | --- | --- |
| `personal_encrypted` | encrypted PKM blobs, vault wrappers, legacy ciphertext | retain until account/domain deletion |
| `personal_metadata` | manifests, scope handles, actor/persona metadata | retain while account or relationship exists |
| `workflow_state` | KYC, consent export, upgrade, and approval state | compact terminal sensitive state after short window |
| `provider_cache` | Plaid, Gmail, market, and provider-derived operational state | short-lived, refreshable, not durable memory |
| `audit_regulated` | consent, internal access, funding/trading evidence | long-retention metadata only |
| `reference` | shared market/reference data | rebuildable or refreshable |

## Adding Or Changing Tables

Before a migration is production-ready:

1. Add the SQL migration under `consent-protocol/db/migrations/`.
2. Update `consent-protocol/db/release_migration_manifest.json`.
3. Update `consent-protocol/db/contracts/uat_integrated_schema.json` when UAT integrated contract advances.
4. Classify every new table in [runtime-db-data-plane-contract.json](./runtime-db-data-plane-contract.json).
5. Prefer an existing table family; create a new family only when the table cannot honestly fit a current bounded context.
6. Declare owner, data class, primary access path, row-growth posture, retention policy, deletion behavior, and plaintext/ciphertext posture.
7. Run `./bin/hushh codex data-model-audit`.
8. Run `./bin/hushh db verify-release-contract`.
9. For UAT readiness, run `./bin/hushh db verify-uat-schema`.

## Identity Boundary

`actor_profiles` is the long-term actor/persona parent for application domains. `vault_keys` is vault state.

New tables should reference `actor_profiles` unless the table is specifically about vault status, vault wrappers, or encrypted key-boundary state. Do not expand `vault_keys` into a generic user model.

## PKM, Cache, Workflow, And Analytics Boundaries

- Durable personal memory belongs in encrypted PKM.
- Provider caches are operational and refreshable.
- Workflow tables hold active status, approvals, and bounded drafts.
- Audit tables preserve accountability metadata.
- GA4 and BigQuery remain analytics/reporting planes.
- Looker dashboards should read modeled analytics views, not application workflow tables.

Provider-derived data becomes durable user memory only after a consented, encrypted PKM write. A Gmail receipt summary, Plaid cache row, KYC draft, or market cache entry is not PKM by default.

## Retention And Deletion Defaults

- User-requested account deletion must delete user-scoped PKM, vault state, and workflow rows where allowed.
- Provider disconnect must revoke provider access where supported and remove provider cache state.
- Terminal KYC drafts, receipt memory previews, sync logs, and other sensitive workflow artifacts should be purged or redacted after the table-family retention window.
- Consent/audit and funding/trading records remain long-retention metadata when accountability or regulatory evidence requires it.
- Reference data is not user-delete scoped and should be rebuildable.

## Legacy Memory Rule

Legacy tables such as `pkm_data`, `pkm_embeddings`, `world_model_*`, old chat tables, and old portfolio/world-model tables are migration surfaces only.

Allowed:

- bounded cutover reads
- account deletion cleanup
- compatibility checks while a migration window remains open

Not allowed:

- new canonical product writes
- new agent memory paths
- new provider caches
- new dashboard truth

The data-model audit blocks canonical legacy writes before production readiness.

## Frontend And Backend Access Rules

Frontend:

- feature UI must not call backend APIs directly
- route proxies, service modules, or resource hooks own app data calls
- decrypted PKM, vault keys, passphrases, and vault-owner tokens remain memory-only
- cache behavior must fit `memory`, `secure_device`, `network`, or `server_cache`

Backend:

- routes validate auth, scope, and request shape
- services own workflow state and data access
- integrations own provider clients
- agents never bypass consent, vault, or service boundaries

## Required Verification

Run the smallest relevant bundle, and include the data-model audit for any table, migration, cache, or workflow-state change:

```bash
./bin/hushh codex data-model-audit
./bin/hushh db verify-release-contract
./bin/hushh db verify-uat-schema
cd hushh-webapp && npm run verify:service-boundary
cd hushh-webapp && npm run verify:cache
./bin/hushh docs verify
```

For skill/workflow changes, also run:

```bash
python3 .codex/skills/codex-skill-authoring/scripts/skill_lint.py
./bin/hushh codex audit
```
