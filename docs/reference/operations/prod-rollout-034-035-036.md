# Production Rollout Plan for Migrations 034-036


## Visual Context

Canonical visual owner: [Operations Index](README.md). Use that map for the top-down system view; this page is the narrower detail beneath it.

This runbook is intentionally read-only planning in the current pass. It exists
so the next production rollout of the newer PKM, strict-ZK consent export, and
RIA relationship-share schema can be executed without rediscovery.

Scope:

- `034_pkm_upgrade_engine.sql`
- `035_strict_zero_knowledge_consent_exports.sql`
- `036_relationship_share_grants.sql`

Do not apply these migrations to production until the product/runtime rollout is
explicitly approved.

## What Changes

1. `034_pkm_upgrade_engine.sql`
- adds `pkm_upgrade_runs`
- adds `pkm_upgrade_steps`
- adds PKM model-version metadata columns

2. `035_strict_zero_knowledge_consent_exports.sql`
- evolves `consent_exports` from legacy `export_key` storage toward wrapped-key metadata
- adds `consent_export_refresh_jobs`
- adds refresh bookkeeping required by the on-device export refresh path

3. `036_relationship_share_grants.sql`
- adds `relationship_share_grants`
- adds `relationship_share_events`
- backfills implicit advisor-picks grants for already-approved relationships

## Preflight

1. Confirm the production deploy branch contains the approved application code for the feature set.
2. Run the production backup freshness gate and capture the report artifact.
3. Run the production migration governance guard with the production-pinned contract:

```bash
python3 scripts/ops/db_migration_release_guard.py \
  --contract-file consent-protocol/db/schema_contract/prod_core_schema.json \
  --report-path /tmp/prod-db-migration-guard-report.json
```

4. Generate the production migration release manifest:

```bash
python3 scripts/ops/generate_migration_release_manifest.py \
  --output /tmp/prod-migration-release-manifest.json \
  --environment production \
  --backup-report-path /tmp/prod-backup-posture-report.json
```

## Rollout Order

1. Apply `034_pkm_upgrade_engine.sql`
2. Apply `035_strict_zero_knowledge_consent_exports.sql`
3. Apply `036_relationship_share_grants.sql`
4. Run read-only schema verification against the future rollout contract that includes these objects
5. Deploy backend
6. Run post-deploy smoke for:
- PKM upgrade status
- strict-ZK developer consent export retrieval
- consent export refresh queue
- RIA relationship-share picks gating

## Post-Rollout Contract Update

When production is actually moved onto this schema lane:

1. update `consent-protocol/db/schema_contract/prod_core_schema.json`
2. raise its `expected_migration_version`
3. update any production-only docs that still describe the older consent export contract
4. keep `uat_integrated_schema.json` aligned to the latest integrated release lane

## Notes

- UAT already serves as the latest integrated schema lane and should stay ahead of production.
- Production governance should remain read-only until rollout approval is explicit.
- The migration runner source of truth is `consent-protocol/db/release_migration_manifest.json`.
