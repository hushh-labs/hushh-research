BEGIN;
ALTER TABLE one_location_share_grants DROP COLUMN IF EXISTS sms_acknowledged_at;
COMMIT;
