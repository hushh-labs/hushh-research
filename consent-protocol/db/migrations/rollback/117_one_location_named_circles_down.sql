BEGIN;

DROP INDEX IF EXISTS idx_one_location_share_grants_source_circle;
ALTER TABLE one_location_share_grants
  DROP COLUMN IF EXISTS source_circle_id;

DROP TABLE IF EXISTS one_location_circle_invite_codes;
DROP TABLE IF EXISTS one_location_circle_memberships;
DROP TABLE IF EXISTS one_location_circles;

COMMIT;
