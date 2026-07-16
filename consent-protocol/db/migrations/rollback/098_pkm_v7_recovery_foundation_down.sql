-- Guarded operational rollback for migration 098.
-- This file is intentionally excluded from the release migration manifest.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pkm_domain_revisions LIMIT 1)
     OR EXISTS (SELECT 1 FROM pkm_domain_commits LIMIT 1)
     OR EXISTS (SELECT 1 FROM pkm_upgrade_claims LIMIT 1) THEN
    RAISE EXCEPTION
      'migration_098_contains_recovery_information_disable_callers_and_retain_tables';
  END IF;
END $$;

DROP FUNCTION IF EXISTS delete_pkm_domain_v2(TEXT, TEXT);
DROP FUNCTION IF EXISTS rollback_pkm_domain_revision_v1(
  TEXT, TEXT, TEXT, UUID, INTEGER, INTEGER, UUID
);
DROP FUNCTION IF EXISTS commit_pkm_domain_mutation_v4(
  TEXT, TEXT, INTEGER, INTEGER, JSONB, JSONB, JSONB, JSONB, JSONB,
  JSONB, BOOLEAN, TEXT[], JSONB, UUID, TEXT, JSONB, JSONB, TEXT
);
DROP FUNCTION IF EXISTS prune_expired_pkm_recovery_for_user_v1(TEXT, INTEGER);
DROP FUNCTION IF EXISTS prune_expired_pkm_domain_revisions_v1(INTEGER);
DROP FUNCTION IF EXISTS archive_pkm_domain_revision_v1(TEXT, TEXT, TEXT, UUID, BOOLEAN);
DROP FUNCTION IF EXISTS issue_pkm_upgrade_claim_v1(
  TEXT, TEXT, TEXT, INTEGER, INTEGER, INTEGER, INTEGER, TEXT, TEXT, INTEGER
);
DROP FUNCTION IF EXISTS start_or_resume_pkm_upgrade_v1(
  TEXT, TEXT, INTEGER, INTEGER, TEXT, TEXT, JSONB
);
DROP FUNCTION IF EXISTS transition_pkm_upgrade_step_v1(
  TEXT, TEXT, TEXT, TEXT, JSONB, INTEGER, INTEGER, INTEGER
);
DROP FUNCTION IF EXISTS transition_pkm_upgrade_run_v1(
  TEXT, TEXT, TEXT, TEXT, BOOLEAN, TEXT, BOOLEAN
);
DROP FUNCTION IF EXISTS get_pkm_domain_snapshot_v1(TEXT, TEXT, TEXT[]);

DROP INDEX IF EXISTS idx_pkm_upgrade_runs_one_active_per_user;
ALTER TABLE pkm_upgrade_steps
  DROP COLUMN IF EXISTS preservation_receipt,
  DROP COLUMN IF EXISTS last_archived_revision_id,
  DROP COLUMN IF EXISTS last_commit_id,
  DROP COLUMN IF EXISTS last_claim_id;

DROP TABLE IF EXISTS pkm_upgrade_claims;
DROP TABLE IF EXISTS pkm_domain_commits;
DROP TABLE IF EXISTS pkm_domain_revision_segments;
DROP TABLE IF EXISTS pkm_domain_revisions;

ALTER TABLE pkm_upgrade_runs DROP COLUMN IF EXISTS mode;

ALTER TABLE pkm_scope_registry
  DROP COLUMN IF EXISTS source_kind,
  DROP COLUMN IF EXISTS scope_origin_code,
  DROP COLUMN IF EXISTS scope_origin;

ALTER TABLE pkm_manifests
  DROP COLUMN IF EXISTS latest_upgrade_commit_id,
  DROP COLUMN IF EXISTS readable_projection_version,
  DROP COLUMN IF EXISTS pkm_contract_version;

COMMIT;
