-- One transaction for confirmed PKM writes. The client still encrypts every
-- payload; this function only commits ciphertext and non-secret metadata.

BEGIN;

CREATE OR REPLACE FUNCTION commit_pkm_domain_mutation_v2(
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
  p_trigger_paths JSONB DEFAULT '[]'::JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_current_revision INTEGER;
  v_now TIMESTAMPTZ := NOW();
BEGIN
  IF p_user_id IS NULL OR BTRIM(p_user_id) = '' OR p_domain IS NULL OR BTRIM(p_domain) = '' THEN
    RAISE EXCEPTION 'user_id_and_domain_required';
  END IF;
  IF p_next_content_revision <> p_expected_content_revision + 1 THEN
    RAISE EXCEPTION 'next_content_revision_mismatch';
  END IF;
  IF jsonb_typeof(p_segment_rows) <> 'array' OR jsonb_array_length(p_segment_rows) = 0 THEN
    RAISE EXCEPTION 'segment_rows_required';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(COALESCE(p_scope_rows, '[]'::JSONB)) AS scope_row(
      visibility_posture TEXT
    )
    WHERE scope_row.visibility_posture IS NULL
      OR scope_row.visibility_posture NOT IN ('private', 'consent_required')
  ) THEN
    RAISE EXCEPTION 'unsupported_pkm_scope_visibility_posture';
  END IF;

  -- Serialize all writers for this user/domain, including the first write.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id || ':' || p_domain, 0));
  SELECT COALESCE(MAX(content_revision), 0)
  INTO v_current_revision
  FROM pkm_blobs
  WHERE user_id = p_user_id AND domain = p_domain;

  IF v_current_revision <> p_expected_content_revision THEN
    RETURN jsonb_build_object(
      'success', FALSE,
      'conflict', TRUE,
      'data_version', v_current_revision
    );
  END IF;

  DELETE FROM pkm_blobs
  WHERE user_id = p_user_id
    AND domain = p_domain
    AND segment_id NOT IN (
      SELECT row_data.segment_id
      FROM jsonb_to_recordset(p_segment_rows) AS row_data(segment_id TEXT)
    );

  INSERT INTO pkm_blobs (
    user_id, domain, segment_id, ciphertext, iv, tag, algorithm,
    content_revision, manifest_revision, size_bytes, created_at, updated_at
  )
  SELECT
    p_user_id, p_domain, row_data.segment_id, row_data.ciphertext, row_data.iv,
    row_data.tag, row_data.algorithm, p_next_content_revision,
    row_data.manifest_revision, row_data.size_bytes, v_now, v_now
  FROM jsonb_to_recordset(p_segment_rows) AS row_data(
    segment_id TEXT, ciphertext TEXT, iv TEXT, tag TEXT, algorithm TEXT,
    manifest_revision INTEGER, size_bytes INTEGER
  )
  ON CONFLICT (user_id, domain, segment_id) DO UPDATE SET
    ciphertext = EXCLUDED.ciphertext,
    iv = EXCLUDED.iv,
    tag = EXCLUDED.tag,
    algorithm = EXCLUDED.algorithm,
    content_revision = EXCLUDED.content_revision,
    manifest_revision = EXCLUDED.manifest_revision,
    size_bytes = EXCLUDED.size_bytes,
    updated_at = EXCLUDED.updated_at;

  INSERT INTO pkm_manifests (
    user_id, domain, manifest_version, structure_decision, summary_projection,
    top_level_scope_paths, externalizable_paths, segment_ids, path_count,
    externalizable_path_count, domain_contract_version, readable_summary_version,
    upgraded_at, last_structured_at, last_content_at, created_at, updated_at
  ) VALUES (
    p_user_id,
    p_domain,
    (p_manifest_row->>'manifest_version')::INTEGER,
    COALESCE(p_manifest_row->'structure_decision', '{}'::JSONB),
    COALESCE(p_manifest_row->'summary_projection', '{}'::JSONB),
    ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_manifest_row->'top_level_scope_paths', '[]'::JSONB))),
    ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_manifest_row->'externalizable_paths', '[]'::JSONB))),
    ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_manifest_row->'segment_ids', '[]'::JSONB))),
    COALESCE((p_manifest_row->>'path_count')::INTEGER, 0),
    COALESCE((p_manifest_row->>'externalizable_path_count')::INTEGER, 0),
    COALESCE((p_manifest_row->>'domain_contract_version')::INTEGER, 1),
    COALESCE((p_manifest_row->>'readable_summary_version')::INTEGER, 0),
    NULLIF(p_manifest_row->>'upgraded_at', '')::TIMESTAMPTZ,
    NULLIF(p_manifest_row->>'last_structured_at', '')::TIMESTAMPTZ,
    NULLIF(p_manifest_row->>'last_content_at', '')::TIMESTAMPTZ,
    v_now,
    v_now
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
  FROM jsonb_to_recordset(COALESCE(p_path_rows, '[]'::JSONB)) AS row_data(
    json_path TEXT, parent_path TEXT, path_type TEXT, segment_id TEXT,
    scope_handle TEXT, exposure_eligibility BOOLEAN, consent_label TEXT,
    sensitivity_label TEXT, source_agent TEXT
  );

  DELETE FROM pkm_scope_registry WHERE user_id = p_user_id AND domain = p_domain;
  INSERT INTO pkm_scope_registry (
    user_id, domain, scope_handle, scope_label, segment_ids, sensitivity_tier,
    scope_kind, exposure_enabled, manifest_version, summary_projection,
    visibility_posture, default_projection_ready, default_projection_updated_at,
    owner_consent_override
  )
  SELECT p_user_id, p_domain, row_data.scope_handle, row_data.scope_label,
    row_data.segment_ids, row_data.sensitivity_tier, row_data.scope_kind,
    row_data.exposure_enabled, row_data.manifest_version, row_data.summary_projection,
    row_data.visibility_posture,
    COALESCE(row_data.default_projection_ready, FALSE),
    row_data.default_projection_updated_at,
    COALESCE(row_data.owner_consent_override, FALSE)
  FROM jsonb_to_recordset(COALESCE(p_scope_rows, '[]'::JSONB)) AS row_data(
    scope_handle TEXT, scope_label TEXT, segment_ids TEXT[], sensitivity_tier TEXT,
    scope_kind TEXT, exposure_enabled BOOLEAN, manifest_version INTEGER,
    summary_projection JSONB, visibility_posture TEXT,
    default_projection_ready BOOLEAN, default_projection_updated_at TIMESTAMPTZ,
    owner_consent_override BOOLEAN
  );

  PERFORM merge_pkm_domain_summary(p_user_id, p_domain, COALESCE(p_summary_patch, '{}'::JSONB), ARRAY[p_domain]);

  INSERT INTO pkm_events (
    user_id, domain, operation_type, segment_ids, path_set, source_agent,
    confidence, prior_manifest_version, new_manifest_version, metadata, created_at
  )
  SELECT p_user_id, p_domain, row_data.operation_type,
    COALESCE(row_data.segment_ids, ARRAY[]::TEXT[]), COALESCE(row_data.path_set, '[]'::JSONB),
    row_data.source_agent, row_data.confidence, row_data.prior_manifest_version,
    row_data.new_manifest_version, COALESCE(row_data.metadata, '{}'::JSONB), v_now
  FROM jsonb_to_recordset(COALESCE(p_event_rows, '[]'::JSONB)) AS row_data(
    operation_type TEXT, segment_ids TEXT[], path_set JSONB, source_agent TEXT,
    confidence DOUBLE PRECISION, prior_manifest_version INTEGER,
    new_manifest_version INTEGER, metadata JSONB
  );

  INSERT INTO pkm_migration_state (
    user_id, status, source_model, legacy_blob_present, migrated_at, last_error, updated_at
  ) VALUES (p_user_id, 'completed', 'pkm', p_legacy_blob_present, v_now, NULL, v_now)
  ON CONFLICT (user_id) DO UPDATE SET
    status = 'completed', source_model = 'pkm',
    legacy_blob_present = EXCLUDED.legacy_blob_present,
    migrated_at = v_now, last_error = NULL, updated_at = v_now;

  INSERT INTO consent_export_refresh_jobs (
    user_id, consent_token, granted_scope, status, trigger_domain, trigger_paths,
    requested_at, last_error, attempt_count, claim_id, claimed_at,
    claim_expires_at, expected_export_revision, created_at, updated_at
  )
  SELECT p_user_id, exports.consent_token, exports.scope, 'pending', p_domain,
    COALESCE(p_trigger_paths, '[]'::JSONB), v_now, NULL,
    COALESCE(jobs.attempt_count, 0), NULL, NULL, NULL, exports.export_revision, v_now, v_now
  FROM consent_exports AS exports
  LEFT JOIN consent_export_refresh_jobs AS jobs ON jobs.consent_token = exports.consent_token
  WHERE exports.consent_token = ANY(COALESCE(p_refresh_tokens, ARRAY[]::TEXT[]))
    AND exports.user_id = p_user_id
    AND exports.envelope_version = 2
    AND exports.refresh_policy = 'continuous_until_expiry'
    AND exports.expires_at > v_now
  ON CONFLICT (consent_token) DO UPDATE SET
    status = 'pending', trigger_domain = EXCLUDED.trigger_domain,
    trigger_paths = EXCLUDED.trigger_paths, requested_at = v_now, last_error = NULL,
    claim_id = NULL, claimed_at = NULL, claim_expires_at = NULL,
    expected_export_revision = EXCLUDED.expected_export_revision, updated_at = v_now;

  UPDATE consent_exports
  SET refresh_status = 'refresh_pending'
  WHERE consent_token = ANY(COALESCE(p_refresh_tokens, ARRAY[]::TEXT[]))
    AND user_id = p_user_id
    AND envelope_version = 2
    AND refresh_policy = 'continuous_until_expiry'
    AND expires_at > v_now;

  RETURN jsonb_build_object(
    'success', TRUE,
    'conflict', FALSE,
    'data_version', p_next_content_revision,
    'updated_at', v_now
  );
END;
$$;

COMMIT;
