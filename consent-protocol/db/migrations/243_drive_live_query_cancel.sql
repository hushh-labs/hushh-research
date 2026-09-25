-- The asker can withdraw a Drive question. 'cancelled' is terminal: it sets
-- decided_at, carries no answer, and nothing reads Drive for it. The bumped
-- revision plus the terminal status fence a running Allow, so a withdrawn
-- question never stores an answer. No new column, index, table or grant.
-- Replay-safe: every deploy re-runs this file.
BEGIN;

ALTER TABLE drive_live_query_requests
  DROP CONSTRAINT IF EXISTS drive_live_query_requests_status_check;

ALTER TABLE drive_live_query_requests
  ADD CONSTRAINT drive_live_query_requests_status_check
  CHECK (status IN ('pending','running','answered','denied','cancelled')) NOT VALID;

ALTER TABLE drive_live_query_requests
  VALIDATE CONSTRAINT drive_live_query_requests_status_check;

COMMIT;
