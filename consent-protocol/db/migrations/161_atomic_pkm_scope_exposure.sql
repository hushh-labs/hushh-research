-- Scope exposure changes mutate PKM manifest authority but not ciphertext.
-- Keep the encrypted blob's manifest revision in the same transaction so a
-- coherent snapshot can never observe one side of the change without the other.

BEGIN;

CREATE OR REPLACE FUNCTION commit_pkm_scope_exposure_v1(
  p_user_id TEXT,
  p_domain TEXT,
  p_expected_manifest_revision INTEGER,
  p_next_manifest_revision INTEGER,
  p_manifest_row JSONB,
  p_path_rows JSONB,
  p_scope_rows JSONB,
  p_summary_patch JSONB,
  p_changed_paths JSONB DEFAULT '[]'::JSONB,
  p_event_metadata JSONB DEFAULT '{}'::JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_current_content_revision INTEGER;
  v_min_content_revision INTEGER;
  v_min_manifest_revision INTEGER;
  v_max_content_revision INTEGER;
  v_max_manifest_revision INTEGER;
  v_current_manifest_revision INTEGER;
  v_now TIMESTAMPTZ := NOW();
BEGIN
  IF p_user_id IS NULL OR BTRIM(p_user_id) = '' OR p_domain IS NULL OR BTRIM(p_domain) = '' THEN
    RAISE EXCEPTION 'user_id_and_domain_required';
  END IF;
  IF p_next_manifest_revision <> p_expected_manifest_revision + 1 THEN
    RAISE EXCEPTION 'invalid_pkm_next_manifest_revision';
  END IF;
  IF COALESCE((p_manifest_row->>'manifest_version')::INTEGER, -1) <> p_next_manifest_revision THEN
    RAISE EXCEPTION 'invalid_pkm_manifest_revision';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_to_recordset(COALESCE(p_scope_rows, '[]'::JSONB)) AS scope_row(
      manifest_version INTEGER, visibility_posture TEXT
    )
    WHERE manifest_version IS DISTINCT FROM p_next_manifest_revision
      OR visibility_posture IS NULL
      OR visibility_posture NOT IN ('private', 'consent_required')
  ) THEN
    RAISE EXCEPTION 'mixed_pkm_domain_revisions';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id || ':' || p_domain, 0));
  SELECT MIN(content_revision), MAX(content_revision),
         MIN(manifest_revision), MAX(manifest_revision)
  INTO v_min_content_revision, v_max_content_revision,
       v_min_manifest_revision, v_max_manifest_revision
  FROM pkm_blobs
  WHERE user_id = p_user_id AND domain = p_domain;

  IF v_max_content_revision IS NULL THEN
    RAISE EXCEPTION 'pkm_domain_blob_missing';
  END IF;
  IF v_min_content_revision <> v_max_content_revision
     OR v_min_manifest_revision <> v_max_manifest_revision THEN
    RAISE EXCEPTION 'mixed_pkm_domain_revisions';
  END IF;
  v_current_content_revision := v_max_content_revision;

  SELECT manifest_version INTO v_current_manifest_revision
  FROM pkm_manifests
  WHERE user_id = p_user_id AND domain = p_domain
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'pkm_domain_manifest_missing';
  END IF;
  IF v_current_manifest_revision <> p_expected_manifest_revision
     OR v_max_manifest_revision <> p_expected_manifest_revision
     OR EXISTS (
       SELECT 1 FROM pkm_scope_registry
       WHERE user_id = p_user_id AND domain = p_domain
         AND manifest_version <> p_expected_manifest_revision
     ) THEN
    RETURN jsonb_build_object(
      'success', FALSE, 'conflict', TRUE,
      'data_version', v_current_content_revision,
      'manifest_revision', v_current_manifest_revision
    );
  END IF;

  UPDATE pkm_blobs
  SET manifest_revision = p_next_manifest_revision, updated_at = v_now
  WHERE user_id = p_user_id AND domain = p_domain;

  INSERT INTO pkm_manifests (
    user_id, domain, manifest_version, structure_decision, summary_projection,
    top_level_scope_paths, externalizable_paths, segment_ids, path_count,
    externalizable_path_count, domain_contract_version, readable_summary_version,
    pkm_contract_version, readable_projection_version, latest_upgrade_commit_id,
    upgraded_at, last_structured_at, last_content_at, created_at, updated_at
  ) VALUES (
    p_user_id, p_domain, p_next_manifest_revision,
    COALESCE(p_manifest_row->'structure_decision', '{}'::JSONB),
    COALESCE(p_manifest_row->'summary_projection', '{}'::JSONB),
    ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_manifest_row->'top_level_scope_paths', '[]'::JSONB))),
    ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_manifest_row->'externalizable_paths', '[]'::JSONB))),
    ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_manifest_row->'segment_ids', '[]'::JSONB))),
    COALESCE((p_manifest_row->>'path_count')::INTEGER, 0),
    COALESCE((p_manifest_row->>'externalizable_path_count')::INTEGER, 0),
    COALESCE((p_manifest_row->>'domain_contract_version')::INTEGER, 1),
    COALESCE((p_manifest_row->>'readable_summary_version')::INTEGER, 0),
    COALESCE(NULLIF(p_manifest_row->>'pkm_contract_version', ''), '0.0.0'),
    COALESCE(NULLIF(p_manifest_row->>'readable_projection_version', ''), '0.0.0'),
    NULLIF(p_manifest_row->>'latest_upgrade_commit_id', '')::UUID,
    NULLIF(p_manifest_row->>'upgraded_at', '')::TIMESTAMPTZ,
    NULLIF(p_manifest_row->>'last_structured_at', '')::TIMESTAMPTZ,
    NULLIF(p_manifest_row->>'last_content_at', '')::TIMESTAMPTZ,
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
    pkm_contract_version = EXCLUDED.pkm_contract_version,
    readable_projection_version = EXCLUDED.readable_projection_version,
    latest_upgrade_commit_id = EXCLUDED.latest_upgrade_commit_id,
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
    owner_consent_override, scope_origin, scope_origin_code, source_kind
  )
  SELECT p_user_id, p_domain, row_data.scope_handle, row_data.scope_label,
    row_data.segment_ids, row_data.sensitivity_tier, row_data.scope_kind,
    row_data.exposure_enabled, p_next_manifest_revision,
    COALESCE(row_data.summary_projection, '{}'::JSONB)
      || jsonb_build_object('manifest_version', p_next_manifest_revision, 'content_revision', v_current_content_revision, 'data_version', v_current_content_revision),
    row_data.visibility_posture,
    COALESCE(row_data.default_projection_ready, FALSE),
    row_data.default_projection_updated_at,
    COALESCE(row_data.owner_consent_override, FALSE),
    COALESCE(NULLIF(row_data.scope_origin, ''), 'dynamic'),
    COALESCE(NULLIF(row_data.scope_origin_code, ''), 'd'),
    COALESCE(NULLIF(row_data.source_kind, ''), 'manifest_branch')
  FROM jsonb_to_recordset(COALESCE(p_scope_rows, '[]'::JSONB)) AS row_data(
    scope_handle TEXT, scope_label TEXT, segment_ids TEXT[], sensitivity_tier TEXT,
    scope_kind TEXT, exposure_enabled BOOLEAN, manifest_version INTEGER,
    summary_projection JSONB, visibility_posture TEXT,
    default_projection_ready BOOLEAN, default_projection_updated_at TIMESTAMPTZ,
    owner_consent_override BOOLEAN, scope_origin TEXT, scope_origin_code TEXT,
    source_kind TEXT
  );

  PERFORM merge_pkm_domain_summary(
    p_user_id, p_domain,
    COALESCE(p_summary_patch, '{}'::JSONB)
      || jsonb_build_object('manifest_version', p_next_manifest_revision, 'content_revision', v_current_content_revision, 'data_version', v_current_content_revision),
    ARRAY[p_domain]
  );

  INSERT INTO pkm_events (
    user_id, domain, operation_type, segment_ids, path_set, source_agent,
    prior_manifest_version, new_manifest_version, metadata, created_at
  ) VALUES (
    p_user_id, p_domain, 'scope_exposure_update', ARRAY[]::TEXT[],
    COALESCE(p_changed_paths, '[]'::JSONB), 'pkm_scope_manager',
    p_expected_manifest_revision, p_next_manifest_revision,
    COALESCE(p_event_metadata, '{}'::JSONB), v_now
  );

  RETURN jsonb_build_object(
    'success', TRUE, 'conflict', FALSE,
    'data_version', v_current_content_revision,
    'manifest_revision', p_next_manifest_revision,
    'updated_at', v_now
  );
END;
$$;

CREATE OR REPLACE FUNCTION repair_pkm_scope_exposure_revision_v1(
  p_user_id TEXT,
  p_domain TEXT,
  p_expected_content_revision INTEGER,
  p_expected_blob_manifest_revision INTEGER,
  p_expected_manifest_revision INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_min_content_revision INTEGER;
  v_max_content_revision INTEGER;
  v_min_manifest_revision INTEGER;
  v_max_manifest_revision INTEGER;
  v_manifest_revision INTEGER;
  v_archive_id UUID;
  v_commit_id UUID := gen_random_uuid();
  v_now TIMESTAMPTZ := NOW();
BEGIN
  IF p_expected_manifest_revision <> p_expected_blob_manifest_revision + 1 THEN
    RAISE EXCEPTION 'unsupported_pkm_scope_repair_transition';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id || ':' || p_domain, 0));
  SELECT MIN(content_revision), MAX(content_revision),
         MIN(manifest_revision), MAX(manifest_revision)
  INTO v_min_content_revision, v_max_content_revision,
       v_min_manifest_revision, v_max_manifest_revision
  FROM pkm_blobs
  WHERE user_id = p_user_id AND domain = p_domain;
  SELECT manifest_version INTO v_manifest_revision
  FROM pkm_manifests
  WHERE user_id = p_user_id AND domain = p_domain
  FOR UPDATE;

  IF v_max_content_revision = p_expected_content_revision
     AND v_min_content_revision = p_expected_content_revision
     AND v_min_manifest_revision = p_expected_manifest_revision
     AND v_max_manifest_revision = p_expected_manifest_revision
     AND v_manifest_revision = p_expected_manifest_revision THEN
    RETURN jsonb_build_object('success', TRUE, 'idempotent_replay', TRUE,
      'data_version', p_expected_content_revision,
      'manifest_revision', p_expected_manifest_revision);
  END IF;

  IF v_min_content_revision IS DISTINCT FROM p_expected_content_revision
     OR v_max_content_revision IS DISTINCT FROM p_expected_content_revision
     OR v_min_manifest_revision IS DISTINCT FROM p_expected_blob_manifest_revision
     OR v_max_manifest_revision IS DISTINCT FROM p_expected_blob_manifest_revision
     OR v_manifest_revision IS DISTINCT FROM p_expected_manifest_revision
     OR EXISTS (
       SELECT 1 FROM pkm_scope_registry
       WHERE user_id = p_user_id AND domain = p_domain
         AND manifest_version <> p_expected_manifest_revision
     )
     OR NOT EXISTS (
       SELECT 1 FROM pkm_events
       WHERE user_id = p_user_id AND domain = p_domain
         AND operation_type = 'scope_exposure_update'
         AND prior_manifest_version = p_expected_blob_manifest_revision
         AND new_manifest_version = p_expected_manifest_revision
     ) THEN
    RETURN jsonb_build_object('success', FALSE, 'conflict', TRUE,
      'data_version', v_max_content_revision,
      'manifest_revision', v_manifest_revision);
  END IF;

  v_archive_id := archive_pkm_domain_revision_v1(
    p_user_id, p_domain, 'mutation', v_commit_id, FALSE
  );
  UPDATE pkm_blobs
  SET manifest_revision = p_expected_manifest_revision, updated_at = v_now
  WHERE user_id = p_user_id AND domain = p_domain;

  INSERT INTO pkm_domain_commits (
    commit_id, user_id, domain, commit_kind, request_fingerprint,
    expected_content_revision, expected_manifest_revision,
    result_content_revision, result_manifest_revision,
    archived_revision_id, retention_expires_at
  ) VALUES (
    v_commit_id, p_user_id, p_domain, 'mutation',
    encode(digest('repair:scope_exposure:' || p_user_id || ':' || p_domain || ':' || v_now::TEXT, 'sha256'), 'hex'),
    p_expected_content_revision, p_expected_blob_manifest_revision,
    p_expected_content_revision, p_expected_manifest_revision,
    v_archive_id, NOW() + INTERVAL '90 days'
  );
  INSERT INTO pkm_events (
    user_id, domain, operation_type, segment_ids, path_set, source_agent,
    prior_manifest_version, new_manifest_version, metadata, created_at
  ) VALUES (
    p_user_id, p_domain, 'manifest_refresh', ARRAY[]::TEXT[], '[]'::JSONB,
    'pkm_revision_recovery', p_expected_blob_manifest_revision,
    p_expected_manifest_revision,
    jsonb_build_object('repair_kind', 'scope_exposure_revision_alignment', 'archived_revision_id', v_archive_id),
    v_now
  );
  RETURN jsonb_build_object('success', TRUE, 'idempotent_replay', FALSE,
    'data_version', p_expected_content_revision,
    'manifest_revision', p_expected_manifest_revision,
    'archived_revision_id', v_archive_id, 'commit_id', v_commit_id);
END;
$$;

COMMIT;
