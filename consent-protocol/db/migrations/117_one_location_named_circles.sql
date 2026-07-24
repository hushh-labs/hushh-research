BEGIN;

-- Named Circles are a metadata-only relationship graph. Membership makes two
-- active members eligible to start an explicit, duration-bounded location
-- share; it never creates a connection, trusted edge, grant, SMS selection, or
-- ciphertext envelope by itself.
CREATE TABLE IF NOT EXISTS one_location_circles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id TEXT NOT NULL
    REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  name VARCHAR(80) NOT NULL,
  kind VARCHAR(16) NOT NULL DEFAULT 'other'
    CHECK (kind IN ('family', 'friends', 'other')),
  status VARCHAR(16) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'deleted')),
  member_limit SMALLINT NOT NULL DEFAULT 20
    CHECK (member_limit BETWEEN 2 AND 20),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT one_location_circles_name_not_blank
    CHECK (btrim(name) <> '')
);

CREATE INDEX IF NOT EXISTS idx_one_location_circles_owner_status
  ON one_location_circles (owner_user_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS one_location_circle_memberships (
  circle_id UUID NOT NULL
    REFERENCES one_location_circles(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL
    REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  role VARCHAR(16) NOT NULL DEFAULT 'member'
    CHECK (role IN ('owner', 'member')),
  status VARCHAR(16) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'left', 'removed')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (circle_id, user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_one_location_circle_active_owner
  ON one_location_circle_memberships (circle_id)
  WHERE role = 'owner' AND status = 'active';

CREATE INDEX IF NOT EXISTS idx_one_location_circle_memberships_user
  ON one_location_circle_memberships (user_id, status, joined_at DESC);

CREATE INDEX IF NOT EXISTS idx_one_location_circle_memberships_circle
  ON one_location_circle_memberships (circle_id, status, joined_at);

CREATE TABLE IF NOT EXISTS one_location_circle_invite_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  circle_id UUID NOT NULL
    REFERENCES one_location_circles(id) ON DELETE CASCADE,
  created_by_user_id TEXT NOT NULL
    REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  code_hash CHAR(64) NOT NULL UNIQUE,
  status VARCHAR(16) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked', 'expired')),
  expires_at TIMESTAMPTZ NOT NULL,
  max_uses SMALLINT NOT NULL DEFAULT 20
    CHECK (max_uses BETWEEN 1 AND 20),
  use_count SMALLINT NOT NULL DEFAULT 0
    CHECK (use_count BETWEEN 0 AND max_uses),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_one_location_circle_active_invite
  ON one_location_circle_invite_codes (circle_id)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_one_location_circle_invite_expiry
  ON one_location_circle_invite_codes (status, expires_at);

ALTER TABLE one_location_share_grants
  ADD COLUMN IF NOT EXISTS source_circle_id UUID
    REFERENCES one_location_circles(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_one_location_share_grants_source_circle
  ON one_location_share_grants (source_circle_id, status)
  WHERE source_circle_id IS NOT NULL;

COMMENT ON TABLE one_location_circles IS
  'Named, metadata-only One Location groups. Membership grants no location access by itself.';
COMMENT ON TABLE one_location_circle_memberships IS
  'Owner/member relationship metadata for named Circles; explicit live-location grants remain authoritative.';
COMMENT ON TABLE one_location_circle_invite_codes IS
  'Reusable, expiring Circle join-code workflow state. Only keyed HMAC digests are persisted.';
COMMENT ON COLUMN one_location_share_grants.source_circle_id IS
  'Optional provenance for an explicit share started from a Circle; membership exit revokes it and hard Circle deletion cascades it.';

COMMIT;
