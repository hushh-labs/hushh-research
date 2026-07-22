BEGIN;

ALTER TABLE one_location_share_grants
  ADD COLUMN IF NOT EXISTS access_origin TEXT NOT NULL DEFAULT 'direct';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'one_location_share_grants_access_origin_check'
  ) THEN
    ALTER TABLE one_location_share_grants
      ADD CONSTRAINT one_location_share_grants_access_origin_check
      CHECK (access_origin IN ('direct', 'request_approved', 'connections_visibility'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS one_location_visibility_preferences (
  owner_user_id TEXT PRIMARY KEY,
  audience TEXT NOT NULL DEFAULT 'private'
    CHECK (audience IN ('private', 'connections')),
  precision TEXT NOT NULL DEFAULT 'precise'
    CHECK (precision IN ('precise', 'approximate')),
  enabled_at TIMESTAMPTZ,
  disabled_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS one_location_visibility_exclusions (
  owner_user_id TEXT NOT NULL,
  excluded_user_id TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'owner',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, excluded_user_id),
  CONSTRAINT one_location_visibility_exclusions_not_self
    CHECK (owner_user_id <> excluded_user_id)
);

ALTER TABLE one_location_visibility_exclusions
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'owner';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'one_location_visibility_exclusions_source_check'
  ) THEN
    ALTER TABLE one_location_visibility_exclusions
      ADD CONSTRAINT one_location_visibility_exclusions_source_check
      CHECK (source IN ('owner', 'recipient'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_one_location_visibility_active_pair
  ON one_location_share_grants (owner_user_id, recipient_user_id)
  WHERE status = 'active' AND access_origin = 'connections_visibility';

CREATE INDEX IF NOT EXISTS idx_one_location_visibility_preferences_audience
  ON one_location_visibility_preferences (audience, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_one_location_visibility_exclusions_owner
  ON one_location_visibility_exclusions (owner_user_id, excluded_user_id);

COMMENT ON COLUMN one_location_share_grants.access_origin IS
  'Coordinate-free grant purpose. Managed connection visibility must not replace direct or request-approved access.';
COMMENT ON TABLE one_location_visibility_preferences IS
  'Owner-controlled metadata-only audience policy for encrypted One Location visibility.';
COMMENT ON TABLE one_location_visibility_exclusions IS
  'Per-owner connection exclusions. This table must never contain coordinates or map information.';

COMMIT;
