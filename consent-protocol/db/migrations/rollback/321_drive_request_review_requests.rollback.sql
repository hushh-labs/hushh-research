-- Rollback for 321_drive_request_review_requests.sql. Drops only the request's
-- review counters. Keeps the widened event check and Feed allowlist: delivered
-- review requests are audit history, and older code never emits the type.
BEGIN;
ALTER TABLE drive_share_requests
  DROP CONSTRAINT IF EXISTS drive_share_requests_review_request_count_check;
ALTER TABLE drive_share_requests DROP COLUMN IF EXISTS review_request_count;
ALTER TABLE drive_share_requests DROP COLUMN IF EXISTS review_requested_at;
COMMIT;
