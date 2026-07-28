# Runtime DB Fact Sheet (Sanitized)


## Visual Context

Canonical visual owner: [Architecture Index](README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

This appendix records the runtime database shape that matters for One, Kai, Nav/KYC, PKM, consent, IAM, provider caches, and regulated workflow state. It is documentation-only and intentionally excludes credentials, row payloads, and any user-secret values.

- Source of truth: [runtime-db-data-plane-contract.json](./runtime-db-data-plane-contract.json)
  (table families) and `consent-protocol/db/contracts/prod_core_schema.json`
  (the exact table set both UAT and production must satisfy)
- Schema: `public`

This page summarizes those two contract files in prose. When they disagree, the
contract files win, and this page is the thing to correct. Do not add a
hand-maintained table list here: it drifts the moment a migration lands.

## Canonical Data-Plane Contract

Human maintainer SOP: [data-model-governance.md](./data-model-governance.md).

Machine-readable contract: [runtime-db-data-plane-contract.json](./runtime-db-data-plane-contract.json).

The production rule is to govern table families, not create a giant table-by-table SOP. Every table family has an owner, data class, retention policy, deletion behavior, access path, and trust boundary.

| Data class | Meaning | Default retention |
| --- | --- | --- |
| `personal_encrypted` | User-private ciphertext, hashes, encrypted wrappers, or legacy ciphertext during cutover | account/domain lifetime |
| `personal_metadata` | Queryable user metadata, manifests, scope handles, persona state, or relationship metadata | account/relationship lifetime |
| `workflow_state` | KYC, consent export, PKM upgrade, and other active workflow records | active workflow plus short terminal window |
| `provider_cache` | Plaid, Gmail, market, and other provider-derived operational caches | short by default; refreshable or purgeable |
| `audit_regulated` | Consent, internal access, funding/trading, and regulated operational evidence | long-retention metadata |
| `reference` | Shared non-user-private reference data | refreshable/rebuildable |

Production readiness is blocked when:

1. a migration creates an unclassified table
2. a table family lacks owner, retention, deletion, access-path, or trust-boundary metadata
3. new canonical writes target legacy memory tables
4. provider caches are described as durable user memory
5. app DB tables are used as analytics source of truth instead of GA4/BigQuery reporting planes

Run:

```bash
./bin/hushh codex data-model-audit
```

## Current Table Families

Every family below carries its own owner, retention policy, deletion behavior,
access path, trust boundary, and plaintext posture in the contract file. Read
that file for the full record; this table is the index.

| Family | Data class | Owner | Coverage |
| --- | --- | --- | --- |
| `actor_identity_state` | `personal_metadata` | `iam-consent-governance` | 5 tables |
| `agent_chat_encrypted_memory` | `personal_encrypted` | `backend-agents-operons` | 2 tables |
| `consent_authority_audit` | `audit_regulated` | `iam-consent-governance` | 3 tables |
| `consent_export_workflows` | `workflow_state` | `iam-consent-governance` | 2 tables |
| `developer_access` | `audit_regulated` | `mcp-developer-surface` | `developer_*` |
| `feed_events` | `workflow_state` | `backend-runtime-governance` | 1 table |
| `funding_trading_audit` | `audit_regulated` | `backend-runtime-governance` | `kai_funding_*` |
| `information_marketplace_delivery` | `workflow_state` | `iam-consent-governance` | 2 tables |
| `information_marketplace_opportunity_signals` | `workflow_state` | `iam-consent-governance` | 1 table |
| `information_marketplace_requests` | `workflow_state` | `iam-consent-governance` | 1 table |
| `kai_brokerage_provider_cache` | `provider_cache` | `backend-runtime-governance` | `kai_plaid_*`, `kai_portfolio_source_preferences` |
| `kai_gmail_receipts_provider_cache` | `provider_cache` | `backend-runtime-governance` | 4 tables |
| `market_reference_and_cache` | `reference` | `backend-runtime-governance` | `tickers`, `ticker_*`, `renaissance_*`, `kai_market_cache_entries` |
| `one_action_directive_authority` | `workflow_state` | `backend-agents-operons` | 1 table |
| `one_email_kyc_workflow` | `workflow_state` | `backend-runtime-governance` | 4 tables |
| `one_location_agent` | `workflow_state` | `iam-consent-governance` | 12 tables |
| `pkm_default_available_projection` | `personal_projection` | `vault-pkm-governance` | 1 table |
| `pkm_encrypted_memory` | `personal_encrypted` | `vault-pkm-governance` | 3 tables |
| `pkm_metadata_and_scope` | `personal_metadata` | `vault-pkm-governance` | 5 tables |
| `pkm_upgrade_workflows` | `workflow_state` | `vault-pkm-governance` | 5 tables |
| `preference_world_model` | `personal_metadata` | `iam-consent-governance` | 1 table |
| `public_investor_reference` | `reference` | `backend-api-contracts` | 2 tables |
| `relay_ticket_replay_guard` | `workflow_state` | `iam-consent-governance` | 1 table |
| `ria_marketplace_relationships` | `personal_metadata` | `iam-consent-governance` | `ria_*`, `advisor_investor_relationships`, `marketplace_investor_actions`, `marketplace_public_profiles`, `relationship_share_*` |
| `subscription_fabric_grants` | `personal_metadata` | `iam-consent-governance` | 1 table |
| `subscription_fabric_receipts` | `audit_regulated` | `iam-consent-governance` | 1 table |
| `subscription_fabric_requests` | `workflow_state` | `iam-consent-governance` | 1 table |
| `trusted_connections_graph` | `workflow_state` | `iam-consent-governance` | 1 table |
| `two_way_connection_graph` | `workflow_state` | `iam-consent-governance` | 2 tables |
| `vault_key_material` | `personal_encrypted` | `vault-pkm-governance` | 2 tables |
| `connected_system_audit` *(customer0)* | `audit_regulated` | `iam-consent-governance` | 1 table |
| `connected_system_workflows` *(customer0)* | `workflow_state` | `iam-consent-governance` | 2 tables |
| `crm_schema_mapping_cache` *(customer0)* | `provider_cache` | `backend-agents-operons` | 2 tables |
| `domain_reference_registry` *(transitional)* | `reference` | `vault-pkm-governance` | 1 table |
| `enterprise_crm_registry` *(customer0)* | `reference` | `iam-consent-governance` | 2 tables |
| `enterprise_crm_registry_audit` *(customer0)* | `audit_regulated` | `iam-consent-governance` | 1 table |
| `legacy_memory_cutover` *(legacy_migration)* | `personal_encrypted` | `vault-pkm-governance` | 10 tables |

## Identity Boundary Rule

`actor_profiles` is the long-term actor/persona parent for application domains. `vault_keys` remains vault state and must not become the default foreign-key parent for unrelated future domains. New tables should reference `actor_profiles` unless they are truly vault-wrapper or vault-status rows.

## Canonical PKM Tables

1. `pkm_index`
2. `pkm_blobs`
3. `pkm_manifests`
4. `pkm_manifest_paths`
5. `pkm_scope_registry`
6. `pkm_events`
7. `pkm_migration_state`

## Legacy Transition Tables

These tables exist only for the bounded encrypted-user cutover window. No new product writes should target them.

1. `pkm_data`
2. `pkm_embeddings`
3. `world_model_*`
4. old chat/world-model tables retained only for migration compatibility or historical cleanup

## Required Table Set

The authoritative per-environment table list is not duplicated here. Both UAT and
production run the same Cloud SQL schema and both contracts use the `exact`
policy, so one file answers "which tables must exist":

- `consent-protocol/db/contracts/prod_core_schema.json`
- `consent-protocol/db/contracts/uat_integrated_schema.json`

They are table-for-table identical by policy; see
[migration-governance.md](../operations/migration-governance.md) for the contract
model and [report_prod_contract_posture.py](../../../scripts/ops/report_prod_contract_posture.py)
for the parity check (`./bin/hushh db report-prod-posture`, which exits non-zero
on any delta).

## Key Column Snapshots

### `pkm_blobs`

- `user_id` (`text`)
- `domain` (`text`)
- `segment_id` (`text`)
- `ciphertext` (`text`)
- `iv` (`text`)
- `tag` (`text`)
- `algorithm` (`text`)
- `content_revision` (`integer`)
- `manifest_revision` (`integer`)
- `size_bytes` (`integer`)
- `created_at` (`timestamp with time zone`)
- `updated_at` (`timestamp with time zone`)

### `pkm_index`

- `user_id` (`text`)
- `available_domains` (`ARRAY`)
- `domain_freshness` (`jsonb`)
- `summary_projection` (`jsonb`)
- `capability_flags` (`jsonb`)
- `activity_score` (`numeric`)
- `last_active_at` (`timestamp with time zone`)
- `total_attributes` (`integer`)
- `created_at` (`timestamp with time zone`)
- `updated_at` (`timestamp with time zone`)

### `pkm_scope_registry`

- `user_id` (`text`)
- `domain` (`text`)
- `scope_handle` (`text`)
- `scope_label` (`text`)
- `segment_ids` (`ARRAY`)
- `sensitivity_tier` (`text`)
- `manifest_revision` (`integer`)
- `exposure_enabled` (`boolean`)
- `created_at` (`timestamp with time zone`)
- `updated_at` (`timestamp with time zone`)

### `vault_keys`

- `user_id` (`text`)
- `vault_key_hash` (`text`)
- `primary_method` (`text`)
- `recovery_encrypted_vault_key` (`text`)
- `recovery_salt` (`text`)
- `recovery_iv` (`text`)
- `created_at` (`bigint`)
- `updated_at` (`bigint`)
- `primary_wrapper_id` (`text`)
- `vault_status` (`text`)
- `first_login_at` (`bigint`)
- `last_login_at` (`bigint`)
- `login_count` (`integer`)
- `setup_completed` (`boolean`)
- `setup_skipped` (`boolean`)
- `setup_completed_at` (`bigint`)
- `setup_capability_ids` (`jsonb`)
- `setup_capabilities_updated_at` (`bigint`)
- `nav_setup_completed_at` (`bigint`)
- `nav_setup_skipped_at` (`bigint`)
- `setup_state_updated_at` (`bigint`)

## Core Application Functions Observed

The `public` schema also includes extension/operator functions (vector/trigram) that are omitted here for readability. Core app-facing functions observed:

1. `consent_audit_notify()`
2. `auto_register_domain(p_domain text, p_label text, p_category text, p_description text)`
3. legacy metadata compatibility helper retained during cutover
4. legacy timestamp compatibility helper retained during cutover

## Reproducibility

Use a read-only introspection query set against `information_schema`, `pg_catalog.pg_tables`, and `pg_proc` to refresh this file. Do not include credentials or data rows in documentation artifacts.

Use [runtime-db-data-plane-contract.json](./runtime-db-data-plane-contract.json) and `./bin/hushh codex data-model-audit` to verify that newly created tables are classified and that legacy memory tables are not reintroduced as canonical write targets.
