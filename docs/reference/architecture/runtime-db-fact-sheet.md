# Runtime DB Fact Sheet (Sanitized)


## Visual Context

Canonical visual owner: [Architecture Index](README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

This appendix records the runtime database shape that matters for One, Kai, Nav/KYC, PKM, consent, IAM, provider caches, and regulated workflow state. It is documentation-only and intentionally excludes credentials, row payloads, and any user-secret values.

- Captured at (UTC): `2026-03-20T00:00:00Z`
- Source: read-only introspection against the live UAT-backed local environment
- Schema: `public`

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

| Family | Data class | Owner | Boundary |
| --- | --- | --- | --- |
| Vault key material | `personal_encrypted` | `vault-pkm-governance` | encrypted/hash-only vault state; not the general user model |
| Actor identity state | `personal_metadata` | `iam-consent-governance` | actor/profile/persona/push metadata |
| Consent authority audit | `audit_regulated` | `iam-consent-governance` | metadata audit; rows do not grant authority by themselves |
| Consent export workflows | `workflow_state` | `iam-consent-governance` | encrypted exports and wrapped-key metadata only |
| PKM encrypted memory | `personal_encrypted` | `vault-pkm-governance` | ciphertext segments; backend does not inspect plaintext PKM |
| PKM metadata and scope | `personal_metadata` | `vault-pkm-governance` | manifests, scope handles, index metadata, replay metadata |
| PKM upgrade workflows | `workflow_state` | `vault-pkm-governance` | client-side decrypt/transform/re-encrypt checkpoints |
| Legacy memory cutover | `personal_encrypted` | `vault-pkm-governance` | no new canonical writes; delete after cutover evidence |
| RIA marketplace relationships | `personal_metadata` | `iam-consent-governance` | professional/relationship metadata, not investor PKM |
| Kai brokerage provider cache | `provider_cache` | `backend-runtime-governance` | encrypted tokens and bounded derived state |
| Kai Gmail receipt cache | `provider_cache` | `backend-runtime-governance` | receipt summaries/previews; durable memory requires PKM write |
| Market reference and cache | `reference` | `backend-runtime-governance` | shared market/reference data |
| Funding/trading audit | `audit_regulated` | `backend-runtime-governance` | money-movement and trade-execution metadata |
| One email KYC workflow | `workflow_state` | `backend-runtime-governance` | metadata and approval drafts; no raw mailbox memory |
| Developer access | `audit_regulated` | `mcp-developer-surface` | developer metadata and token hashes/wrappers |

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

## Shared Application Tables

1. `actor_profiles`
2. `advisor_investor_relationships`
3. `consent_audit`
4. `consent_exports`
5. `consent_scope_templates`
6. `developer_applications`
7. `developer_apps`
8. `developer_tokens`
9. `domain_registry`
10. `kai_market_cache_entries`
11. `kai_plaid_items`
12. `kai_plaid_link_sessions`
13. `kai_plaid_refresh_runs`
14. `kai_portfolio_source_preferences`
15. `marketplace_public_profiles`
16. `renaissance_avoid`
17. `renaissance_screening_criteria`
18. `renaissance_universe`
19. `ria_client_invites`
20. `ria_firm_memberships`
21. `ria_firms`
22. `ria_profiles`
23. `ria_verification_events`
24. `runtime_persona_state`
25. `tickers`
26. `user_push_tokens`
27. `vault_key_wrappers`
28. `vault_keys`

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
- `pre_onboarding_completed` (`boolean`)
- `pre_onboarding_skipped` (`boolean`)
- `pre_onboarding_completed_at` (`bigint`)
- `pre_nav_tour_completed_at` (`bigint`)
- `pre_nav_tour_skipped_at` (`bigint`)
- `pre_state_updated_at` (`bigint`)

## Core Application Functions Observed

The `public` schema also includes extension/operator functions (vector/trigram) that are omitted here for readability. Core app-facing functions observed:

1. `consent_audit_notify()`
2. `auto_register_domain(p_domain text, p_label text, p_category text, p_description text)`
3. legacy metadata compatibility helper retained during cutover
4. legacy timestamp compatibility helper retained during cutover

## Reproducibility

Use a read-only introspection query set against `information_schema`, `pg_catalog.pg_tables`, and `pg_proc` to refresh this file. Do not include credentials or data rows in documentation artifacts.

Use [runtime-db-data-plane-contract.json](./runtime-db-data-plane-contract.json) and `./bin/hushh codex data-model-audit` to verify that newly created tables are classified and that legacy memory tables are not reintroduced as canonical write targets.
