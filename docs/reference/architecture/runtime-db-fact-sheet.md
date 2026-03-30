# Runtime DB Fact Sheet (Sanitized)


## Visual Context

Canonical visual owner: [Architecture Index](README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

This appendix records the runtime database shape that matters for Kai, PKM, consent, and IAM. It is documentation-only and intentionally excludes credentials, row payloads, and any user-secret values.

- Captured at (UTC): `2026-03-20T00:00:00Z`
- Source: read-only introspection against the live UAT-backed local environment
- Schema: `public`

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

1. legacy encrypted blob table
2. legacy metadata index table

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
