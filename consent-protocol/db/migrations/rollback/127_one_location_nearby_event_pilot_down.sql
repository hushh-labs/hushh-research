-- Unshipped-only rollback for migration 127.
-- Once production data exists, disable the pilot and use forward migrations;
-- do not run this destructive rollback.
BEGIN;

DROP TABLE IF EXISTS one_location_nearby_audit_events;
DROP TABLE IF EXISTS one_location_nearby_abuse_windows;
DROP TABLE IF EXISTS one_location_nearby_reports;
DROP TABLE IF EXISTS one_location_nearby_blocks;

ALTER TABLE one_location_nearby_presences
  DROP CONSTRAINT IF EXISTS chk_one_location_nearby_presence_admission;
DROP INDEX IF EXISTS idx_one_location_nearby_presence_event;
ALTER TABLE one_location_nearby_presences
  DROP COLUMN IF EXISTS admission_claim_id,
  DROP COLUMN IF EXISTS event_id,
  DROP COLUMN IF EXISTS admission_mode;

DROP TABLE IF EXISTS one_location_nearby_admission_claims;
DROP TABLE IF EXISTS one_location_nearby_event_pilots;

COMMIT;
