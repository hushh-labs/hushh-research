-- Separate public profile identity/provenance from encrypted PKM scope posture.
-- This migration is intentionally non-breaking: callers migrate to the new
-- contract before the legacy default_available posture is removed.

BEGIN;

ALTER TABLE pkm_default_available_projections
  ADD COLUMN IF NOT EXISTS public_profile_handle UUID NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS publication_provenance TEXT,
  ADD COLUMN IF NOT EXISTS publication_confirmed_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_pkm_public_projection_handle
  ON pkm_default_available_projections(public_profile_handle);

-- Only rows with an extant projection and explicit owner publication evidence
-- are eligible for the public-profile cutover. Ambiguous rows are not inferred
-- to be public and their encrypted scope posture becomes private.
UPDATE pkm_default_available_projections
SET publication_provenance = 'legacy_explicit_owner_projection',
    publication_confirmed_at = COALESCE(publication_confirmed_at, created_at)
WHERE revoked_at IS NULL
  AND COALESCE(projection_hash, '') <> ''
  AND COALESCE(projection_payload, '{}'::JSONB) <> '{}'::JSONB
  AND COALESCE(metadata->>'owner_confirmed', '') IN ('true', '1');

UPDATE pkm_scope_registry AS registry
SET visibility_posture = CASE
      WHEN EXISTS (
        SELECT 1
        FROM pkm_default_available_projections AS projection
        WHERE projection.user_id = registry.user_id
          AND projection.domain = registry.domain
          AND projection.scope_handle = registry.scope_handle
          AND projection.revoked_at IS NULL
          AND projection.publication_provenance IS NOT NULL
      ) THEN 'consent_required'
      ELSE 'private'
    END,
    exposure_enabled = CASE
      WHEN EXISTS (
        SELECT 1
        FROM pkm_default_available_projections AS projection
        WHERE projection.user_id = registry.user_id
          AND projection.domain = registry.domain
          AND projection.scope_handle = registry.scope_handle
          AND projection.revoked_at IS NULL
          AND projection.publication_provenance IS NOT NULL
      ) THEN TRUE
      ELSE FALSE
    END,
    default_projection_ready = FALSE,
    default_projection_updated_at = NULL,
    owner_consent_override = FALSE
WHERE registry.visibility_posture = 'default_available';

COMMENT ON COLUMN pkm_default_available_projections.public_profile_handle IS
  'Opaque public resource identity; never an attr.* consent scope or PKM path.';
COMMENT ON COLUMN pkm_default_available_projections.publication_provenance IS
  'Explicit owner-publication evidence. NULL means private/ambiguous and must not be served publicly.';

COMMIT;
