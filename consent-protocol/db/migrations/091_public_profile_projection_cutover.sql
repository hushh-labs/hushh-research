-- Public-profile projections are owner-published resources, never encrypted
-- PKM consent scopes. Complete the 090 compatibility-table cutover.

BEGIN;

UPDATE pkm_scope_registry
SET visibility_posture = CASE
      WHEN visibility_posture = 'private' THEN 'private'
      ELSE 'consent_required'
    END,
    default_projection_ready = FALSE,
    default_projection_updated_at = NULL,
    owner_consent_override = FALSE
WHERE visibility_posture = 'default_available'
   OR default_projection_ready IS TRUE
   OR default_projection_updated_at IS NOT NULL
   OR owner_consent_override IS TRUE;

ALTER TABLE pkm_scope_registry
  DROP CONSTRAINT IF EXISTS pkm_scope_registry_visibility_posture_check;

ALTER TABLE pkm_scope_registry
  ADD CONSTRAINT pkm_scope_registry_visibility_posture_check
  CHECK (visibility_posture IN ('private', 'consent_required'));

-- A projection that lacks provenance is private and cannot be served. Existing
-- active legacy rows were classified in 090; this final guard keeps future
-- readers fail-closed even when an older writer is accidentally deployed.
UPDATE pkm_default_available_projections
SET revoked_at = COALESCE(revoked_at, NOW()),
    revoked_reason = COALESCE(revoked_reason, 'missing_publication_provenance')
WHERE revoked_at IS NULL
  AND NULLIF(TRIM(COALESCE(publication_provenance, '')), '') IS NULL;

COMMENT ON TABLE pkm_default_available_projections IS
  'Compatibility storage for owner-published public-profile projections; not a PKM scope or encrypted-consent authority.';

COMMIT;
