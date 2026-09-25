-- The asker withdrew these questions. Relabelling them 'denied' would wrongly
-- attribute the decision to the owner, so they are removed instead.
BEGIN;

DELETE FROM drive_live_query_requests WHERE status = 'cancelled';

ALTER TABLE drive_live_query_requests
  DROP CONSTRAINT IF EXISTS drive_live_query_requests_status_check;

ALTER TABLE drive_live_query_requests
  ADD CONSTRAINT drive_live_query_requests_status_check
  CHECK (status IN ('pending','running','answered','denied')) NOT VALID;

ALTER TABLE drive_live_query_requests
  VALIDATE CONSTRAINT drive_live_query_requests_status_check;

COMMIT;
