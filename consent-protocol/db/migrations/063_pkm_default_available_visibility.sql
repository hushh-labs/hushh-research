BEGIN;

ALTER TABLE pkm_scope_registry
  ADD COLUMN IF NOT EXISTS visibility_posture TEXT NOT NULL DEFAULT 'consent_required',
  ADD COLUMN IF NOT EXISTS default_projection_ready BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS default_projection_updated_at TIMESTAMPTZ;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'pkm_scope_registry_visibility_posture_check'
  ) THEN
    ALTER TABLE pkm_scope_registry DROP CONSTRAINT pkm_scope_registry_visibility_posture_check;
  END IF;
END $$;

ALTER TABLE pkm_scope_registry
  ADD CONSTRAINT pkm_scope_registry_visibility_posture_check
  CHECK (visibility_posture IN ('private', 'consent_required', 'default_available'));

UPDATE pkm_scope_registry
SET visibility_posture = CASE
    WHEN exposure_enabled IS FALSE THEN 'private'
    ELSE COALESCE(NULLIF(TRIM(visibility_posture), ''), 'consent_required')
  END,
  default_projection_ready = FALSE
WHERE visibility_posture IS NULL
   OR TRIM(visibility_posture) = ''
   OR exposure_enabled IS FALSE;

CREATE TABLE IF NOT EXISTS pkm_default_available_projections (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  scope TEXT NOT NULL,
  scope_handle TEXT,
  top_level_scope_path TEXT NOT NULL,
  projection_payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  projection_hash TEXT NOT NULL,
  projection_version INTEGER NOT NULL DEFAULT 1,
  manifest_version INTEGER,
  content_revision INTEGER,
  source_content_revision INTEGER,
  source_manifest_revision INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,
  revoked_reason TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB
);

CREATE INDEX IF NOT EXISTS idx_pkm_default_projection_lookup
  ON pkm_default_available_projections(user_id, scope, revoked_at);

CREATE INDEX IF NOT EXISTS idx_pkm_default_projection_domain
  ON pkm_default_available_projections(user_id, domain, top_level_scope_path, revoked_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pkm_default_projection_active_unique
  ON pkm_default_available_projections(user_id, domain, top_level_scope_path)
  WHERE revoked_at IS NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'pkm_events_operation_type_check'
  ) THEN
    ALTER TABLE pkm_events DROP CONSTRAINT pkm_events_operation_type_check;
  END IF;
END $$;

ALTER TABLE pkm_events
  ADD CONSTRAINT pkm_events_operation_type_check
  CHECK (
    operation_type IN (
      'content_write',
      'structure_create',
      'structure_extend',
      'structure_match',
      'manifest_refresh',
      'decision_projection',
      'attribute_inference',
      'segment_repartition',
      'legacy_cutover',
      'scope_exposure_update',
      'default_projection_publish',
      'default_projection_revoke'
    )
  );

COMMIT;
