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
3. [migration-governance.md](../operations/migration-governance.md): release migration authority and the exact UAT/production contract rules.
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

## Lifecycle Status

`lifecycle_status` says where a family sits in its rollout, not what it stores. Unlike `data_class` it has **no** `allowed_*` enum in the contract: `scripts/ops/data_model_audit.py` only requires the field to be non-empty, and the single behavioural branch is `startswith("legacy")`, which pulls the family's tables into the legacy-write scan. Because nothing validates the spelling, keep the vocabulary small and add a row here before introducing a new value.

| Status | Meaning |
| --- | --- |
| `current` | Applied everywhere through the release migration manifest. The default. |
| `customer0` | Live, but scoped to the Customer Zero rollout rather than general availability. |
| `dev_only` | Schema carried by the dev-only lane (`consent-protocol/db/dev_migration_manifest.json`, resolved in place from `consent-protocol/db/migrations/parked/`), deliberately absent from `release_migration_manifest.json` and therefore from UAT and production. Promotion is a manual, human-initiated step — see the promotion section of [the dev-live execution plan](../../future/personal-agent/DEV-LIVE-EXECUTION-PLAN.md). |
| `transitional` | Retained for a bounded compatibility window during an in-flight migration. |
| `legacy_migration` | Read and cleanup only. A new write is a governance failure, and the audit scans runtime source for one. |

`dev_only` is a statement about which **lane** carries the schema, not about any one database's current contents — the same way `current` does not assert a row count. A family may only be `dev_only` while its migrations stay under `migrations/parked/`; the moment they are renumbered into `migrations/` proper it becomes `current`.

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

### Deleted-account write guard

Migration 201 keeps a non-reversible SHA-256 UID tombstone and installs database guards on every current public table with a persisted scalar identity column named `user_id`, `*_user_id`, `user_<role>_id`, `firebase_uid`, or `*_firebase_uid`. This includes both ownership columns and counterpart references in relationship rows. The live parked `consent_audit_receipts.subject_id` column is an explicit audited override because migration 904 defines it as the raw Firebase/account consent subject; the generic `subject_id` name is not inferred for any other table because it may be polymorphic. `account_deletion_tombstones` itself, opaque JSON/arrays, and the separate synthetic `legacy_user_uuid` namespace are intentionally excluded.

The same versioned guard transactionally backfills and maintains
`account_identity_presence`, a monotonic hash-only registry with no raw UID or
payload. Exact phone-session cleanup validates the complete live guard catalog,
then uses this table's primary key for one negative lookup. It must not probe
every user table at request time: several high-growth identity columns are not
individually indexed, and a catalog-wide absent-UID scan would turn a safety
check into an availability failure. A UID ever seen in guarded state remains
ineligible for automatic phone-orphan deletion even if that state is later
removed.

The guard rejects every insert that references a tombstoned UID. On update it
allows an unchanged identity and a guarded `NULL`-to-identity binding, but a
non-NULL identity reference cannot be re-parented. Identity-to-`NULL` is allowed
only when the old UID's tombstone is already visible, which preserves
PostgreSQL `ON DELETE SET NULL` cleanup inside account erasure without letting
an ordinary writer detach private payload out from under a concurrent delete.
Account-deletion cleanup can still revoke or demote non-identity fields before
deleting a row. Guarded runtime writes must use PostgreSQL `READ COMMITTED`;
higher transaction isolation is rejected because its old transaction snapshot
could miss a tombstone that committed while the writer waited for the deletion
lock.

The reviewed identity `ON DELETE SET NULL` inventory is intentionally small:
`ria_client_invites.target_investor_user_id`,
`ria_client_invites.accepted_by_user_id`,
`kai_funding_reconciliation_runs.user_id`, `one_kyc_workflows.user_id`, and
`one_referral_attributions.bound_user_id`. Full deletion removes these rows
before either account root; the trigger's tombstone-visible `SET NULL` branch
also preserves legacy/root-driven cascades. Reviewed runtime assignments bind
previously-null referral/OAuth subjects, while Plaid conflict updates repeat
the same owning UID. A new ownership-transfer or identity-detach workflow must
not ship by relying on the generic trigger: update this inventory and design an
explicit deletion-safe transfer protocol first.

Migration 201 also installs a DDL event trigger that reruns
`install_account_deletion_write_guards()` after relevant `CREATE TABLE` and
`ALTER TABLE` commands, including legacy runtime table bootstraps. Later
migrations should still call the installer explicitly after adding or renaming
a matching identity column so intent is visible in review. The installer is
catalog-driven and idempotent: it updates only tables whose audited trigger
signature changed, so ordinary migration replay does not lock every account
table. Do not add a runtime bypass, attach the guard to the tombstone table, or
hide an account UID in JSON to avoid this contract. Schema rollback is
forbidden once a tombstone exists and otherwise requires a write freeze.

Each inserted row pays one configured-field extraction, shared advisory lock,
indexed tombstone lookup, and indexed presence check per distinct UID. Only the
first sighting inserts a presence marker, avoiding repeated unique-index writes
for high-volume per-user streams. Ordinary status/content updates pay no
trigger cost unless they set an identity column. Same-UID writers share the
advisory lock; only deletion takes the conflicting exclusive lock. Benchmark
bulk-ingest changes to high-growth chat, PKM, and audit/event tables, but do not
trade away the database guard for throughput.

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
