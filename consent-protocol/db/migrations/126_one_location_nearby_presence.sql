BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Short-lived, explicitly opted-in nearby presence for One Location.
--
-- Privacy boundary:
-- - the device's foreground GPS fix is request-memory-only and is never stored;
-- - the user-selected public place anchor is stored only as an authenticated
--   encryption envelope;
-- - anchor_cell_token is a server-keyed, six-hour spatial candidate token. It
--   is only a broad-phase lookup key; the service decrypts candidate anchors
--   and performs the exact radius check before returning anyone;
-- - aliases rotate on every check-in and coordinates, distance, address,
--   email, phone, and stable user ids are never returned to peers;
-- - checkout and expiry clear all anchor material immediately.
CREATE TABLE IF NOT EXISTS one_location_nearby_presences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id TEXT NOT NULL
    REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  participant_alias UUID NOT NULL DEFAULT gen_random_uuid(),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'checked_out', 'expired')),
  audience TEXT NOT NULL DEFAULT 'all_opted_in'
    CHECK (audience IN ('all_opted_in')),
  allow_connection_requests BOOLEAN NOT NULL DEFAULT FALSE,
  consent_version TEXT NOT NULL,
  radius_meters SMALLINT NOT NULL DEFAULT 500
    CHECK (radius_meters = 500),
  anchor_ciphertext TEXT,
  anchor_iv TEXT,
  anchor_tag TEXT,
  anchor_algorithm TEXT,
  anchor_key_id TEXT,
  anchor_cell_epoch BIGINT,
  anchor_cell_token TEXT,
  checked_in_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  checked_out_at TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_one_location_nearby_presence_owner UNIQUE (owner_user_id),
  CONSTRAINT uq_one_location_nearby_presence_alias UNIQUE (participant_alias),
  CONSTRAINT chk_one_location_nearby_presence_expiry
    CHECK (expires_at > checked_in_at),
  CONSTRAINT chk_one_location_nearby_presence_checkout
    CHECK (
      (status = 'checked_out' AND checked_out_at IS NOT NULL)
      OR (status <> 'checked_out')
    ),
  CONSTRAINT chk_one_location_nearby_presence_anchor_lifecycle
    CHECK (
      (
        status = 'active'
        AND anchor_ciphertext IS NOT NULL
        AND anchor_iv IS NOT NULL
        AND anchor_tag IS NOT NULL
        AND anchor_algorithm = 'aes-256-gcm'
        AND anchor_key_id IS NOT NULL
        AND anchor_cell_epoch IS NOT NULL
        AND anchor_cell_token IS NOT NULL
      )
      OR
      (
        status <> 'active'
        AND anchor_ciphertext IS NULL
        AND anchor_iv IS NULL
        AND anchor_tag IS NULL
        AND anchor_algorithm IS NULL
        AND anchor_key_id IS NULL
        AND anchor_cell_epoch IS NULL
        AND anchor_cell_token IS NULL
      )
    )
);

CREATE INDEX IF NOT EXISTS idx_one_location_nearby_presence_discovery
  ON one_location_nearby_presences (
    anchor_cell_epoch,
    anchor_cell_token,
    expires_at
  )
  INCLUDE (owner_user_id, participant_alias, version)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_one_location_nearby_presence_retention
  ON one_location_nearby_presences (status, expires_at, updated_at);

COMMENT ON TABLE one_location_nearby_presences IS
  'Encrypted, short-lived nearby check-in presence. Raw device GPS is request-memory-only; selected public-place anchors are encrypted and cleared on checkout or expiry.';

COMMENT ON COLUMN one_location_nearby_presences.anchor_cell_token IS
  'Six-hour server-keyed spatial candidate token. Exact radius membership is always rechecked against decrypted selected-place anchors.';

COMMENT ON COLUMN one_location_nearby_presences.participant_alias IS
  'Rotating opaque alias exposed to other active opted-in nearby users instead of a stable user id.';

COMMIT;
