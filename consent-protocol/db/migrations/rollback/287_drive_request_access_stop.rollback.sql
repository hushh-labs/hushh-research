BEGIN;
DROP TABLE IF EXISTS drive_request_bulk_removals;
ALTER TABLE drive_share_requests DROP COLUMN IF EXISTS access_stop_requested_at;
COMMIT;
