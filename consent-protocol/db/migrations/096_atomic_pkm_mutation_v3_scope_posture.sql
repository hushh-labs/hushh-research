-- Preserve existing scope posture supplied by the PKM service while keeping
-- the v2 ciphertext/manifest/event commit as the single transactional core.

BEGIN;

CREATE OR REPLACE FUNCTION commit_pkm_domain_mutation_v3(
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
  v_result JSONB;
BEGIN
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

  v_result := commit_pkm_domain_mutation_v2(
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

  IF COALESCE((v_result->>'success')::BOOLEAN, FALSE) THEN
    UPDATE pkm_scope_registry AS registry
    SET
      exposure_enabled = row_data.exposure_enabled,
      visibility_posture = row_data.visibility_posture,
      default_projection_ready = COALESCE(row_data.default_projection_ready, FALSE),
      default_projection_updated_at = row_data.default_projection_updated_at,
      owner_consent_override = COALESCE(row_data.owner_consent_override, FALSE)
    FROM jsonb_to_recordset(COALESCE(p_scope_rows, '[]'::JSONB)) AS row_data(
      scope_handle TEXT,
      exposure_enabled BOOLEAN,
      visibility_posture TEXT,
      default_projection_ready BOOLEAN,
      default_projection_updated_at TIMESTAMPTZ,
      owner_consent_override BOOLEAN
    )
    WHERE registry.user_id = p_user_id
      AND registry.domain = p_domain
      AND registry.scope_handle = row_data.scope_handle;
  END IF;

  RETURN v_result;
END;
$$;

COMMIT;
