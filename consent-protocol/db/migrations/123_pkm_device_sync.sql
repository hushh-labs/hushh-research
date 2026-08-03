-- Durable encrypted-device PKM synchronization and revision-safe domain deletion.
--
-- PKM ciphertext remains the data plane. `pkm_events.id` is the monotonic
-- Postgres cursor today; a future Redis/Memorystore fan-out adapter can publish
-- these same metadata-only events without changing the device contract.

BEGIN;

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
      'upgrade_commit', 'upgrade_rollback', 'domain_delete'
    )
  );

CREATE INDEX IF NOT EXISTS idx_pkm_events_device_sync
  ON pkm_events(user_id, id)
  WHERE operation_type IN (
    'content_write', 'upgrade_commit', 'upgrade_rollback', 'domain_delete'
  );

CREATE OR REPLACE FUNCTION delete_pkm_domain_v3(
  p_user_id TEXT,
  p_domain TEXT,
  p_expected_content_revision INTEGER,
  p_refresh_tokens TEXT[] DEFAULT ARRAY[]::TEXT[],
  p_trigger_paths JSONB DEFAULT '[]'::JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_current_content_revision INTEGER;
  v_current_manifest_revision INTEGER;
  v_next_content_revision INTEGER;
  v_now TIMESTAMPTZ := NOW();
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id || ':' || p_domain, 0));

  SELECT COALESCE(MAX(content_revision), 0)
  INTO v_current_content_revision
  FROM pkm_blobs
  WHERE user_id = p_user_id AND domain = p_domain;

  SELECT COALESCE(manifest_version, 0)
  INTO v_current_manifest_revision
  FROM pkm_manifests
  WHERE user_id = p_user_id AND domain = p_domain;

  v_current_manifest_revision := COALESCE(v_current_manifest_revision, 0);

  IF v_current_content_revision = 0 THEN
    RETURN jsonb_build_object(
      'success', TRUE,
      'conflict', FALSE,
      'deleted', FALSE,
      'idempotent_replay', TRUE,
      'data_version', 0
    );
  END IF;

  IF p_expected_content_revision IS NULL
     OR p_expected_content_revision <> v_current_content_revision THEN
    RETURN jsonb_build_object(
      'success', FALSE,
      'conflict', TRUE,
      'deleted', FALSE,
      'data_version', v_current_content_revision
    );
  END IF;

  v_next_content_revision := v_current_content_revision + 1;

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
      updated_at = v_now
  WHERE user_id = p_user_id;

  DELETE FROM pkm_index
  WHERE user_id = p_user_id
    AND COALESCE(array_length(available_domains, 1), 0) = 0;

  INSERT INTO consent_export_refresh_jobs (
    user_id, consent_token, granted_scope, status, trigger_domain, trigger_paths,
    requested_at, last_error, attempt_count, claim_id, claimed_at,
    claim_expires_at, expected_export_revision, created_at, updated_at
  )
  SELECT p_user_id, exports.consent_token, exports.scope, 'pending', p_domain,
         COALESCE(p_trigger_paths, '[]'::JSONB), v_now, NULL,
         COALESCE(jobs.attempt_count, 0), NULL, NULL, NULL,
         exports.export_revision, v_now, v_now
  FROM consent_exports AS exports
  LEFT JOIN consent_export_refresh_jobs AS jobs
    ON jobs.consent_token = exports.consent_token
  WHERE exports.consent_token = ANY(COALESCE(p_refresh_tokens, ARRAY[]::TEXT[]))
    AND exports.user_id = p_user_id
    AND exports.envelope_version = 2
    AND exports.refresh_policy = 'continuous_until_expiry'
    AND exports.expires_at > v_now
  ON CONFLICT (consent_token) DO UPDATE SET
    status = 'pending',
    trigger_domain = EXCLUDED.trigger_domain,
    trigger_paths = EXCLUDED.trigger_paths,
    requested_at = v_now,
    last_error = NULL,
    claim_id = NULL,
    claimed_at = NULL,
    claim_expires_at = NULL,
    expected_export_revision = EXCLUDED.expected_export_revision,
    updated_at = v_now;

  UPDATE consent_exports
  SET refresh_status = 'refresh_pending'
  WHERE consent_token = ANY(COALESCE(p_refresh_tokens, ARRAY[]::TEXT[]))
    AND user_id = p_user_id
    AND envelope_version = 2
    AND refresh_policy = 'continuous_until_expiry'
    AND expires_at > v_now;

  INSERT INTO pkm_events (
    user_id, domain, operation_type, segment_ids, path_set, source_agent,
    prior_manifest_version, new_manifest_version, metadata, created_at
  ) VALUES (
    p_user_id, p_domain, 'domain_delete', ARRAY[]::TEXT[],
    COALESCE(p_trigger_paths, '[]'::JSONB), 'hussh_one_trusted_device',
    v_current_manifest_revision, NULL,
    jsonb_build_object(
      'data_version', v_next_content_revision,
      'deleted_content_revision', v_current_content_revision
    ),
    v_now
  );

  RETURN jsonb_build_object(
    'success', TRUE,
    'conflict', FALSE,
    'deleted', TRUE,
    'idempotent_replay', FALSE,
    'data_version', v_next_content_revision,
    'updated_at', v_now
  );
END;
$$;

COMMIT;
