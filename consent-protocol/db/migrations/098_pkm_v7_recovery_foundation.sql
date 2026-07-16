-- Zero-loss PKM recovery foundation.
--
-- This migration is deliberately additive. It does not enable PKM v7 writes,
-- change canonical scope strings, or remove the v2/v3 mutation functions.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE pkm_manifests
  ADD COLUMN IF NOT EXISTS pkm_contract_version TEXT NOT NULL DEFAULT '0.0.0',
  ADD COLUMN IF NOT EXISTS readable_projection_version TEXT NOT NULL DEFAULT '0.0.0',
  ADD COLUMN IF NOT EXISTS latest_upgrade_commit_id UUID;

UPDATE pkm_manifests
SET pkm_contract_version = CASE
      WHEN COALESCE(summary_projection->>'pkm_contract_version', '')
        ~ '^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$'
        THEN summary_projection->>'pkm_contract_version'
      WHEN COALESCE(structure_decision->'summary_projection'->>'pkm_contract_version', '')
        ~ '^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$'
        THEN structure_decision->'summary_projection'->>'pkm_contract_version'
      ELSE pkm_contract_version
    END,
    readable_projection_version = CASE
      WHEN COALESCE(summary_projection->>'readable_projection_version', '')
        ~ '^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$'
        THEN summary_projection->>'readable_projection_version'
      WHEN COALESCE(structure_decision->'summary_projection'->>'readable_projection_version', '')
        ~ '^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$'
        THEN structure_decision->'summary_projection'->>'readable_projection_version'
      ELSE readable_projection_version
    END
WHERE pkm_contract_version = '0.0.0'
   OR readable_projection_version = '0.0.0';

ALTER TABLE pkm_scope_registry
  ADD COLUMN IF NOT EXISTS scope_origin TEXT NOT NULL DEFAULT 'dynamic',
  ADD COLUMN IF NOT EXISTS scope_origin_code TEXT NOT NULL DEFAULT 'd',
  ADD COLUMN IF NOT EXISTS source_kind TEXT NOT NULL DEFAULT 'manifest_branch';

ALTER TABLE pkm_scope_registry
  DROP CONSTRAINT IF EXISTS pkm_scope_registry_origin_check,
  DROP CONSTRAINT IF EXISTS pkm_scope_registry_origin_code_check,
  DROP CONSTRAINT IF EXISTS pkm_scope_registry_source_kind_check;

ALTER TABLE pkm_scope_registry
  ADD CONSTRAINT pkm_scope_registry_origin_check
    CHECK (scope_origin = 'dynamic'),
  ADD CONSTRAINT pkm_scope_registry_origin_code_check
    CHECK (scope_origin_code = 'd'),
  ADD CONSTRAINT pkm_scope_registry_source_kind_check
    CHECK (source_kind = 'manifest_branch');

ALTER TABLE pkm_upgrade_runs
  ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'real';

ALTER TABLE pkm_upgrade_runs
  DROP CONSTRAINT IF EXISTS pkm_upgrade_runs_mode_check;

ALTER TABLE pkm_upgrade_runs
  ADD CONSTRAINT pkm_upgrade_runs_mode_check CHECK (mode IN ('real', 'rehearsal'));

-- A previous race may have created more than one active run. Retain all rows,
-- keep the newest active run, and close only the superseded workflow records.
WITH ranked_active_runs AS (
  SELECT run_id,
         ROW_NUMBER() OVER (
           PARTITION BY user_id
           ORDER BY updated_at DESC NULLS LAST, created_at DESC, run_id DESC
         ) AS active_rank
  FROM pkm_upgrade_runs
  WHERE status IN ('planned', 'running', 'awaiting_local_auth_resume')
)
UPDATE pkm_upgrade_runs AS runs
SET status = 'canceled',
    last_error = 'superseded_by_atomic_active_run_constraint',
    updated_at = NOW()
FROM ranked_active_runs AS ranked
WHERE runs.run_id = ranked.run_id
  AND ranked.active_rank > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_pkm_upgrade_runs_one_active_per_user
  ON pkm_upgrade_runs(user_id)
  WHERE status IN ('planned', 'running', 'awaiting_local_auth_resume');

CREATE TABLE IF NOT EXISTS pkm_domain_revisions (
  revision_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  source_content_revision INTEGER NOT NULL CHECK (source_content_revision >= 0),
  source_manifest_revision INTEGER NOT NULL CHECK (source_manifest_revision >= 0),
  is_origin BOOLEAN NOT NULL DEFAULT FALSE,
  archive_reason TEXT NOT NULL CHECK (archive_reason IN ('mutation', 'upgrade', 'rollback')),
  source_commit_id UUID,
  manifest_snapshot JSONB NOT NULL DEFAULT '{}'::JSONB,
  path_rows_snapshot JSONB NOT NULL DEFAULT '[]'::JSONB,
  scope_rows_snapshot JSONB NOT NULL DEFAULT '[]'::JSONB,
  index_domain_summary_snapshot JSONB NOT NULL DEFAULT '{}'::JSONB,
  index_domain_present BOOLEAN NOT NULL DEFAULT FALSE,
  retention_expires_at TIMESTAMPTZ,
  restored_count INTEGER NOT NULL DEFAULT 0 CHECK (restored_count >= 0),
  last_restored_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, domain, source_content_revision, source_manifest_revision),
  CHECK (
    (is_origin AND retention_expires_at IS NULL)
    OR (NOT is_origin AND retention_expires_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pkm_domain_revisions_one_origin
  ON pkm_domain_revisions(user_id, domain)
  WHERE is_origin;

CREATE INDEX IF NOT EXISTS idx_pkm_domain_revisions_lookup
  ON pkm_domain_revisions(user_id, domain, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_pkm_domain_revisions_prune
  ON pkm_domain_revisions(retention_expires_at)
  WHERE NOT is_origin;

CREATE TABLE IF NOT EXISTS pkm_domain_revision_segments (
  revision_id UUID NOT NULL REFERENCES pkm_domain_revisions(revision_id) ON DELETE CASCADE,
  segment_id TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  tag TEXT NOT NULL,
  algorithm TEXT NOT NULL DEFAULT 'aes-256-gcm',
  original_content_revision INTEGER NOT NULL CHECK (original_content_revision >= 0),
  original_manifest_revision INTEGER NOT NULL CHECK (original_manifest_revision >= 0),
  size_bytes INTEGER NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (revision_id, segment_id)
);

CREATE TABLE IF NOT EXISTS pkm_domain_commits (
  commit_id UUID PRIMARY KEY,
  user_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  commit_kind TEXT NOT NULL CHECK (commit_kind IN ('mutation', 'upgrade', 'rollback')),
  request_fingerprint TEXT CHECK (
    request_fingerprint IS NULL OR request_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  run_id TEXT,
  claim_id UUID,
  expected_content_revision INTEGER NOT NULL CHECK (expected_content_revision >= 0),
  expected_manifest_revision INTEGER NOT NULL CHECK (expected_manifest_revision >= 0),
  result_content_revision INTEGER NOT NULL CHECK (result_content_revision >= 0),
  result_manifest_revision INTEGER NOT NULL CHECK (result_manifest_revision >= 0),
  archived_revision_id UUID REFERENCES pkm_domain_revisions(revision_id) ON DELETE SET NULL,
  retention_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pkm_domain_commits_lookup
  ON pkm_domain_commits(user_id, domain, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_pkm_domain_commits_retention
  ON pkm_domain_commits(retention_expires_at)
  WHERE retention_expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS pkm_upgrade_claims (
  claim_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  commit_id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  run_id TEXT NOT NULL REFERENCES pkm_upgrade_runs(run_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'issued'
    CHECK (status IN ('issued', 'committed', 'expired', 'revoked')),
  source_content_revision INTEGER NOT NULL CHECK (source_content_revision >= 0),
  source_manifest_revision INTEGER NOT NULL CHECK (source_manifest_revision >= 0),
  target_domain_contract_version INTEGER NOT NULL CHECK (target_domain_contract_version >= 0),
  target_readable_summary_version INTEGER NOT NULL CHECK (target_readable_summary_version >= 0),
  target_pkm_contract_version TEXT NOT NULL,
  target_readable_projection_version TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  committed_at TIMESTAMPTZ,
  target_content_revision INTEGER,
  target_manifest_revision INTEGER,
  archived_revision_id UUID REFERENCES pkm_domain_revisions(revision_id) ON DELETE SET NULL,
  preservation_receipt JSONB NOT NULL DEFAULT '{}'::JSONB,
  CHECK (expires_at > issued_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pkm_upgrade_claims_one_issued_per_step
  ON pkm_upgrade_claims(run_id, domain)
  WHERE status = 'issued';

CREATE INDEX IF NOT EXISTS idx_pkm_upgrade_claims_owner
  ON pkm_upgrade_claims(user_id, run_id, domain, issued_at DESC);

ALTER TABLE pkm_upgrade_steps
  ADD COLUMN IF NOT EXISTS last_claim_id UUID REFERENCES pkm_upgrade_claims(claim_id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS last_commit_id UUID,
  ADD COLUMN IF NOT EXISTS last_archived_revision_id UUID REFERENCES pkm_domain_revisions(revision_id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS preservation_receipt JSONB NOT NULL DEFAULT '{}'::JSONB;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pkm_events_operation_type_check'
  ) THEN
    ALTER TABLE pkm_events DROP CONSTRAINT pkm_events_operation_type_check;
  END IF;
END $$;

ALTER TABLE pkm_events
  ADD CONSTRAINT pkm_events_operation_type_check
  CHECK (
    operation_type IN (
      'content_write', 'structure_create', 'structure_extend', 'structure_match',
      'manifest_refresh', 'decision_projection', 'attribute_inference',
      'segment_repartition', 'legacy_cutover', 'scope_exposure_update',
      'default_projection_publish', 'default_projection_revoke',
      'upgrade_commit', 'upgrade_rollback'
    )
  );

CREATE OR REPLACE FUNCTION get_pkm_domain_snapshot_v1(
  p_user_id TEXT,
  p_domain TEXT,
  p_segment_ids TEXT[] DEFAULT ARRAY[]::TEXT[]
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_segments JSONB := '{}'::JSONB;
  v_manifest JSONB;
  v_paths JSONB := '[]'::JSONB;
  v_scopes JSONB := '[]'::JSONB;
  v_content_revision INTEGER;
  v_manifest_revision INTEGER;
  v_min_content_revision INTEGER;
  v_max_content_revision INTEGER;
  v_min_manifest_revision INTEGER;
  v_max_manifest_revision INTEGER;
  v_updated_at TIMESTAMPTZ;
  v_storage_mode TEXT := 'domain';
  v_legacy pkm_data%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id || ':' || p_domain, 0));

  SELECT MIN(content_revision), MAX(content_revision),
         MIN(manifest_revision), MAX(manifest_revision), MAX(updated_at)
  INTO v_min_content_revision, v_max_content_revision,
       v_min_manifest_revision, v_max_manifest_revision, v_updated_at
  FROM pkm_blobs
  WHERE user_id = p_user_id
    AND domain = p_domain;

  IF v_max_content_revision IS NOT NULL THEN
    IF v_min_content_revision <> v_max_content_revision
       OR v_min_manifest_revision <> v_max_manifest_revision THEN
      RAISE EXCEPTION 'mixed_pkm_domain_revisions';
    END IF;
    v_content_revision := v_max_content_revision;
    v_manifest_revision := v_max_manifest_revision;
    SELECT COALESCE(
      jsonb_object_agg(
        segment_id,
        jsonb_build_object(
          'ciphertext', ciphertext,
          'iv', iv,
          'tag', tag,
          'algorithm', algorithm
        ) ORDER BY segment_id
      ),
      '{}'::JSONB
    )
    INTO v_segments
    FROM pkm_blobs
    WHERE user_id = p_user_id
      AND domain = p_domain
      AND (
        COALESCE(array_length(p_segment_ids, 1), 0) = 0
        OR segment_id = ANY(p_segment_ids)
      );
  ELSE
    SELECT * INTO v_legacy FROM pkm_data WHERE user_id = p_user_id;
    IF NOT FOUND THEN
      RETURN NULL;
    END IF;
    v_storage_mode := 'legacy_full_blob';
    v_content_revision := COALESCE(v_legacy.data_version, 1);
    v_manifest_revision := 0;
    v_updated_at := v_legacy.updated_at;
    v_segments := jsonb_build_object(
      'root',
      jsonb_build_object(
        'ciphertext', v_legacy.encrypted_data_ciphertext,
        'iv', v_legacy.encrypted_data_iv,
        'tag', v_legacy.encrypted_data_tag,
        'algorithm', COALESCE(v_legacy.algorithm, 'aes-256-gcm')
      )
    );
  END IF;

  SELECT to_jsonb(manifest_row) INTO v_manifest
  FROM pkm_manifests AS manifest_row
  WHERE user_id = p_user_id AND domain = p_domain;

  IF v_manifest IS NOT NULL
     AND COALESCE(v_manifest->'summary_projection'->>'storage_mode', '')
         = 'legacy_full_blob' THEN
    v_storage_mode := 'legacy_full_blob';
  END IF;

  IF v_storage_mode = 'domain' THEN
    IF v_manifest IS NULL THEN
      RAISE EXCEPTION 'pkm_domain_manifest_missing';
    END IF;
    IF COALESCE((v_manifest->>'manifest_version')::INTEGER, -1) <> v_manifest_revision THEN
      RAISE EXCEPTION 'mixed_pkm_domain_revisions';
    END IF;
    IF EXISTS (
      SELECT 1
      FROM pkm_scope_registry
      WHERE user_id = p_user_id
        AND domain = p_domain
        AND manifest_version <> v_manifest_revision
    ) THEN
      RAISE EXCEPTION 'mixed_pkm_domain_revisions';
    END IF;
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(path_row) ORDER BY json_path), '[]'::JSONB)
  INTO v_paths
  FROM pkm_manifest_paths AS path_row
  WHERE user_id = p_user_id AND domain = p_domain;

  SELECT COALESCE(jsonb_agg(to_jsonb(scope_row) ORDER BY scope_handle), '[]'::JSONB)
  INTO v_scopes
  FROM pkm_scope_registry AS scope_row
  WHERE user_id = p_user_id AND domain = p_domain;

  RETURN jsonb_build_object(
    'schema_version', 'pkm_domain_snapshot.v1',
    'user_id', p_user_id,
    'domain', p_domain,
    'storage_mode', v_storage_mode,
    'content_revision', v_content_revision,
    'manifest_revision', v_manifest_revision,
    'updated_at', v_updated_at,
    'etag', 'W/"pkm:' || p_domain || ':' || v_content_revision || ':' || v_manifest_revision || '"',
    'segments', v_segments,
    'segment_ids', COALESCE((
      SELECT jsonb_agg(segment_key ORDER BY segment_key)
      FROM jsonb_object_keys(v_segments) AS keys(segment_key)
    ), '[]'::JSONB),
    'manifest', v_manifest,
    'paths', v_paths,
    'scopes', v_scopes
  );
END;
$$;

CREATE OR REPLACE FUNCTION start_or_resume_pkm_upgrade_v1(
  p_user_id TEXT,
  p_run_id TEXT,
  p_from_model_version INTEGER,
  p_to_model_version INTEGER,
  p_initiated_by TEXT,
  p_mode TEXT,
  p_step_rows JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_existing pkm_upgrade_runs%ROWTYPE;
  v_now TIMESTAMPTZ := NOW();
BEGIN
  IF p_mode <> 'real' THEN
    RAISE EXCEPTION 'unsupported_pkm_upgrade_mode';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('pkm_upgrade_run:' || p_user_id, 0));
  SELECT * INTO v_existing
  FROM pkm_upgrade_runs
  WHERE user_id = p_user_id
    AND status IN ('planned', 'running', 'awaiting_local_auth_resume')
  ORDER BY updated_at DESC, created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF FOUND THEN
    IF v_existing.status = 'awaiting_local_auth_resume' THEN
      UPDATE pkm_upgrade_runs
      SET status = 'running', resume_count = resume_count + 1,
          last_checkpoint_at = v_now, updated_at = v_now
      WHERE run_id = v_existing.run_id;
    END IF;
    RETURN jsonb_build_object('run_id', v_existing.run_id, 'created', FALSE);
  END IF;

  INSERT INTO pkm_upgrade_runs (
    run_id, user_id, status, from_model_version, to_model_version,
    current_domain, initiated_by, mode, resume_count, started_at,
    last_checkpoint_at, created_at, updated_at
  ) VALUES (
    p_run_id, p_user_id, 'running', p_from_model_version, p_to_model_version,
    NULLIF(p_step_rows->0->>'domain', ''), p_initiated_by, p_mode, 0,
    v_now, v_now, v_now, v_now
  );

  INSERT INTO pkm_upgrade_steps (
    run_id, domain, status, from_domain_contract_version,
    to_domain_contract_version, from_readable_summary_version,
    to_readable_summary_version, attempt_count, checkpoint_payload
  )
  SELECT p_run_id, row_data.domain, 'pending',
         row_data.from_domain_contract_version,
         row_data.to_domain_contract_version,
         row_data.from_readable_summary_version,
         row_data.to_readable_summary_version,
         0, '{}'::JSONB
  FROM jsonb_to_recordset(COALESCE(p_step_rows, '[]'::JSONB)) AS row_data(
    domain TEXT,
    from_domain_contract_version INTEGER,
    to_domain_contract_version INTEGER,
    from_readable_summary_version INTEGER,
    to_readable_summary_version INTEGER
  );

  RETURN jsonb_build_object('run_id', p_run_id, 'created', TRUE);
END;
$$;

CREATE OR REPLACE FUNCTION transition_pkm_upgrade_run_v1(
  p_user_id TEXT,
  p_run_id TEXT,
  p_target_status TEXT,
  p_current_domain TEXT DEFAULT NULL,
  p_set_current_domain BOOLEAN DEFAULT FALSE,
  p_last_error TEXT DEFAULT NULL,
  p_set_last_error BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_run pkm_upgrade_runs%ROWTYPE;
  v_allowed BOOLEAN := FALSE;
  v_now TIMESTAMPTZ := NOW();
BEGIN
  SELECT * INTO v_run
  FROM pkm_upgrade_runs
  WHERE run_id = p_run_id AND user_id = p_user_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pkm_upgrade_run_not_owned';
  END IF;

  v_allowed := CASE v_run.status
    WHEN 'planned' THEN p_target_status IN ('planned', 'running', 'failed', 'canceled')
    WHEN 'running' THEN p_target_status IN (
      'running', 'awaiting_local_auth_resume', 'completed', 'failed', 'canceled'
    )
    WHEN 'awaiting_local_auth_resume' THEN p_target_status IN ('running', 'failed', 'canceled')
    WHEN 'completed' THEN p_target_status = 'completed'
    WHEN 'failed' THEN p_target_status = 'failed'
    WHEN 'canceled' THEN p_target_status = 'canceled'
    ELSE FALSE
  END;
  IF NOT v_allowed THEN
    RAISE EXCEPTION 'invalid_pkm_upgrade_run_transition';
  END IF;
  IF p_target_status = 'completed' AND EXISTS (
    SELECT 1 FROM pkm_upgrade_steps
    WHERE run_id = p_run_id AND status <> 'completed'
  ) THEN
    RAISE EXCEPTION 'pkm_upgrade_run_has_unfinished_steps';
  END IF;

  UPDATE pkm_upgrade_runs
  SET status = p_target_status,
      current_domain = CASE
        WHEN p_set_current_domain THEN p_current_domain
        ELSE current_domain
      END,
      last_error = CASE
        WHEN p_set_last_error THEN p_last_error
        ELSE last_error
      END,
      last_checkpoint_at = v_now,
      completed_at = CASE
        WHEN p_target_status = 'completed' THEN COALESCE(completed_at, v_now)
        ELSE completed_at
      END,
      updated_at = v_now
  WHERE run_id = p_run_id AND user_id = p_user_id
  RETURNING * INTO v_run;

  RETURN to_jsonb(v_run);
END;
$$;

CREATE OR REPLACE FUNCTION transition_pkm_upgrade_step_v1(
  p_user_id TEXT,
  p_run_id TEXT,
  p_domain TEXT,
  p_target_status TEXT,
  p_checkpoint_payload JSONB DEFAULT '{}'::JSONB,
  p_attempt_count INTEGER DEFAULT NULL,
  p_last_completed_content_revision INTEGER DEFAULT NULL,
  p_last_completed_manifest_version INTEGER DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_run pkm_upgrade_runs%ROWTYPE;
  v_step pkm_upgrade_steps%ROWTYPE;
  v_allowed BOOLEAN := FALSE;
BEGIN
  SELECT * INTO v_run
  FROM pkm_upgrade_runs
  WHERE run_id = p_run_id AND user_id = p_user_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pkm_upgrade_run_not_owned';
  END IF;
  IF v_run.status NOT IN ('planned', 'running', 'awaiting_local_auth_resume')
     AND p_target_status NOT IN ('completed', 'failed') THEN
    RAISE EXCEPTION 'pkm_upgrade_run_inactive';
  END IF;

  SELECT * INTO v_step
  FROM pkm_upgrade_steps
  WHERE run_id = p_run_id AND domain = p_domain
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pkm_upgrade_step_not_found';
  END IF;

  v_allowed := CASE v_step.status
    WHEN 'pending' THEN p_target_status IN ('pending', 'running', 'failed')
    WHEN 'running' THEN p_target_status IN ('running', 'conflict_retry', 'completed', 'failed')
    WHEN 'conflict_retry' THEN p_target_status IN (
      'running', 'conflict_retry', 'completed', 'failed'
    )
    WHEN 'completed' THEN p_target_status = 'completed'
    WHEN 'failed' THEN p_target_status = 'failed'
    ELSE FALSE
  END;
  IF NOT v_allowed THEN
    RAISE EXCEPTION 'invalid_pkm_upgrade_step_transition';
  END IF;
  IF COALESCE(p_attempt_count, v_step.attempt_count) < 0
     OR COALESCE(p_last_completed_content_revision, 0) < 0
     OR COALESCE(p_last_completed_manifest_version, 0) < 0 THEN
    RAISE EXCEPTION 'invalid_pkm_upgrade_step_checkpoint';
  END IF;
  -- Only the atomic upgrade commit may first complete a step. The client may
  -- subsequently replay "completed" to attach a redacted checkpoint, but it
  -- cannot manufacture completion without the exact committed revisions.
  IF p_target_status = 'completed' THEN
    IF v_step.status <> 'completed' OR v_step.last_commit_id IS NULL THEN
      RAISE EXCEPTION 'pkm_upgrade_step_has_no_committed_upgrade';
    END IF;
    IF p_last_completed_content_revision IS DISTINCT FROM
         v_step.last_completed_content_revision
       OR p_last_completed_manifest_version IS DISTINCT FROM
         v_step.last_completed_manifest_version THEN
      RAISE EXCEPTION 'pkm_upgrade_step_revision_mismatch';
    END IF;
  END IF;

  UPDATE pkm_upgrade_steps
  SET status = p_target_status,
      checkpoint_payload = COALESCE(p_checkpoint_payload, '{}'::JSONB),
      attempt_count = COALESCE(p_attempt_count, attempt_count),
      last_completed_content_revision = COALESCE(
        p_last_completed_content_revision, last_completed_content_revision
      ),
      last_completed_manifest_version = COALESCE(
        p_last_completed_manifest_version, last_completed_manifest_version
      ),
      updated_at = NOW()
  WHERE run_id = p_run_id AND domain = p_domain
  RETURNING * INTO v_step;

  IF p_target_status IN ('running', 'conflict_retry') THEN
    UPDATE pkm_upgrade_runs
    SET status = 'running', current_domain = p_domain,
        last_checkpoint_at = NOW(), updated_at = NOW()
    WHERE run_id = p_run_id AND user_id = p_user_id;
  END IF;

  RETURN to_jsonb(v_step);
END;
$$;

CREATE OR REPLACE FUNCTION issue_pkm_upgrade_claim_v1(
  p_user_id TEXT,
  p_run_id TEXT,
  p_domain TEXT,
  p_source_content_revision INTEGER,
  p_source_manifest_revision INTEGER,
  p_target_domain_contract_version INTEGER,
  p_target_readable_summary_version INTEGER,
  p_target_pkm_contract_version TEXT,
  p_target_readable_projection_version TEXT,
  p_lease_seconds INTEGER DEFAULT 300
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_run pkm_upgrade_runs%ROWTYPE;
  v_step pkm_upgrade_steps%ROWTYPE;
  v_current_content_revision INTEGER;
  v_current_manifest_revision INTEGER;
  v_claim pkm_upgrade_claims%ROWTYPE;
BEGIN
  IF p_lease_seconds < 30 OR p_lease_seconds > 900 THEN
    RAISE EXCEPTION 'invalid_pkm_upgrade_claim_lease';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id || ':' || p_domain, 0));

  SELECT * INTO v_run FROM pkm_upgrade_runs
  WHERE run_id = p_run_id AND user_id = p_user_id
  FOR UPDATE;
  IF NOT FOUND OR v_run.status NOT IN ('planned', 'running', 'awaiting_local_auth_resume') THEN
    RAISE EXCEPTION 'pkm_upgrade_run_not_owned_or_inactive';
  END IF;
  SELECT * INTO v_step FROM pkm_upgrade_steps
  WHERE run_id = p_run_id AND domain = p_domain
  FOR UPDATE;
  IF NOT FOUND OR v_step.status NOT IN ('pending', 'running', 'conflict_retry') THEN
    RAISE EXCEPTION 'pkm_upgrade_step_not_claimable';
  END IF;
  IF p_target_domain_contract_version <> v_step.to_domain_contract_version
     OR p_target_readable_summary_version <> v_step.to_readable_summary_version THEN
    RAISE EXCEPTION 'pkm_upgrade_claim_target_mismatch';
  END IF;
  IF p_target_pkm_contract_version !~ '^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$'
     OR p_target_readable_projection_version !~ '^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$' THEN
    RAISE EXCEPTION 'invalid_pkm_semantic_version';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pkm_blobs
    WHERE user_id = p_user_id AND domain = p_domain
    GROUP BY user_id, domain
    HAVING MIN(content_revision) <> MAX(content_revision)
        OR MIN(manifest_revision) <> MAX(manifest_revision)
  ) THEN
    RAISE EXCEPTION 'mixed_pkm_domain_revisions';
  END IF;

  SELECT COALESCE(MAX(content_revision), 0), COALESCE(MAX(manifest_revision), 0)
  INTO v_current_content_revision, v_current_manifest_revision
  FROM pkm_blobs WHERE user_id = p_user_id AND domain = p_domain;
  IF v_current_content_revision = 0 THEN
    SELECT COALESCE(data_version, 1), 0
    INTO v_current_content_revision, v_current_manifest_revision
    FROM pkm_data
    WHERE user_id = p_user_id;
    IF NOT FOUND THEN
      v_current_content_revision := 0;
      v_current_manifest_revision := 0;
    END IF;
  END IF;
  IF v_current_content_revision <> p_source_content_revision
     OR v_current_manifest_revision <> p_source_manifest_revision THEN
    RAISE EXCEPTION 'pkm_upgrade_claim_source_revision_mismatch';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pkm_blobs WHERE user_id = p_user_id AND domain = p_domain
  ) AND COALESCE((
    SELECT manifest_version
    FROM pkm_manifests
    WHERE user_id = p_user_id AND domain = p_domain
  ), -1) <> v_current_manifest_revision THEN
    RAISE EXCEPTION 'mixed_pkm_domain_revisions';
  END IF;

  UPDATE pkm_upgrade_claims
  SET status = 'expired'
  WHERE run_id = p_run_id AND domain = p_domain AND status = 'issued';

  INSERT INTO pkm_upgrade_claims (
    run_id, user_id, domain, source_content_revision,
    source_manifest_revision, target_domain_contract_version,
    target_readable_summary_version, target_pkm_contract_version,
    target_readable_projection_version, expires_at
  ) VALUES (
    p_run_id, p_user_id, p_domain, p_source_content_revision,
    p_source_manifest_revision, p_target_domain_contract_version,
    p_target_readable_summary_version, p_target_pkm_contract_version,
    p_target_readable_projection_version,
    NOW() + make_interval(secs => p_lease_seconds)
  ) RETURNING * INTO v_claim;

  UPDATE pkm_upgrade_steps
  SET last_claim_id = v_claim.claim_id, status = 'running', updated_at = NOW()
  WHERE run_id = p_run_id AND domain = p_domain;

  RETURN jsonb_build_object(
    'schema_version', 'pkm_upgrade_claim.v1',
    'claim_id', v_claim.claim_id,
    'commit_id', v_claim.commit_id,
    'owner_user_id', v_claim.user_id,
    'run_id', v_claim.run_id,
    'domain', v_claim.domain,
    'source_content_revision', v_claim.source_content_revision,
    'source_manifest_revision', v_claim.source_manifest_revision,
    'target_domain_contract_version', v_claim.target_domain_contract_version,
    'target_readable_summary_version', v_claim.target_readable_summary_version,
    'target_pkm_contract_version', v_claim.target_pkm_contract_version,
    'target_readable_projection_version', v_claim.target_readable_projection_version,
    'expires_at', v_claim.expires_at,
    'mode', 'real'
  );
END;
$$;

CREATE OR REPLACE FUNCTION archive_pkm_domain_revision_v1(
  p_user_id TEXT,
  p_domain TEXT,
  p_archive_reason TEXT,
  p_source_commit_id UUID DEFAULT NULL,
  p_make_origin BOOLEAN DEFAULT FALSE
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_content_revision INTEGER;
  v_manifest_revision INTEGER;
  v_revision_id UUID;
  v_is_origin BOOLEAN := FALSE;
BEGIN
  IF p_archive_reason NOT IN ('mutation', 'upgrade', 'rollback') THEN
    RAISE EXCEPTION 'invalid_pkm_archive_reason';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id || ':' || p_domain, 0));
  SELECT MAX(content_revision), MAX(manifest_revision)
  INTO v_content_revision, v_manifest_revision
  FROM pkm_blobs WHERE user_id = p_user_id AND domain = p_domain;
  IF v_content_revision IS NULL THEN
    RETURN NULL;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pkm_blobs WHERE user_id = p_user_id AND domain = p_domain
    GROUP BY user_id, domain
    HAVING MIN(content_revision) <> MAX(content_revision)
        OR MIN(manifest_revision) <> MAX(manifest_revision)
  ) THEN
    RAISE EXCEPTION 'mixed_pkm_domain_revisions';
  END IF;

  v_is_origin := p_make_origin AND NOT EXISTS (
    SELECT 1 FROM pkm_domain_revisions
    WHERE user_id = p_user_id AND domain = p_domain AND is_origin
  );

  INSERT INTO pkm_domain_revisions (
    user_id, domain, source_content_revision, source_manifest_revision,
    is_origin, archive_reason, source_commit_id, manifest_snapshot,
    path_rows_snapshot, scope_rows_snapshot, index_domain_summary_snapshot,
    index_domain_present, retention_expires_at
  )
  SELECT p_user_id, p_domain, v_content_revision, v_manifest_revision,
         v_is_origin, p_archive_reason, p_source_commit_id,
         COALESCE((SELECT to_jsonb(m) FROM pkm_manifests m
                   WHERE m.user_id = p_user_id AND m.domain = p_domain), '{}'::JSONB),
         COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.json_path)
                   FROM pkm_manifest_paths p
                   WHERE p.user_id = p_user_id AND p.domain = p_domain), '[]'::JSONB),
         COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.scope_handle)
                   FROM pkm_scope_registry s
                   WHERE s.user_id = p_user_id AND s.domain = p_domain), '[]'::JSONB),
         COALESCE((SELECT i.domain_summaries->p_domain FROM pkm_index i
                   WHERE i.user_id = p_user_id), '{}'::JSONB),
         COALESCE((SELECT i.domain_summaries ? p_domain FROM pkm_index i
                   WHERE i.user_id = p_user_id), FALSE),
         CASE WHEN v_is_origin THEN NULL ELSE NOW() + INTERVAL '90 days' END
  ON CONFLICT (user_id, domain, source_content_revision, source_manifest_revision)
  DO UPDATE SET
    is_origin = pkm_domain_revisions.is_origin OR EXCLUDED.is_origin,
    retention_expires_at = CASE
      WHEN pkm_domain_revisions.is_origin OR EXCLUDED.is_origin THEN NULL
      ELSE GREATEST(pkm_domain_revisions.retention_expires_at, EXCLUDED.retention_expires_at)
    END
  RETURNING revision_id INTO v_revision_id;

  INSERT INTO pkm_domain_revision_segments (
    revision_id, segment_id, ciphertext, iv, tag, algorithm,
    original_content_revision, original_manifest_revision, size_bytes
  )
  SELECT v_revision_id, segment_id, ciphertext, iv, tag, algorithm,
         content_revision, manifest_revision, size_bytes
  FROM pkm_blobs
  WHERE user_id = p_user_id AND domain = p_domain
  ON CONFLICT (revision_id, segment_id) DO NOTHING;

  RETURN v_revision_id;
END;
$$;

CREATE OR REPLACE FUNCTION prune_expired_pkm_domain_revisions_v1(
  p_limit INTEGER DEFAULT 500
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_deleted INTEGER;
BEGIN
  WITH expired AS (
    SELECT revision_id
    FROM pkm_domain_revisions
    WHERE NOT is_origin AND retention_expires_at <= NOW()
    ORDER BY retention_expires_at
    LIMIT GREATEST(1, LEAST(p_limit, 5000))
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM pkm_domain_revisions revisions
  USING expired
  WHERE revisions.revision_id = expired.revision_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

CREATE OR REPLACE FUNCTION prune_expired_pkm_recovery_for_user_v1(
  p_user_id TEXT,
  p_limit INTEGER DEFAULT 100
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_revision_deleted INTEGER;
  v_commit_deleted INTEGER;
BEGIN
  WITH expired AS (
    SELECT revision_id
    FROM pkm_domain_revisions
    WHERE user_id = p_user_id
      AND NOT is_origin
      AND retention_expires_at <= NOW()
    ORDER BY retention_expires_at
    LIMIT GREATEST(1, LEAST(p_limit, 1000))
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM pkm_domain_revisions revisions
  USING expired
  WHERE revisions.revision_id = expired.revision_id;
  GET DIAGNOSTICS v_revision_deleted = ROW_COUNT;

  WITH expired AS (
    SELECT commit_id
    FROM pkm_domain_commits
    WHERE user_id = p_user_id
      AND retention_expires_at <= NOW()
    ORDER BY retention_expires_at
    LIMIT GREATEST(1, LEAST(p_limit, 1000))
    FOR UPDATE SKIP LOCKED
  )
  DELETE FROM pkm_domain_commits commits
  USING expired
  WHERE commits.commit_id = expired.commit_id;
  GET DIAGNOSTICS v_commit_deleted = ROW_COUNT;

  RETURN jsonb_build_object(
    'revision_deleted', v_revision_deleted,
    'commit_deleted', v_commit_deleted
  );
END;
$$;

CREATE OR REPLACE FUNCTION commit_pkm_domain_mutation_v4(
  p_user_id TEXT,
  p_domain TEXT,
  p_expected_content_revision INTEGER,
  p_next_content_revision INTEGER,
  p_segment_rows JSONB,
  p_manifest_row JSONB,
  p_path_rows JSONB,
  p_scope_rows JSONB,
  p_summary_patch JSONB,
  p_event_rows JSONB,
  p_legacy_blob_present BOOLEAN,
  p_refresh_tokens TEXT[] DEFAULT ARRAY[]::TEXT[],
  p_trigger_paths JSONB DEFAULT '[]'::JSONB,
  p_commit_id UUID DEFAULT gen_random_uuid(),
  p_commit_kind TEXT DEFAULT 'mutation',
  p_upgrade_claim JSONB DEFAULT NULL,
  p_preservation_receipt JSONB DEFAULT '{}'::JSONB,
  p_request_fingerprint TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_existing_commit pkm_domain_commits%ROWTYPE;
  v_claim pkm_upgrade_claims%ROWTYPE;
  v_current_content_revision INTEGER;
  v_current_manifest_revision INTEGER;
  v_archived_revision_id UUID;
  v_result JSONB;
  v_total INTEGER;
  v_preserved INTEGER;
  v_moved INTEGER;
  v_deduplicated INTEGER;
  v_quarantined INTEGER;
  v_rejected INTEGER;
  v_make_origin BOOLEAN := FALSE;
  v_pkm_contract_version TEXT;
  v_readable_projection_version TEXT;
  v_target_manifest_revision INTEGER;
  v_legacy pkm_data%ROWTYPE;
BEGIN
  IF p_commit_kind NOT IN ('mutation', 'upgrade') THEN
    RAISE EXCEPTION 'unsupported_pkm_commit_kind';
  END IF;
  IF p_next_content_revision <> p_expected_content_revision + 1 THEN
    RAISE EXCEPTION 'invalid_pkm_next_content_revision';
  END IF;
  IF p_request_fingerprint IS NULL
     OR p_request_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid_pkm_request_fingerprint';
  END IF;
  IF p_manifest_row IS NULL OR jsonb_typeof(p_manifest_row) <> 'object' THEN
    RAISE EXCEPTION 'pkm_manifest_required';
  END IF;
  v_target_manifest_revision := COALESCE(
    (p_manifest_row->>'manifest_version')::INTEGER,
    -1
  );
  IF v_target_manifest_revision < 1 THEN
    RAISE EXCEPTION 'invalid_pkm_manifest_revision';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(COALESCE(p_segment_rows, '[]'::JSONB)) AS segment_row(
      manifest_revision INTEGER
    )
    WHERE segment_row.manifest_revision IS DISTINCT FROM v_target_manifest_revision
  ) OR EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(COALESCE(p_scope_rows, '[]'::JSONB)) AS scope_row(
      manifest_version INTEGER
    )
    WHERE scope_row.manifest_version IS DISTINCT FROM v_target_manifest_revision
  ) THEN
    RAISE EXCEPTION 'mixed_pkm_domain_revisions';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id || ':' || p_domain, 0));

  SELECT * INTO v_existing_commit
  FROM pkm_domain_commits WHERE commit_id = p_commit_id;
  IF FOUND THEN
    IF v_existing_commit.user_id <> p_user_id
       OR v_existing_commit.domain <> p_domain
       OR v_existing_commit.commit_kind <> p_commit_kind
       OR v_existing_commit.expected_content_revision <> p_expected_content_revision
       OR v_existing_commit.request_fingerprint IS DISTINCT FROM p_request_fingerprint
       OR (
         p_commit_kind = 'upgrade'
         AND (
           p_upgrade_claim IS NULL
           OR jsonb_typeof(p_upgrade_claim) <> 'object'
           OR v_existing_commit.run_id IS DISTINCT FROM p_upgrade_claim->>'run_id'
           OR v_existing_commit.claim_id::TEXT IS DISTINCT FROM p_upgrade_claim->>'claim_id'
         )
       ) THEN
      RAISE EXCEPTION 'pkm_commit_id_binding_mismatch';
    END IF;
    RETURN jsonb_build_object(
      'success', TRUE,
      'conflict', FALSE,
      'idempotent_replay', TRUE,
      'commit_id', v_existing_commit.commit_id,
      'data_version', v_existing_commit.result_content_revision,
      'manifest_revision', v_existing_commit.result_manifest_revision,
      'archived_revision_id', v_existing_commit.archived_revision_id
    );
  END IF;

  IF p_legacy_blob_present AND NOT EXISTS (
    SELECT 1 FROM pkm_blobs WHERE user_id = p_user_id AND domain = p_domain
  ) THEN
    SELECT * INTO v_legacy FROM pkm_data WHERE user_id = p_user_id FOR UPDATE;
    IF FOUND THEN
      INSERT INTO pkm_blobs (
        user_id, domain, segment_id, ciphertext, iv, tag, algorithm,
        content_revision, manifest_revision, size_bytes, created_at, updated_at
      ) VALUES (
        p_user_id, p_domain, 'root',
        v_legacy.encrypted_data_ciphertext, v_legacy.encrypted_data_iv,
        v_legacy.encrypted_data_tag, COALESCE(v_legacy.algorithm, 'aes-256-gcm'),
        COALESCE(v_legacy.data_version, 1), 0,
        LENGTH(v_legacy.encrypted_data_ciphertext),
        COALESCE(v_legacy.created_at, NOW()), COALESCE(v_legacy.updated_at, NOW())
      );
    END IF;
  END IF;

  SELECT COALESCE(MAX(content_revision), 0), COALESCE(MAX(manifest_revision), 0)
  INTO v_current_content_revision, v_current_manifest_revision
  FROM pkm_blobs WHERE user_id = p_user_id AND domain = p_domain;

  IF v_current_content_revision <> p_expected_content_revision THEN
    RETURN jsonb_build_object(
      'success', FALSE, 'conflict', TRUE,
      'data_version', v_current_content_revision,
      'manifest_revision', v_current_manifest_revision
    );
  END IF;

  IF p_commit_kind = 'upgrade' THEN
    IF p_upgrade_claim IS NULL OR jsonb_typeof(p_upgrade_claim) <> 'object' THEN
      RAISE EXCEPTION 'pkm_upgrade_claim_required';
    END IF;
    SELECT * INTO v_claim
    FROM pkm_upgrade_claims
    WHERE claim_id = (p_upgrade_claim->>'claim_id')::UUID
      AND commit_id = p_commit_id
      AND user_id = p_user_id
      AND run_id = p_upgrade_claim->>'run_id'
      AND domain = p_domain
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'pkm_upgrade_claim_not_owned';
    END IF;
    IF v_claim.status <> 'issued' OR v_claim.expires_at <= NOW() THEN
      RAISE EXCEPTION 'pkm_upgrade_claim_inactive';
    END IF;
    IF v_claim.source_content_revision <> v_current_content_revision
       OR v_claim.source_manifest_revision <> v_current_manifest_revision THEN
      RAISE EXCEPTION 'pkm_upgrade_claim_source_revision_mismatch';
    END IF;
    IF COALESCE((p_manifest_row->>'domain_contract_version')::INTEGER, -1)
         <> v_claim.target_domain_contract_version
       OR COALESCE((p_manifest_row->>'readable_summary_version')::INTEGER, -1)
         <> v_claim.target_readable_summary_version
       OR COALESCE(p_manifest_row->>'pkm_contract_version', '')
         <> v_claim.target_pkm_contract_version
       OR COALESCE(p_manifest_row->>'readable_projection_version', '')
         <> v_claim.target_readable_projection_version THEN
      RAISE EXCEPTION 'pkm_upgrade_claim_target_mismatch';
    END IF;
    IF jsonb_typeof(p_preservation_receipt) <> 'object'
       OR jsonb_typeof(p_preservation_receipt->'total_source_occurrences') <> 'number'
       OR jsonb_typeof(p_preservation_receipt->'preserved') <> 'number'
       OR jsonb_typeof(p_preservation_receipt->'moved') <> 'number'
       OR jsonb_typeof(p_preservation_receipt->'equal_value_deduplicated') <> 'number'
       OR jsonb_typeof(p_preservation_receipt->'quarantined') <> 'number'
       OR jsonb_typeof(p_preservation_receipt->'rejected') <> 'number'
       OR COALESCE((p_preservation_receipt->>'complete')::BOOLEAN, FALSE) IS NOT TRUE THEN
      RAISE EXCEPTION 'invalid_pkm_preservation_receipt';
    END IF;
    v_total := (p_preservation_receipt->>'total_source_occurrences')::INTEGER;
    v_preserved := (p_preservation_receipt->>'preserved')::INTEGER;
    v_moved := (p_preservation_receipt->>'moved')::INTEGER;
    v_deduplicated := (p_preservation_receipt->>'equal_value_deduplicated')::INTEGER;
    v_quarantined := (p_preservation_receipt->>'quarantined')::INTEGER;
    v_rejected := (p_preservation_receipt->>'rejected')::INTEGER;
    IF LEAST(v_total, v_preserved, v_moved, v_deduplicated, v_quarantined, v_rejected) < 0
       OR v_rejected <> 0
       OR v_preserved + v_moved + v_deduplicated + v_quarantined <> v_total THEN
      RAISE EXCEPTION 'incomplete_pkm_preservation_receipt';
    END IF;
    IF v_quarantined > 0 AND NOT EXISTS (
      SELECT 1
      FROM jsonb_to_recordset(COALESCE(p_segment_rows, '[]'::JSONB)) AS segment_row(
        segment_id TEXT
      )
      WHERE segment_row.segment_id = '__quarantine_v1'
    ) THEN
      RAISE EXCEPTION 'pkm_quarantine_segment_required';
    END IF;
    v_make_origin := split_part(v_claim.target_pkm_contract_version, '.', 1)::INTEGER >= 7;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(COALESCE(p_segment_rows, '[]'::JSONB)) AS segment_row(
      segment_id TEXT
    )
    WHERE segment_row.segment_id = '__quarantine_v1'
  ) AND (
    EXISTS (
      SELECT 1
      FROM jsonb_to_recordset(COALESCE(p_path_rows, '[]'::JSONB)) AS path_row(
        json_path TEXT,
        segment_id TEXT,
        scope_handle TEXT,
        exposure_eligibility BOOLEAN
      )
      WHERE path_row.segment_id = '__quarantine_v1'
        AND (
          COALESCE(path_row.exposure_eligibility, TRUE)
          OR path_row.scope_handle IS NOT NULL
          OR path_row.json_path IN (
            SELECT jsonb_array_elements_text(
              COALESCE(p_manifest_row->'externalizable_paths', '[]'::JSONB)
            )
          )
        )
    )
    OR EXISTS (
      SELECT 1
      FROM jsonb_to_recordset(COALESCE(p_scope_rows, '[]'::JSONB)) AS scope_row(
        segment_ids TEXT[]
      )
      WHERE '__quarantine_v1' = ANY(COALESCE(scope_row.segment_ids, ARRAY[]::TEXT[]))
    )
  ) THEN
    RAISE EXCEPTION 'pkm_quarantine_must_be_private';
  END IF;

  v_archived_revision_id := archive_pkm_domain_revision_v1(
    p_user_id,
    p_domain,
    p_commit_kind,
    p_commit_id,
    v_make_origin
  );

  v_result := commit_pkm_domain_mutation_v3(
    p_user_id,
    p_domain,
    p_expected_content_revision,
    p_next_content_revision,
    p_segment_rows,
    p_manifest_row,
    p_path_rows,
    p_scope_rows,
    p_summary_patch,
    p_event_rows,
    p_legacy_blob_present,
    p_refresh_tokens,
    p_trigger_paths
  );
  IF NOT COALESCE((v_result->>'success')::BOOLEAN, FALSE) THEN
    RETURN v_result;
  END IF;

  v_pkm_contract_version := COALESCE(NULLIF(p_manifest_row->>'pkm_contract_version', ''), '0.0.0');
  v_readable_projection_version := COALESCE(
    NULLIF(p_manifest_row->>'readable_projection_version', ''), '0.0.0'
  );
  IF v_pkm_contract_version !~ '^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$'
     OR v_readable_projection_version !~ '^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$' THEN
    RAISE EXCEPTION 'invalid_pkm_semantic_version';
  END IF;

  UPDATE pkm_manifests
  SET pkm_contract_version = v_pkm_contract_version,
      readable_projection_version = v_readable_projection_version,
      latest_upgrade_commit_id = CASE
        WHEN p_commit_kind = 'upgrade' THEN p_commit_id
        ELSE latest_upgrade_commit_id
      END,
      updated_at = NOW()
  WHERE user_id = p_user_id AND domain = p_domain;

  UPDATE pkm_scope_registry
  SET scope_origin = 'dynamic', scope_origin_code = 'd',
      source_kind = 'manifest_branch', updated_at = NOW()
  WHERE user_id = p_user_id AND domain = p_domain;

  INSERT INTO pkm_domain_commits (
    commit_id, user_id, domain, commit_kind, request_fingerprint, run_id, claim_id,
    expected_content_revision, expected_manifest_revision,
    result_content_revision, result_manifest_revision,
    archived_revision_id, retention_expires_at
  ) VALUES (
    p_commit_id, p_user_id, p_domain, p_commit_kind, p_request_fingerprint,
    CASE WHEN p_commit_kind = 'upgrade' THEN v_claim.run_id ELSE NULL END,
    CASE WHEN p_commit_kind = 'upgrade' THEN v_claim.claim_id ELSE NULL END,
    p_expected_content_revision, v_current_manifest_revision,
    p_next_content_revision,
    v_target_manifest_revision,
    v_archived_revision_id,
    CASE WHEN p_commit_kind = 'upgrade' THEN NULL ELSE NOW() + INTERVAL '90 days' END
  );

  IF p_commit_kind = 'upgrade' THEN
    UPDATE pkm_upgrade_claims
    SET status = 'committed', committed_at = NOW(),
        target_content_revision = p_next_content_revision,
        target_manifest_revision = v_target_manifest_revision,
        archived_revision_id = v_archived_revision_id,
        preservation_receipt = p_preservation_receipt
    WHERE claim_id = v_claim.claim_id;

    UPDATE pkm_upgrade_steps
    SET status = 'completed', last_claim_id = v_claim.claim_id,
        last_commit_id = p_commit_id,
        last_archived_revision_id = v_archived_revision_id,
        last_completed_content_revision = p_next_content_revision,
        last_completed_manifest_version = v_target_manifest_revision,
        preservation_receipt = p_preservation_receipt,
        updated_at = NOW()
    WHERE run_id = v_claim.run_id AND domain = p_domain;

    INSERT INTO pkm_events (
      user_id, domain, operation_type, segment_ids, path_set,
      source_agent, prior_manifest_version, new_manifest_version, metadata
    ) VALUES (
      p_user_id, p_domain, 'upgrade_commit', ARRAY[]::TEXT[], '[]'::JSONB,
      'pkm_upgrade_service', v_current_manifest_revision,
      v_target_manifest_revision,
      jsonb_build_object(
        'run_id', v_claim.run_id,
        'claim_id', v_claim.claim_id,
        'commit_id', p_commit_id,
        'archived_revision_id', v_archived_revision_id,
        'preservation_receipt', p_preservation_receipt
      )
    );
  END IF;

  PERFORM prune_expired_pkm_recovery_for_user_v1(p_user_id, 100);

  RETURN v_result || jsonb_build_object(
    'idempotent_replay', FALSE,
    'commit_id', p_commit_id,
    'manifest_revision', v_target_manifest_revision,
    'archived_revision_id', v_archived_revision_id,
    'preservation_receipt', CASE
      WHEN p_commit_kind = 'upgrade' THEN p_preservation_receipt ELSE NULL
    END
  );
END;
$$;

CREATE OR REPLACE FUNCTION rollback_pkm_domain_revision_v1(
  p_user_id TEXT,
  p_run_id TEXT,
  p_domain TEXT,
  p_revision_id UUID,
  p_expected_content_revision INTEGER,
  p_expected_manifest_revision INTEGER,
  p_rollback_commit_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_run pkm_upgrade_runs%ROWTYPE;
  v_revision pkm_domain_revisions%ROWTYPE;
  v_existing_commit pkm_domain_commits%ROWTYPE;
  v_current_content_revision INTEGER;
  v_current_manifest_revision INTEGER;
  v_next_content_revision INTEGER;
  v_next_manifest_revision INTEGER;
  v_current_archive_id UUID;
  v_now TIMESTAMPTZ := NOW();
  v_restored_summary_projection JSONB;
  v_restored_index_summary JSONB;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id || ':' || p_domain, 0));
  SELECT * INTO v_existing_commit FROM pkm_domain_commits
  WHERE commit_id = p_rollback_commit_id;
  IF FOUND THEN
    IF v_existing_commit.user_id <> p_user_id
       OR v_existing_commit.domain <> p_domain
       OR v_existing_commit.commit_kind <> 'rollback'
       OR v_existing_commit.run_id IS DISTINCT FROM p_run_id
       OR v_existing_commit.expected_content_revision <> p_expected_content_revision
       OR v_existing_commit.expected_manifest_revision <> p_expected_manifest_revision THEN
      RAISE EXCEPTION 'pkm_rollback_commit_binding_mismatch';
    END IF;
    RETURN jsonb_build_object(
      'success', TRUE, 'idempotent_replay', TRUE,
      'commit_id', v_existing_commit.commit_id,
      'data_version', v_existing_commit.result_content_revision,
      'manifest_revision', v_existing_commit.result_manifest_revision
    );
  END IF;

  SELECT * INTO v_run FROM pkm_upgrade_runs
  WHERE run_id = p_run_id AND user_id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pkm_rollback_run_not_owned';
  END IF;
  SELECT * INTO v_revision FROM pkm_domain_revisions
  WHERE revision_id = p_revision_id AND user_id = p_user_id AND domain = p_domain
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pkm_revision_not_owned';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pkm_domain_commits
    WHERE user_id = p_user_id
      AND domain = p_domain
      AND run_id = p_run_id
      AND archived_revision_id = p_revision_id
      AND commit_kind IN ('upgrade', 'rollback')
  ) THEN
    RAISE EXCEPTION 'pkm_revision_not_bound_to_run';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pkm_domain_revision_segments WHERE revision_id = p_revision_id
  ) THEN
    RAISE EXCEPTION 'pkm_revision_has_no_ciphertext';
  END IF;

  SELECT COALESCE(MAX(content_revision), 0), COALESCE(MAX(manifest_revision), 0)
  INTO v_current_content_revision, v_current_manifest_revision
  FROM pkm_blobs WHERE user_id = p_user_id AND domain = p_domain;
  IF v_current_content_revision <> p_expected_content_revision
     OR v_current_manifest_revision <> p_expected_manifest_revision THEN
    RETURN jsonb_build_object(
      'success', FALSE, 'conflict', TRUE,
      'data_version', v_current_content_revision,
      'manifest_revision', v_current_manifest_revision
    );
  END IF;

  v_current_archive_id := archive_pkm_domain_revision_v1(
    p_user_id, p_domain, 'rollback', p_rollback_commit_id, FALSE
  );
  v_next_content_revision := v_current_content_revision + 1;
  v_next_manifest_revision := v_current_manifest_revision + 1;
  v_restored_summary_projection :=
    COALESCE(v_revision.manifest_snapshot->'summary_projection', '{}'::JSONB)
    || jsonb_build_object(
      'manifest_version', v_next_manifest_revision,
      'content_revision', v_next_content_revision,
      'data_version', v_next_content_revision,
      'storage_mode', CASE
        WHEN v_revision.source_manifest_revision = 0 THEN 'legacy_full_blob'
        ELSE COALESCE(
          v_revision.manifest_snapshot->'summary_projection'->>'storage_mode',
          'per_domain_blob'
        )
      END
    );
  v_restored_index_summary :=
    COALESCE(v_revision.index_domain_summary_snapshot, '{}'::JSONB)
    || jsonb_build_object(
      'manifest_version', v_next_manifest_revision,
      'content_revision', v_next_content_revision,
      'data_version', v_next_content_revision,
      'storage_mode', CASE
        WHEN v_revision.source_manifest_revision = 0 THEN 'legacy_full_blob'
        ELSE COALESCE(
          v_revision.index_domain_summary_snapshot->>'storage_mode',
          'per_domain_blob'
        )
      END
    );

  DELETE FROM pkm_blobs WHERE user_id = p_user_id AND domain = p_domain;
  INSERT INTO pkm_blobs (
    user_id, domain, segment_id, ciphertext, iv, tag, algorithm,
    content_revision, manifest_revision, size_bytes, created_at, updated_at
  )
  SELECT p_user_id, p_domain, segment_id, ciphertext, iv, tag, algorithm,
         v_next_content_revision, v_next_manifest_revision, size_bytes, v_now, v_now
  FROM pkm_domain_revision_segments
  WHERE revision_id = p_revision_id;

  INSERT INTO pkm_manifests (
    user_id, domain, manifest_version, structure_decision, summary_projection,
    top_level_scope_paths, externalizable_paths, segment_ids, path_count,
    externalizable_path_count, domain_contract_version, readable_summary_version,
    upgraded_at, last_structured_at, last_content_at,
    pkm_contract_version, readable_projection_version,
    latest_upgrade_commit_id, created_at, updated_at
  ) VALUES (
    p_user_id, p_domain, v_next_manifest_revision,
    COALESCE(v_revision.manifest_snapshot->'structure_decision', '{}'::JSONB),
    v_restored_summary_projection,
    ARRAY(SELECT jsonb_array_elements_text(COALESCE(v_revision.manifest_snapshot->'top_level_scope_paths', '[]'::JSONB))),
    ARRAY(SELECT jsonb_array_elements_text(COALESCE(v_revision.manifest_snapshot->'externalizable_paths', '[]'::JSONB))),
    ARRAY(SELECT jsonb_array_elements_text(COALESCE(v_revision.manifest_snapshot->'segment_ids', '[]'::JSONB))),
    COALESCE((v_revision.manifest_snapshot->>'path_count')::INTEGER, 0),
    COALESCE((v_revision.manifest_snapshot->>'externalizable_path_count')::INTEGER, 0),
    COALESCE((v_revision.manifest_snapshot->>'domain_contract_version')::INTEGER, 1),
    COALESCE((v_revision.manifest_snapshot->>'readable_summary_version')::INTEGER, 0),
    NULLIF(v_revision.manifest_snapshot->>'upgraded_at', '')::TIMESTAMPTZ,
    v_now, v_now,
    COALESCE(NULLIF(v_revision.manifest_snapshot->>'pkm_contract_version', ''), '0.0.0'),
    COALESCE(NULLIF(v_revision.manifest_snapshot->>'readable_projection_version', ''), '0.0.0'),
    NULLIF(v_revision.manifest_snapshot->>'latest_upgrade_commit_id', '')::UUID,
    v_now, v_now
  )
  ON CONFLICT (user_id, domain) DO UPDATE SET
    manifest_version = EXCLUDED.manifest_version,
    structure_decision = EXCLUDED.structure_decision,
    summary_projection = EXCLUDED.summary_projection,
    top_level_scope_paths = EXCLUDED.top_level_scope_paths,
    externalizable_paths = EXCLUDED.externalizable_paths,
    segment_ids = EXCLUDED.segment_ids,
    path_count = EXCLUDED.path_count,
    externalizable_path_count = EXCLUDED.externalizable_path_count,
    domain_contract_version = EXCLUDED.domain_contract_version,
    readable_summary_version = EXCLUDED.readable_summary_version,
    upgraded_at = EXCLUDED.upgraded_at,
    last_structured_at = EXCLUDED.last_structured_at,
    last_content_at = EXCLUDED.last_content_at,
    pkm_contract_version = EXCLUDED.pkm_contract_version,
    readable_projection_version = EXCLUDED.readable_projection_version,
    latest_upgrade_commit_id = EXCLUDED.latest_upgrade_commit_id,
    updated_at = v_now;

  DELETE FROM pkm_manifest_paths WHERE user_id = p_user_id AND domain = p_domain;
  INSERT INTO pkm_manifest_paths (
    user_id, domain, json_path, parent_path, path_type, segment_id, scope_handle,
    exposure_eligibility, consent_label, sensitivity_label, source_agent
  )
  SELECT p_user_id, p_domain, row_data.json_path, row_data.parent_path,
         row_data.path_type, row_data.segment_id, row_data.scope_handle,
         row_data.exposure_eligibility, row_data.consent_label,
         row_data.sensitivity_label, row_data.source_agent
  FROM jsonb_to_recordset(v_revision.path_rows_snapshot) AS row_data(
    json_path TEXT, parent_path TEXT, path_type TEXT, segment_id TEXT,
    scope_handle TEXT, exposure_eligibility BOOLEAN, consent_label TEXT,
    sensitivity_label TEXT, source_agent TEXT
  );

  DELETE FROM pkm_scope_registry WHERE user_id = p_user_id AND domain = p_domain;
  INSERT INTO pkm_scope_registry (
    user_id, domain, scope_handle, scope_label, segment_ids, sensitivity_tier,
    scope_kind, exposure_enabled, manifest_version, summary_projection,
    visibility_posture, default_projection_ready, default_projection_updated_at,
    owner_consent_override, scope_origin, scope_origin_code, source_kind
  )
  SELECT p_user_id, p_domain, row_data.scope_handle, row_data.scope_label,
         row_data.segment_ids, row_data.sensitivity_tier, row_data.scope_kind,
         row_data.exposure_enabled, v_next_manifest_revision,
         COALESCE(row_data.summary_projection, '{}'::JSONB) || jsonb_build_object(
           'manifest_version', v_next_manifest_revision,
           'content_revision', v_next_content_revision,
           'data_version', v_next_content_revision
         ), row_data.visibility_posture,
         row_data.default_projection_ready, row_data.default_projection_updated_at,
         row_data.owner_consent_override, 'dynamic', 'd', 'manifest_branch'
  FROM jsonb_to_recordset(v_revision.scope_rows_snapshot) AS row_data(
    scope_handle TEXT, scope_label TEXT, segment_ids TEXT[], sensitivity_tier TEXT,
    scope_kind TEXT, exposure_enabled BOOLEAN, manifest_version INTEGER,
    summary_projection JSONB, visibility_posture TEXT,
    default_projection_ready BOOLEAN, default_projection_updated_at TIMESTAMPTZ,
    owner_consent_override BOOLEAN
  );

  IF v_revision.index_domain_present THEN
    PERFORM merge_pkm_domain_summary(
      p_user_id, p_domain, v_restored_index_summary, ARRAY[p_domain]
    );
  ELSE
    UPDATE pkm_index
    SET available_domains = array_remove(available_domains, p_domain),
        domain_summaries = domain_summaries - p_domain,
        updated_at = v_now
    WHERE user_id = p_user_id;
  END IF;

  INSERT INTO consent_export_refresh_jobs (
    user_id, consent_token, granted_scope, status, trigger_domain, trigger_paths,
    requested_at, last_error, attempt_count, claim_id, claimed_at,
    claim_expires_at, expected_export_revision, created_at, updated_at
  )
  SELECT p_user_id, exports.consent_token, exports.scope, 'pending', p_domain,
         '[]'::JSONB, v_now, NULL, COALESCE(jobs.attempt_count, 0),
         NULL, NULL, NULL, exports.export_revision, v_now, v_now
  FROM consent_exports exports
  LEFT JOIN consent_export_refresh_jobs jobs ON jobs.consent_token = exports.consent_token
  WHERE exports.user_id = p_user_id
    AND exports.envelope_version = 2
    AND exports.refresh_policy = 'continuous_until_expiry'
    AND exports.expires_at > v_now
  ON CONFLICT (consent_token) DO UPDATE SET
    status = 'pending', trigger_domain = EXCLUDED.trigger_domain,
    trigger_paths = EXCLUDED.trigger_paths, requested_at = EXCLUDED.requested_at,
    last_error = NULL, claim_id = NULL, claimed_at = NULL,
    claim_expires_at = NULL, expected_export_revision = EXCLUDED.expected_export_revision,
    updated_at = v_now;

  UPDATE consent_exports
  SET refresh_status = 'refresh_pending'
  WHERE user_id = p_user_id
    AND envelope_version = 2
    AND refresh_policy = 'continuous_until_expiry'
    AND expires_at > v_now;

  UPDATE pkm_domain_revisions
  SET restored_count = restored_count + 1, last_restored_at = v_now
  WHERE revision_id = p_revision_id;

  INSERT INTO pkm_domain_commits (
    commit_id, user_id, domain, commit_kind, run_id,
    expected_content_revision, expected_manifest_revision,
    result_content_revision, result_manifest_revision,
    archived_revision_id, retention_expires_at
  ) VALUES (
    p_rollback_commit_id, p_user_id, p_domain, 'rollback', p_run_id,
    p_expected_content_revision, p_expected_manifest_revision,
    v_next_content_revision, v_next_manifest_revision,
    v_current_archive_id, NULL
  );

  INSERT INTO pkm_events (
    user_id, domain, operation_type, segment_ids, path_set, source_agent,
    prior_manifest_version, new_manifest_version, metadata
  ) VALUES (
    p_user_id, p_domain, 'upgrade_rollback', ARRAY[]::TEXT[], '[]'::JSONB,
    'pkm_upgrade_service', v_current_manifest_revision, v_next_manifest_revision,
    jsonb_build_object(
      'run_id', p_run_id,
      'commit_id', p_rollback_commit_id,
      'restored_revision_id', p_revision_id,
      'archived_current_revision_id', v_current_archive_id
    )
  );

  RETURN jsonb_build_object(
    'success', TRUE, 'conflict', FALSE, 'idempotent_replay', FALSE,
    'commit_id', p_rollback_commit_id,
    'data_version', v_next_content_revision,
    'manifest_revision', v_next_manifest_revision,
    'restored_revision_id', p_revision_id,
    'archived_revision_id', v_current_archive_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION delete_pkm_domain_v2(
  p_user_id TEXT,
  p_domain TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id || ':' || p_domain, 0));
  DELETE FROM pkm_upgrade_claims WHERE user_id = p_user_id AND domain = p_domain;
  DELETE FROM pkm_domain_commits WHERE user_id = p_user_id AND domain = p_domain;
  DELETE FROM pkm_domain_revisions WHERE user_id = p_user_id AND domain = p_domain;
  DELETE FROM pkm_upgrade_steps AS steps
  USING pkm_upgrade_runs AS runs
  WHERE steps.run_id = runs.run_id
    AND runs.user_id = p_user_id
    AND steps.domain = p_domain;
  DELETE FROM pkm_blobs WHERE user_id = p_user_id AND domain = p_domain;
  DELETE FROM pkm_manifest_paths WHERE user_id = p_user_id AND domain = p_domain;
  DELETE FROM pkm_scope_registry WHERE user_id = p_user_id AND domain = p_domain;
  DELETE FROM pkm_default_available_projections
  WHERE user_id = p_user_id AND domain = p_domain;
  DELETE FROM pkm_manifests WHERE user_id = p_user_id AND domain = p_domain;
  DELETE FROM pkm_events WHERE user_id = p_user_id AND domain = p_domain;
  UPDATE pkm_index
  SET available_domains = array_remove(available_domains, p_domain),
      domain_summaries = domain_summaries - p_domain,
      total_attributes = GREATEST(
        0,
        COALESCE((
          SELECT SUM(
            COALESCE((value->>'holdings_count')::INTEGER, 0)
            + COALESCE((value->>'attribute_count')::INTEGER, 0)
            + COALESCE((value->>'item_count')::INTEGER, 0)
          )
          FROM jsonb_each(domain_summaries - p_domain)
        ), 0)
      ),
      updated_at = NOW()
  WHERE user_id = p_user_id;
  DELETE FROM pkm_index
  WHERE user_id = p_user_id AND COALESCE(array_length(available_domains, 1), 0) = 0;
  RETURN TRUE;
END;
$$;

COMMIT;
