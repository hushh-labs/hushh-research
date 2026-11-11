BEGIN;
ALTER TABLE one_location_share_grants ADD COLUMN IF NOT EXISTS sms_acknowledged_at TIMESTAMPTZ;
COMMIT;
