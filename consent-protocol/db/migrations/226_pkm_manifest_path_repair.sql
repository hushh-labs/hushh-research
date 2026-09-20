-- Repair only the historical lossless `_entities` path-token corruption.
--
-- This is metadata-only: ciphertext and content_revision are never rewritten.
-- The caller must validate the exact path bijection in
-- hushh_mcp.services.pkm_manifest_repair before invoking this owner-scoped,
-- revision-checked transaction.

BEGIN;

CREATE OR REPLACE FUNCTION repair_pkm_manifest_paths_v1(
  p_user_id TEXT,
  p_domain TEXT,
  p_expected_content_revision INTEGER,
  p_expected_manifest_revision INTEGER,
  p_next_manifest_revision INTEGER,
  p_repair_receipt_id TEXT,
  p_manifest_row JSONB,
  p_path_rows JSONB,
  p_scope_rows JSONB,
  p_summary_patch JSONB DEFAULT '{}'::JSONB,
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
  v_max_content_revision INTEGER;
  v_min_manifest_revision INTEGER;
  v_max_manifest_revision INTEGER;
  v_current_manifest_revision INTEGER;
  v_existing_path_count INTEGER;
  v_existing_scope_count INTEGER;
  v_updated_path_count INTEGER;
  v_updated_scope_count INTEGER;
  v_now TIMESTAMPTZ := NOW();
  v_metadata JSONB;
BEGIN
  IF p_user_id IS NULL OR BTRIM(p_user_id) = ''
     OR p_domain IS NULL OR BTRIM(p_domain) = '' THEN
    RAISE EXCEPTION 'user_id_and_domain_required';
  END IF;
  IF p_repair_receipt_id IS NULL OR BTRIM(p_repair_receipt_id) = '' THEN
    RAISE EXCEPTION 'pkm_manifest_repair_receipt_required';
  END IF;
  IF p_expected_content_revision IS NULL OR p_expected_content_revision < 0
     OR p_expected_manifest_revision IS NULL OR p_expected_manifest_revision < 0
     OR p_next_manifest_revision <> p_expected_manifest_revision + 1 THEN
    RAISE EXCEPTION 'invalid_pkm_manifest_repair_revision';
  END IF;
  IF jsonb_typeof(COALESCE(p_manifest_row, '{}'::JSONB)) <> 'object'
     OR jsonb_typeof(COALESCE(p_path_rows, '[]'::JSONB)) <> 'array'
     OR jsonb_typeof(COALESCE(p_scope_rows, '[]'::JSONB)) <> 'array' THEN
    RAISE EXCEPTION 'invalid_pkm_manifest_repair_payload';
  END IF;
  IF COALESCE((p_manifest_row->>'manifest_version')::INTEGER, -1)
       <> p_next_manifest_revision THEN
    RAISE EXCEPTION 'invalid_pkm_manifest_repair_manifest_revision';
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
    RAISE EXCEPTION 'mixed_pkm_manifest_repair_scope_revisions';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id || ':' || p_domain, 0));
  SELECT MIN(content_revision), MAX(content_revision),
         MIN(manifest_revision), MAX(manifest_revision)
  INTO v_min_content_revision, v_max_content_revision,
       v_min_manifest_revision, v_max_manifest_revision
  FROM pkm_blobs
  WHERE user_id = p_user_id AND domain = p_domain;

  SELECT manifest_version INTO v_current_manifest_revision
  FROM pkm_manifests
  WHERE user_id = p_user_id AND domain = p_domain
  FOR UPDATE;

  IF EXISTS (
    SELECT 1
    FROM pkm_events
    WHERE user_id = p_user_id
      AND domain = p_domain
      AND metadata->>'repair_receipt_id' = p_repair_receipt_id
  ) THEN
    RETURN jsonb_build_object(
      'success', TRUE,
      'conflict', FALSE,
      'idempotent_replay', TRUE,
      'data_version', v_max_content_revision,
      'manifest_revision', v_current_manifest_revision
    );
  END IF;

  IF v_max_content_revision IS NULL OR v_current_manifest_revision IS NULL THEN
    RAISE EXCEPTION 'pkm_domain_manifest_or_blob_missing';
  END IF;
  IF v_min_content_revision <> v_max_content_revision
     OR v_min_manifest_revision <> v_max_manifest_revision THEN
    RAISE EXCEPTION 'mixed_pkm_domain_revisions';
  END IF;
  IF v_min_content_revision <> p_expected_content_revision
     OR v_max_content_revision <> p_expected_content_revision
     OR v_min_manifest_revision <> p_expected_manifest_revision
     OR v_max_manifest_revision <> p_expected_manifest_revision
     OR v_current_manifest_revision <> p_expected_manifest_revision
     OR EXISTS (
       SELECT 1 FROM pkm_scope_registry
       WHERE user_id = p_user_id AND domain = p_domain
         AND manifest_version <> p_expected_manifest_revision
     ) THEN
    RETURN jsonb_build_object(
      'success', FALSE,
      'conflict', TRUE,
      'idempotent_replay', FALSE,
      'data_version', v_max_content_revision,
      'manifest_revision', v_current_manifest_revision
    );
  END IF;

  -- The repair changes manifest metadata only. Carry the verified blob
  -- revision into every repaired projection and response so a successful
  -- repair never reports a NULL content/data revision.
  v_current_content_revision := v_max_content_revision;

  -- Only the manifest revision changes on blobs. Ciphertext, IV, tag,
  -- algorithm, segment IDs, size and content_revision remain untouched.
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

  SELECT COUNT(*) INTO v_existing_path_count
  FROM pkm_manifest_paths
  WHERE user_id = p_user_id AND domain = p_domain;
  SELECT COUNT(*) INTO v_existing_scope_count
  FROM pkm_scope_registry
  WHERE user_id = p_user_id AND domain = p_domain;
  IF v_existing_path_count <> jsonb_array_length(p_path_rows)
     OR v_existing_scope_count <> jsonb_array_length(p_scope_rows) THEN
    RAISE EXCEPTION 'incomplete_pkm_manifest_repair_snapshot';
  END IF;

  -- Update rows in place so primary keys, created_at values, and unrelated
  -- metadata survive. The pure planner has already proven a complete bijection.
  UPDATE pkm_manifest_paths AS target
  SET json_path = incoming.json_path,
      parent_path = incoming.parent_path,
      path_type = incoming.path_type,
      segment_id = incoming.segment_id,
      scope_handle = incoming.scope_handle,
      exposure_eligibility = incoming.exposure_eligibility,
      display_segment = incoming.display_segment,
      consent_label = incoming.consent_label,
      sensitivity_label = incoming.sensitivity_label,
      source_agent = incoming.source_agent,
      updated_at = v_now
  FROM jsonb_to_recordset(COALESCE(p_path_rows, '[]'::JSONB)) AS incoming(
    id BIGINT, json_path TEXT, parent_path TEXT, path_type TEXT, segment_id TEXT,
    scope_handle TEXT, exposure_eligibility BOOLEAN, display_segment TEXT,
    consent_label TEXT, sensitivity_label TEXT, source_agent TEXT
  )
  WHERE target.id = incoming.id
    AND target.user_id = p_user_id
    AND target.domain = p_domain;
  GET DIAGNOSTICS v_updated_path_count = ROW_COUNT;
  IF v_updated_path_count <> v_existing_path_count THEN
    RAISE EXCEPTION 'pkm_manifest_path_identity_mismatch';
  END IF;

  UPDATE pkm_scope_registry AS target
  SET scope_handle = incoming.scope_handle,
      scope_label = incoming.scope_label,
      segment_ids = incoming.segment_ids,
      sensitivity_tier = incoming.sensitivity_tier,
      scope_kind = incoming.scope_kind,
      exposure_enabled = incoming.exposure_enabled,
      manifest_version = p_next_manifest_revision,
      summary_projection = COALESCE(incoming.summary_projection, '{}'::JSONB)
        || jsonb_build_object('manifest_version', p_next_manifest_revision,
                              'content_revision', v_current_content_revision,
                              'data_version', v_current_content_revision),
      visibility_posture = incoming.visibility_posture,
      default_projection_ready = COALESCE(incoming.default_projection_ready, FALSE),
      default_projection_updated_at = incoming.default_projection_updated_at,
      owner_consent_override = COALESCE(incoming.owner_consent_override, FALSE),
      scope_origin = COALESCE(NULLIF(incoming.scope_origin, ''), 'dynamic'),
      scope_origin_code = COALESCE(NULLIF(incoming.scope_origin_code, ''), 'd'),
      source_kind = COALESCE(NULLIF(incoming.source_kind, ''), 'manifest_branch'),
      updated_at = v_now
  FROM jsonb_to_recordset(COALESCE(p_scope_rows, '[]'::JSONB)) AS incoming(
    id BIGINT, scope_handle TEXT, scope_label TEXT, segment_ids TEXT[],
    sensitivity_tier TEXT, scope_kind TEXT, exposure_enabled BOOLEAN,
    manifest_version INTEGER, summary_projection JSONB, visibility_posture TEXT,
    default_projection_ready BOOLEAN, default_projection_updated_at TIMESTAMPTZ,
    owner_consent_override BOOLEAN, scope_origin TEXT, scope_origin_code TEXT,
    source_kind TEXT
  )
  WHERE target.id = incoming.id
    AND target.user_id = p_user_id
    AND target.domain = p_domain;
  GET DIAGNOSTICS v_updated_scope_count = ROW_COUNT;
  IF v_updated_scope_count <> v_existing_scope_count THEN
    RAISE EXCEPTION 'pkm_scope_identity_mismatch';
  END IF;

  PERFORM merge_pkm_domain_summary(
    p_user_id, p_domain,
    COALESCE(p_summary_patch, '{}'::JSONB)
      || jsonb_build_object('manifest_version', p_next_manifest_revision,
                            'content_revision', v_current_content_revision,
                            'data_version', v_current_content_revision),
    ARRAY[p_domain]
  );

  v_metadata := COALESCE(p_event_metadata, '{}'::JSONB)
    || jsonb_build_object(
      'repair_receipt_id', p_repair_receipt_id,
      'repair_kind', 'historical_entity_path_token'
    );
  INSERT INTO pkm_events (
    user_id, domain, operation_type, segment_ids, path_set, source_agent,
    prior_manifest_version, new_manifest_version, metadata, created_at
  ) VALUES (
    p_user_id, p_domain, 'manifest_refresh', ARRAY[]::TEXT[],
    COALESCE(p_changed_paths, '[]'::JSONB), 'pkm_manifest_repair',
    p_expected_manifest_revision, p_next_manifest_revision, v_metadata, v_now
  );

  RETURN jsonb_build_object(
    'success', TRUE,
    'conflict', FALSE,
    'idempotent_replay', FALSE,
    'data_version', v_current_content_revision,
    'manifest_revision', p_next_manifest_revision,
    'updated_at', v_now
  );
END;
$$;

COMMIT;
