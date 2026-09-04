-- Destructive-looking operations in this file are isolated inside one
-- transaction and always rolled back. Run with psql -v ON_ERROR_STOP=1.

BEGIN;

DO $$
DECLARE
  v_user_id CONSTANT TEXT := '__pkm_v7_zero_loss_rehearsal__';
  v_domain CONSTANT TEXT := 'financial';
  v_mutation_commit CONSTANT UUID := '10000000-0000-4000-8000-000000000001';
  v_rollback_commit CONSTANT UUID := '10000000-0000-4000-8000-000000000002';
  v_snapshot JSONB;
  v_result JSONB;
  v_replay JSONB;
  v_claim JSONB;
  v_archived_revision UUID;
  v_public_projection JSONB;
  v_caught BOOLEAN;
  v_now TEXT := NOW()::TEXT;
  v_segments_v2 JSONB;
  v_manifest_v2 JSONB;
  v_segments_v3 JSONB;
  v_manifest_v3 JSONB;
BEGIN
  INSERT INTO vault_keys (
    user_id, vault_status, primary_method, created_at, updated_at
  ) VALUES (
    v_user_id, 'placeholder', 'passphrase', 0, 0
  );

  INSERT INTO pkm_blobs (
    user_id, domain, segment_id, ciphertext, iv, tag, algorithm,
    content_revision, manifest_revision, size_bytes
  ) VALUES
    (v_user_id, v_domain, 'root', 'cipher-root-v1', 'iv-root-v1', 'tag-root-v1',
     'aes-256-gcm', 1, 1, 14),
    (v_user_id, v_domain, 'profile', 'cipher-profile-v1', 'iv-profile-v1',
     'tag-profile-v1', 'aes-256-gcm', 1, 1, 17);

  INSERT INTO pkm_manifests (
    user_id, domain, manifest_version, structure_decision, summary_projection,
    top_level_scope_paths, externalizable_paths, segment_ids, path_count,
    externalizable_path_count, domain_contract_version, readable_summary_version,
    last_structured_at, last_content_at, pkm_contract_version,
    readable_projection_version
  ) VALUES (
    v_user_id, v_domain, 1, '{}'::JSONB,
    '{"pkm_contract_version":"6.0.0","readable_projection_version":"6.0.0"}'::JSONB,
    ARRAY['portfolio'], ARRAY['portfolio'], ARRAY['root', 'profile'], 1, 1,
    4, 1, NOW(), NOW(), '6.0.0', '6.0.0'
  );

  v_snapshot := get_pkm_domain_snapshot_v1(v_user_id, v_domain, ARRAY['root']);
  IF (v_snapshot->>'content_revision')::INTEGER <> 1
     OR (v_snapshot->>'manifest_revision')::INTEGER <> 1
     OR (SELECT COUNT(*) FROM jsonb_object_keys(v_snapshot->'segments')) <> 1 THEN
    RAISE EXCEPTION 'coherent_snapshot_rehearsal_failed';
  END IF;

  UPDATE pkm_blobs
  SET content_revision = 2
  WHERE user_id = v_user_id AND domain = v_domain AND segment_id = 'profile';
  v_caught := FALSE;
  BEGIN
    PERFORM get_pkm_domain_snapshot_v1(v_user_id, v_domain, ARRAY['root']);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'mixed_pkm_domain_revisions' THEN
      RAISE;
    END IF;
    v_caught := TRUE;
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'hidden_mixed_revision_was_not_rejected';
  END IF;
  UPDATE pkm_blobs
  SET content_revision = 1
  WHERE user_id = v_user_id AND domain = v_domain AND segment_id = 'profile';

  UPDATE pkm_manifests
  SET manifest_version = 2
  WHERE user_id = v_user_id AND domain = v_domain;
  v_caught := FALSE;
  BEGIN
    PERFORM get_pkm_domain_snapshot_v1(v_user_id, v_domain, ARRAY[]::TEXT[]);
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'mixed_pkm_domain_revisions' THEN
      RAISE;
    END IF;
    v_caught := TRUE;
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'manifest_revision_mismatch_was_not_rejected';
  END IF;
  UPDATE pkm_manifests
  SET manifest_version = 1
  WHERE user_id = v_user_id AND domain = v_domain;

  v_segments_v2 := jsonb_build_array(
    jsonb_build_object(
      'segment_id', 'root', 'ciphertext', 'cipher-root-v2', 'iv', 'iv-root-v2',
      'tag', 'tag-root-v2', 'algorithm', 'aes-256-gcm',
      'manifest_revision', 2, 'size_bytes', 14
    ),
    jsonb_build_object(
      'segment_id', 'profile', 'ciphertext', 'cipher-profile-v2',
      'iv', 'iv-profile-v2', 'tag', 'tag-profile-v2', 'algorithm', 'aes-256-gcm',
      'manifest_revision', 2, 'size_bytes', 17
    )
  );
  v_manifest_v2 := jsonb_build_object(
    'manifest_version', 2,
    'domain_contract_version', 4,
    'readable_summary_version', 1,
    'pkm_contract_version', '6.0.0',
    'readable_projection_version', '6.0.0',
    'structure_decision', '{}'::JSONB,
    'summary_projection', jsonb_build_object(
      'pkm_contract_version', '6.0.0',
      'readable_projection_version', '6.0.0'
    ),
    'top_level_scope_paths', jsonb_build_array('portfolio'),
    'externalizable_paths', jsonb_build_array('portfolio'),
    'segment_ids', jsonb_build_array('root', 'profile'),
    'path_count', 1,
    'externalizable_path_count', 1,
    'last_structured_at', v_now,
    'last_content_at', v_now
  );

  v_result := commit_pkm_domain_mutation_v4(
    v_user_id, v_domain, 1, 2, v_segments_v2, v_manifest_v2,
    '[]'::JSONB, '[]'::JSONB, '{}'::JSONB, '[]'::JSONB, FALSE,
    ARRAY[]::TEXT[], '[]'::JSONB, v_mutation_commit, 'mutation', NULL, '{}'::JSONB,
    repeat('1', 64)
  );
  IF NOT COALESCE((v_result->>'success')::BOOLEAN, FALSE)
     OR (v_result->>'data_version')::INTEGER <> 2
     OR v_result->>'archived_revision_id' IS NULL THEN
    RAISE EXCEPTION 'atomic_mutation_archive_rehearsal_failed';
  END IF;

  v_replay := commit_pkm_domain_mutation_v4(
    v_user_id, v_domain, 1, 2, v_segments_v2, v_manifest_v2,
    '[]'::JSONB, '[]'::JSONB, '{}'::JSONB, '[]'::JSONB, FALSE,
    ARRAY[]::TEXT[], '[]'::JSONB, v_mutation_commit, 'mutation', NULL, '{}'::JSONB,
    repeat('1', 64)
  );
  IF COALESCE((v_replay->>'idempotent_replay')::BOOLEAN, FALSE) IS NOT TRUE THEN
    RAISE EXCEPTION 'exact_idempotent_replay_failed';
  END IF;
  v_caught := FALSE;
  BEGIN
    PERFORM commit_pkm_domain_mutation_v4(
      v_user_id, v_domain, 1, 2, v_segments_v2, v_manifest_v2,
      '[]'::JSONB, '[]'::JSONB, '{}'::JSONB, '[]'::JSONB, FALSE,
      ARRAY[]::TEXT[], '[]'::JSONB, v_mutation_commit, 'mutation', NULL, '{}'::JSONB,
      repeat('5', 64)
    );
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'pkm_commit_id_binding_mismatch' THEN
      RAISE;
    END IF;
    v_caught := TRUE;
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'commit_fingerprint_mismatch_was_not_rejected';
  END IF;

  INSERT INTO pkm_default_available_projections (
    user_id, domain, scope, scope_handle, top_level_scope_path,
    projection_payload, projection_hash, projection_version,
    manifest_version, content_revision, source_content_revision,
    source_manifest_revision, metadata, publication_provenance,
    publication_confirmed_at
  ) VALUES (
    v_user_id, v_domain, 'attr.financial.portfolio', 'stable_scope_handle',
    'portfolio', '{"approved":"snapshot"}'::JSONB, 'stable-projection-hash', 1,
    2, 2, 2, 2, '{"owner_confirmed":true}'::JSONB,
    'owner_explicit_publish', NOW()
  );
  SELECT jsonb_build_object(
    'payload', projection_payload,
    'hash', projection_hash,
    'version', projection_version,
    'source_content_revision', source_content_revision,
    'source_manifest_revision', source_manifest_revision,
    'revoked_at', revoked_at
  ) INTO v_public_projection
  FROM pkm_default_available_projections
  WHERE user_id = v_user_id AND domain = v_domain;

  INSERT INTO pkm_upgrade_runs (
    run_id, user_id, status, from_model_version, to_model_version,
    current_domain, initiated_by, mode
  ) VALUES (
    'pkm_v7_rehearsal_run', v_user_id, 'running', 6, 7,
    v_domain, 'protected_uat_rehearsal', 'real'
  );
  INSERT INTO pkm_upgrade_steps (
    run_id, domain, status, from_domain_contract_version,
    to_domain_contract_version, from_readable_summary_version,
    to_readable_summary_version
  ) VALUES (
    'pkm_v7_rehearsal_run', v_domain, 'pending', 4, 5, 1, 2
  );

  v_caught := FALSE;
  BEGIN
    PERFORM transition_pkm_upgrade_run_v1(
      '__different_owner__', 'pkm_v7_rehearsal_run', 'running'
    );
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'pkm_upgrade_run_not_owned' THEN
      RAISE;
    END IF;
    v_caught := TRUE;
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'cross_owner_transition_was_not_rejected';
  END IF;

  PERFORM transition_pkm_upgrade_step_v1(
    v_user_id, 'pkm_v7_rehearsal_run', v_domain, 'running',
    '{"stage":"loading_domain"}'::JSONB, 1, NULL, NULL
  );
  v_caught := FALSE;
  BEGIN
    PERFORM transition_pkm_upgrade_step_v1(
      v_user_id, 'pkm_v7_rehearsal_run', v_domain, 'completed',
      '{"stage":"completed"}'::JSONB, 1, 2, 2
    );
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'pkm_upgrade_step_has_no_committed_upgrade' THEN
      RAISE;
    END IF;
    v_caught := TRUE;
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'uncommitted_step_completion_was_not_rejected';
  END IF;

  v_claim := issue_pkm_upgrade_claim_v1(
    v_user_id, 'pkm_v7_rehearsal_run', v_domain, 2, 2,
    5, 2, '7.0.0', '7.0.0', 300
  );
  v_segments_v3 := jsonb_build_array(
    jsonb_build_object(
      'segment_id', 'root', 'ciphertext', 'cipher-root-v3', 'iv', 'iv-root-v3',
      'tag', 'tag-root-v3', 'algorithm', 'aes-256-gcm',
      'manifest_revision', 3, 'size_bytes', 14
    ),
    jsonb_build_object(
      'segment_id', 'profile', 'ciphertext', 'cipher-profile-v3',
      'iv', 'iv-profile-v3', 'tag', 'tag-profile-v3', 'algorithm', 'aes-256-gcm',
      'manifest_revision', 3, 'size_bytes', 17
    )
  );
  v_manifest_v3 := v_manifest_v2 || jsonb_build_object(
    'manifest_version', 3,
    'domain_contract_version', 5,
    'readable_summary_version', 2,
    'pkm_contract_version', '7.0.0',
    'readable_projection_version', '7.0.0'
  );
  v_result := commit_pkm_domain_mutation_v4(
    v_user_id, v_domain, 2, 3, v_segments_v3, v_manifest_v3,
    '[]'::JSONB, '[]'::JSONB, '{}'::JSONB, '[]'::JSONB, FALSE,
    ARRAY[]::TEXT[], '[]'::JSONB, (v_claim->>'commit_id')::UUID,
    'upgrade', v_claim,
    '{"schema_version":"pkm_preservation_receipt.v1","total_source_occurrences":2,"preserved":2,"moved":0,"equal_value_deduplicated":0,"quarantined":0,"rejected":0,"complete":true}'::JSONB,
    repeat('2', 64)
  );
  v_archived_revision := (v_result->>'archived_revision_id')::UUID;
  IF v_archived_revision IS NULL OR NOT EXISTS (
    SELECT 1 FROM pkm_domain_revisions
    WHERE revision_id = v_archived_revision AND is_origin
      AND retention_expires_at IS NULL
  ) THEN
    RAISE EXCEPTION 'lifetime_origin_snapshot_rehearsal_failed';
  END IF;

  v_caught := FALSE;
  BEGIN
    PERFORM transition_pkm_upgrade_step_v1(
      v_user_id, 'pkm_v7_rehearsal_run', v_domain, 'completed',
      '{"stage":"completed"}'::JSONB, 1, 99, 3
    );
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'pkm_upgrade_step_revision_mismatch' THEN
      RAISE;
    END IF;
    v_caught := TRUE;
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'mismatched_completed_revision_was_not_rejected';
  END IF;
  PERFORM transition_pkm_upgrade_step_v1(
    v_user_id, 'pkm_v7_rehearsal_run', v_domain, 'completed',
    '{"stage":"completed"}'::JSONB, 1, 3, 3
  );
  PERFORM transition_pkm_upgrade_run_v1(
    v_user_id, 'pkm_v7_rehearsal_run', 'completed', NULL, TRUE
  );

  v_result := rollback_pkm_domain_revision_v1(
    v_user_id, 'pkm_v7_rehearsal_run', v_domain, v_archived_revision,
    3, 3, v_rollback_commit
  );
  IF NOT COALESCE((v_result->>'success')::BOOLEAN, FALSE)
     OR (v_result->>'data_version')::INTEGER <> 4
     OR (v_result->>'manifest_revision')::INTEGER <> 4 THEN
    RAISE EXCEPTION 'rollback_rehearsal_failed';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pkm_blobs
    WHERE user_id = v_user_id AND domain = v_domain
      AND segment_id = 'root' AND ciphertext = 'cipher-root-v2'
      AND content_revision = 4 AND manifest_revision = 4
  ) THEN
    RAISE EXCEPTION 'rollback_ciphertext_restore_failed';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pkm_manifests
    WHERE user_id = v_user_id AND domain = v_domain
      AND (summary_projection->>'manifest_version')::INTEGER = 4
      AND (summary_projection->>'content_revision')::INTEGER = 4
      AND (summary_projection->>'data_version')::INTEGER = 4
  ) THEN
    RAISE EXCEPTION 'rollback_manifest_projection_revision_mismatch';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pkm_index
    WHERE user_id = v_user_id
      AND (domain_summaries->v_domain->>'manifest_version')::INTEGER = 4
      AND (domain_summaries->v_domain->>'content_revision')::INTEGER = 4
      AND (domain_summaries->v_domain->>'data_version')::INTEGER = 4
  ) THEN
    RAISE EXCEPTION 'rollback_index_revision_mismatch';
  END IF;
  IF v_public_projection IS DISTINCT FROM (
    SELECT jsonb_build_object(
      'payload', projection_payload,
      'hash', projection_hash,
      'version', projection_version,
      'source_content_revision', source_content_revision,
      'source_manifest_revision', source_manifest_revision,
      'revoked_at', revoked_at
    )
    FROM pkm_default_available_projections
    WHERE user_id = v_user_id AND domain = v_domain
  ) THEN
    RAISE EXCEPTION 'owner_published_projection_changed_during_rollback';
  END IF;

  v_caught := FALSE;
  BEGIN
    PERFORM commit_pkm_domain_mutation_v4(
      v_user_id, v_domain, 4, 5,
      jsonb_build_array(
        jsonb_build_object(
          'segment_id', 'root', 'ciphertext', 'cipher-root-v5', 'iv', 'iv-root-v5',
          'tag', 'tag-root-v5', 'algorithm', 'aes-256-gcm',
          'manifest_revision', 5, 'size_bytes', 14
        ),
        jsonb_build_object(
          'segment_id', '__quarantine_v1', 'ciphertext', 'cipher-quarantine-v5',
          'iv', 'iv-quarantine-v5', 'tag', 'tag-quarantine-v5',
          'algorithm', 'aes-256-gcm', 'manifest_revision', 5, 'size_bytes', 20
        )
      ),
      v_manifest_v2 || jsonb_build_object(
        'manifest_version', 5,
        'segment_ids', jsonb_build_array('root', '__quarantine_v1')
      ),
      jsonb_build_array(jsonb_build_object(
        'json_path', '__quarantine_v1.legacy',
        'path_type', 'leaf',
        'segment_id', '__quarantine_v1',
        'exposure_eligibility', TRUE
      )),
      '[]'::JSONB, '{}'::JSONB, '[]'::JSONB, FALSE,
      ARRAY[]::TEXT[], '[]'::JSONB,
      '10000000-0000-4000-8000-000000000003'::UUID,
      'mutation', NULL, '{}'::JSONB, repeat('3', 64)
    );
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'pkm_quarantine_must_be_private' THEN
      RAISE;
    END IF;
    v_caught := TRUE;
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'exportable_quarantine_was_not_rejected';
  END IF;
END;
$$;

DO $$
DECLARE
  v_user_id CONSTANT TEXT := '__pkm_v7_legacy_rehearsal__';
  v_domain CONSTANT TEXT := 'financial';
  v_claim JSONB;
  v_result JSONB;
  v_snapshot JSONB;
  v_archived_revision UUID;
BEGIN
  INSERT INTO vault_keys (
    user_id, vault_status, primary_method, created_at, updated_at
  ) VALUES (
    v_user_id, 'placeholder', 'passphrase', 0, 0
  );
  INSERT INTO pkm_data (
    user_id, encrypted_data_ciphertext, encrypted_data_iv,
    encrypted_data_tag, algorithm, data_version
  ) VALUES (
    v_user_id, 'legacy-full-ciphertext', 'legacy-iv', 'legacy-tag',
    'aes-256-gcm', 7
  );
  INSERT INTO pkm_upgrade_runs (
    run_id, user_id, status, from_model_version, to_model_version,
    current_domain, initiated_by, mode
  ) VALUES (
    'pkm_v7_legacy_rehearsal_run', v_user_id, 'running', 6, 7,
    v_domain, 'protected_uat_rehearsal', 'real'
  );
  INSERT INTO pkm_upgrade_steps (
    run_id, domain, status, from_domain_contract_version,
    to_domain_contract_version, from_readable_summary_version,
    to_readable_summary_version
  ) VALUES (
    'pkm_v7_legacy_rehearsal_run', v_domain, 'pending', 0, 5, 0, 2
  );

  v_claim := issue_pkm_upgrade_claim_v1(
    v_user_id, 'pkm_v7_legacy_rehearsal_run', v_domain, 7, 0,
    5, 2, '7.0.0', '7.0.0', 300
  );
  v_result := commit_pkm_domain_mutation_v4(
    v_user_id, v_domain, 7, 8,
    jsonb_build_array(jsonb_build_object(
      'segment_id', 'root', 'ciphertext', 'domain-cipher-v8',
      'iv', 'domain-iv-v8', 'tag', 'domain-tag-v8',
      'algorithm', 'aes-256-gcm', 'manifest_revision', 1, 'size_bytes', 16
    )),
    jsonb_build_object(
      'manifest_version', 1,
      'domain_contract_version', 5,
      'readable_summary_version', 2,
      'pkm_contract_version', '7.0.0',
      'readable_projection_version', '7.0.0',
      'structure_decision', '{}'::JSONB,
      'summary_projection', '{}'::JSONB,
      'top_level_scope_paths', '[]'::JSONB,
      'externalizable_paths', '[]'::JSONB,
      'segment_ids', jsonb_build_array('root'),
      'path_count', 0,
      'externalizable_path_count', 0,
      'last_structured_at', NOW()::TEXT,
      'last_content_at', NOW()::TEXT
    ),
    '[]'::JSONB, '[]'::JSONB, '{}'::JSONB, '[]'::JSONB, TRUE,
    ARRAY[]::TEXT[], '[]'::JSONB, (v_claim->>'commit_id')::UUID,
    'upgrade', v_claim,
    '{"schema_version":"pkm_preservation_receipt.v1","total_source_occurrences":1,"preserved":1,"moved":0,"equal_value_deduplicated":0,"quarantined":0,"rejected":0,"complete":true}'::JSONB,
    repeat('4', 64)
  );
  v_archived_revision := (v_result->>'archived_revision_id')::UUID;
  IF NOT COALESCE((v_result->>'success')::BOOLEAN, FALSE)
     OR (v_result->>'data_version')::INTEGER <> 8
     OR v_archived_revision IS NULL THEN
    RAISE EXCEPTION 'legacy_full_blob_upgrade_failed';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pkm_domain_revisions revisions
    JOIN pkm_domain_revision_segments segments
      ON segments.revision_id = revisions.revision_id
    WHERE revisions.revision_id = v_archived_revision
      AND revisions.is_origin
      AND revisions.source_content_revision = 7
      AND revisions.source_manifest_revision = 0
      AND segments.segment_id = 'root'
      AND segments.ciphertext = 'legacy-full-ciphertext'
      AND segments.original_content_revision = 7
  ) THEN
    RAISE EXCEPTION 'legacy_full_blob_origin_snapshot_missing';
  END IF;

  v_result := rollback_pkm_domain_revision_v1(
    v_user_id, 'pkm_v7_legacy_rehearsal_run', v_domain,
    v_archived_revision, 8, 1,
    '10000000-0000-4000-8000-000000000005'::UUID
  );
  IF NOT COALESCE((v_result->>'success')::BOOLEAN, FALSE)
     OR (v_result->>'data_version')::INTEGER <> 9
     OR (v_result->>'manifest_revision')::INTEGER <> 2 THEN
    RAISE EXCEPTION 'legacy_full_blob_rollback_failed';
  END IF;
  v_snapshot := get_pkm_domain_snapshot_v1(v_user_id, v_domain, ARRAY[]::TEXT[]);
  IF v_snapshot->>'storage_mode' <> 'legacy_full_blob'
     OR (v_snapshot->>'content_revision')::INTEGER <> 9
     OR (v_snapshot->>'manifest_revision')::INTEGER <> 2
     OR v_snapshot->'segments'->'root'->>'ciphertext' <> 'legacy-full-ciphertext' THEN
    RAISE EXCEPTION 'legacy_full_blob_rollback_snapshot_mismatch';
  END IF;
END;
$$;

ROLLBACK;
