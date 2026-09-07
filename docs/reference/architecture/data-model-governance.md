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

### Gmail cache maintenance

Gmail token refresh binds its result to the observed active connection's encrypted
refresh-token envelope and token timestamp. A delayed success or failure cannot
overwrite a disconnect, reconnect or competing refresh; it returns a retryable 409.
Revoked connections refuse credential decryption. Provider error details are omitted
from refresh failures and stored reauthorization diagnostics. This fences refresh
persistence only: already admitted provider calls, disconnect ordering, receipt and
preview publication still require separate lifecycle handling.

Terminal sync-run metadata expires after **30 days** from `completed_at`. For
legacy terminal rows without a completion timestamp, `updated_at` is the
conservative fallback: an old request may have completed recently. A row without
either timestamp remains unresolved and is not deleted. Queued/running runs are
excluded. Preview artifacts expire **seven days** after `created_at`; subsequent
updates or PKM persistence acknowledgement do not renew that period.

These are engineering policy choices: one month supports incident investigation,
while the richer, rebuildable preview has a shorter lifetime. They are not measured
optimal values. Runtime readers refuse expired rows independently of physical
compaction. Separately consented encrypted PKM remains authoritative and is untouched.

Use the existing `data-model-audit` workflow for manual maintenance. Populate the
following variables through the existing authorized credential/runbook path, keeping
their values in process memory. The command accepts variable **names**, not secrets
or owner identifiers in arguments:

```bash
uv run --project consent-protocol python scripts/ops/gmail_cache_retention.py \
  --database-url-env GMAIL_RETENTION_DATABASE_URL \
  --owner-id-env GMAIL_RETENTION_OWNER_ID
```

The default is a read-only report for exactly one explicit owner. After reviewing the
bound environment and owner scope, add `--apply` to delete one batch per table;
`--batch-limit` defaults to 200 and cannot exceed 1,000. Re-run and inspect aggregate
remaining counts until the authorized scope is drained. Exit 0 means the observed
scope had no expired or undated rows; exit 2 means remaining or unavailable scope;
exit 1 means failure. A capped count is a lower bound. Locked rows remain visible in
remaining observations, and errors roll back the batch. An uncertain commit never
reports success; a repeated batch is idempotent.

Every invocation uses one PostgreSQL transaction clock, explicit public tables,
owner predicates, row locking, RLS-filter refusal, and statement/lock timeouts.
`LIMIT` bounds returned/deleted rows, not scan cost. Existing owner-prefix indexes
serve this deliberately owner-scoped tool; global cleanup is not supported. A
large owner can hit the timeout and remains incomplete until query/index remediation.

No schedule is added. Physical rows can remain after read expiry until manual
maintenance runs. `scope_drained` describes READ COMMITTED observations across two
cache families; it is not an atomic fleet snapshot, a fence against later writes, or
provider/backup/account erasure evidence. Disconnect cleanup and stale-worker
publication fencing are separate outstanding corrections. The report-only retention
registry remains an inventory declaration, not proof that a scheduled job exists.

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

The default data-model audit is a static migration/contract and legacy-write
scan. Its successful result does not verify a deployed database. Optional live
statistics use the existing backend environment and an already resolved,
authorized connection variable:

```bash
uv run --directory consent-protocol ../bin/hushh codex data-model-audit --database-url-env AUDIT_DATABASE_URL --json
```

Resolve credentials through the existing environment runbook in process memory;
do not paste their values into shell commands or artifacts. The legacy
`--database-url` flag remains compatible but exposes its argument to the shell
and process listing. The env-name path avoids copying that value into child
process arguments or reports.

`live_observation` distinguishes `not_requested`, `verified`, and `unavailable`.
A requested missing connection, driver failure, refused query, timeout, or
malformed result fails the audit while preserving the static findings. A verified
empty query is distinct from an unavailable query. Live statistics cover only the
25 largest `public` tables and catalog row estimates. They do not establish a
complete table inventory, schema/migration alignment, ownership, encryption,
retention, deletion, or intended deployment identity. Record the revision and
environment separately and keep the schema checks below.

The connection is read-only, with connect, statement, lock, and idle-transaction
timeouts. These bound individual operations, not total wall-clock time across
multiple connection hosts. Closing the connection rolls back its read-only
transaction; this audit does not run migrations or repair information.

Add `--pkm-aggregates` for five explicit structural observations: current envelope
field presence and negative revisions; owner/domain key presence; blob/manifest
association; archived-segment parent/envelope shape; and commit/revision scope
consistency. These queries return counts only, after a real-table and column/type
preflight. PostgreSQL's `row_security=off` rejects a query that would otherwise
return RLS-filtered information; it does not grant access or bypass a policy.
Insufficient privilege, missing schema, timeouts and malformed results remain
unavailable. A verified query with positive findings fails the audit and never
authorizes repair or deletion. `NULL` archived commit references are legitimate.

These observations do not decrypt or validate ciphertext, establish valid owner
identities or consent, measure retention, or prove erasure. An aggregate returns
few rows but may scan an entire relation; statement/lock timeouts bound that work.
The database rehearsal in `test_data_model_audit_postgres.py` creates and removes
its own socket-only PostgreSQL cluster, with synthetic defects and a role whose
reads would be filtered. A test host lacking server binaries records a skip;
run it on a host with those binaries before crediting that rehearsal.

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
