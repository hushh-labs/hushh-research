-- Retire every external Source Library PKM authority while preserving the
-- append-only consent history and the owner's encrypted PKM content.

BEGIN;

-- Close the latest live authority for each app/scope pair.  A new event is
-- appended; the historical grant and its original scope string remain intact.
WITH latest_authorities AS (
  SELECT DISTINCT ON (user_id, agent_id, scope)
    user_id,
    agent_id,
    scope,
    action,
    expires_at,
    metadata,
    token_type,
    request_id,
    scope_description
  FROM consent_audit
  WHERE scope = 'attr.source_library'
     OR scope LIKE 'attr.source_library.%'
  ORDER BY user_id, agent_id, scope, issued_at DESC, id DESC
), live_authorities AS (
  SELECT *
  FROM latest_authorities
  WHERE action = 'CONSENT_GRANTED'
    AND (expires_at IS NULL OR expires_at > (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT)
)
INSERT INTO consent_audit (
  token_id,
  user_id,
  agent_id,
  scope,
  action,
  issued_at,
  expires_at,
  revoked_at,
  metadata,
  token_type,
  request_id,
  scope_description
)
SELECT
  'REVOKED_SOURCE_LIBRARY_' || md5(
    user_id || ':' || agent_id || ':' || scope || ':' || COALESCE(request_id, '')
  ),
  user_id,
  agent_id,
  scope,
  'REVOKED',
  (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT,
  expires_at,
  (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT,
  COALESCE(metadata, '{}'::JSONB) || jsonb_build_object(
    'reason', 'source_library_scope_retired',
    'authority_model', 'private_capability_boundary'
  ),
  token_type,
  request_id,
  scope_description
FROM live_authorities;

-- Pending requests are no longer actionable.  Preserve the request and append
-- a terminal event so polling clients and owner surfaces converge immediately.
WITH latest_requests AS (
  SELECT DISTINCT ON (user_id, request_id)
    user_id,
    agent_id,
    scope,
    action,
    metadata,
    token_type,
    request_id,
    scope_description
  FROM consent_audit
  WHERE request_id IS NOT NULL
    AND TRIM(request_id) <> ''
    AND (
      scope = 'attr.source_library'
      OR scope LIKE 'attr.source_library.%'
    )
    AND action IN (
      'REQUESTED', 'CONSENT_GRANTED', 'CONSENT_DENIED', 'REVOKED', 'CANCELLED', 'TIMEOUT'
    )
  ORDER BY user_id, request_id, issued_at DESC, id DESC
), pending_requests AS (
  SELECT * FROM latest_requests WHERE action = 'REQUESTED'
)
INSERT INTO consent_audit (
  token_id,
  user_id,
  agent_id,
  scope,
  action,
  issued_at,
  metadata,
  token_type,
  request_id,
  scope_description
)
SELECT
  'CANCELLED_SOURCE_LIBRARY_' || md5(user_id || ':' || request_id),
  user_id,
  agent_id,
  scope,
  'CANCELLED',
  (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT,
  COALESCE(metadata, '{}'::JSONB) || jsonb_build_object(
    'reason', 'source_library_scope_retired',
    'authority_model', 'private_capability_boundary'
  ),
  token_type,
  request_id,
  scope_description
FROM pending_requests;

-- Encrypted export copies are mutable delivery artifacts, not immutable audit.
-- Refresh jobs are removed explicitly as well as by the export FK cascade.
DELETE FROM consent_export_refresh_jobs
WHERE granted_scope = 'attr.source_library'
   OR granted_scope LIKE 'attr.source_library.%'
   OR consent_token IN (
     SELECT consent_token
     FROM consent_exports
     WHERE scope = 'attr.source_library'
        OR scope LIKE 'attr.source_library.%'
   );

DELETE FROM consent_exports
WHERE scope = 'attr.source_library'
   OR scope LIKE 'attr.source_library.%';

-- Normalize current manifest metadata to the private capability posture.  PKM
-- ciphertext and semantic paths remain intact; only external exposure metadata
-- is removed.
UPDATE pkm_manifests
SET top_level_scope_paths = ARRAY[]::TEXT[],
    externalizable_paths = ARRAY[]::TEXT[],
    externalizable_path_count = 0,
    structure_decision = jsonb_set(
      jsonb_set(
        COALESCE(structure_decision, '{}'::JSONB),
        '{top_level_scope_paths}',
        '[]'::JSONB,
        TRUE
      ),
      '{externalizable_paths}',
      '[]'::JSONB,
      TRUE
    ),
    summary_projection = COALESCE(summary_projection, '{}'::JSONB)
      || jsonb_build_object(
        'top_level_scope_count', 0,
        'externalizable_path_count', 0
      ),
    updated_at = NOW()
WHERE domain = 'source_library';

UPDATE pkm_manifest_paths
SET exposure_eligibility = FALSE,
    updated_at = NOW()
WHERE domain = 'source_library'
  AND exposure_eligibility IS DISTINCT FROM FALSE;

UPDATE pkm_scope_registry
SET exposure_enabled = FALSE,
    visibility_posture = 'private',
    default_projection_ready = FALSE,
    default_projection_updated_at = NULL,
    owner_consent_override = FALSE,
    summary_projection = COALESCE(summary_projection, '{}'::JSONB)
      || jsonb_build_object(
        'consumer_visible', FALSE,
        'internal_only', TRUE,
        'visibility_reason', 'source_library_private_capability'
      ),
    updated_at = NOW()
WHERE domain = 'source_library';

DELETE FROM pkm_default_available_projections
WHERE domain = 'source_library';

COMMIT;
