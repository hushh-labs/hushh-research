BEGIN;

ALTER TABLE one_location_share_grants
  ADD COLUMN IF NOT EXISTS duration_mode TEXT NOT NULL DEFAULT 'timed';

ALTER TABLE one_location_share_grants
  ALTER COLUMN duration_hours DROP NOT NULL,
  ALTER COLUMN expires_at DROP NOT NULL;

ALTER TABLE one_location_share_grants
  DROP CONSTRAINT IF EXISTS one_location_share_grants_duration_bounds;

ALTER TABLE one_location_share_grants
  DROP CONSTRAINT IF EXISTS one_location_share_grants_duration_mode_valid;

ALTER TABLE one_location_share_grants
  DROP CONSTRAINT IF EXISTS one_location_share_grants_duration_contract;

ALTER TABLE one_location_share_grants
  ADD CONSTRAINT one_location_share_grants_duration_mode_valid
    CHECK (duration_mode IN ('timed', 'until_stopped'));

ALTER TABLE one_location_share_grants
  ADD CONSTRAINT one_location_share_grants_duration_contract
    CHECK (
      (
        duration_mode = 'timed'
        AND duration_hours IS NOT NULL
        AND duration_hours > 0
        AND duration_hours <= 24
        AND expires_at IS NOT NULL
      )
      OR (
        duration_mode = 'until_stopped'
        AND duration_hours IS NULL
        AND expires_at IS NULL
      )
    );

CREATE INDEX IF NOT EXISTS idx_one_location_share_grants_owner_active_duration_mode
  ON one_location_share_grants (owner_user_id, status, duration_mode, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_one_location_share_grants_recipient_active_duration_mode
  ON one_location_share_grants (recipient_user_id, status, duration_mode, created_at DESC);

COMMENT ON COLUMN one_location_share_grants.duration_mode IS
  'timed grants expire at expires_at; until_stopped grants stay active until explicit revoke/stop.';

COMMIT;
