BEGIN;
DROP INDEX IF EXISTS drive_bulk_origin_request_unique;
ALTER TABLE drive_bulk_shares
  DROP CONSTRAINT IF EXISTS drive_bulk_origin_request_revision_check,
  DROP CONSTRAINT IF EXISTS drive_bulk_origin_request_fk,
  DROP COLUMN IF EXISTS origin_request_revision,
  DROP COLUMN IF EXISTS origin_request_id;
ALTER TABLE drive_share_requests DROP COLUMN IF EXISTS bulk_search_started_at;
ALTER TABLE drive_owner_search_jobs DROP COLUMN IF EXISTS unshareable_count;
COMMIT;
