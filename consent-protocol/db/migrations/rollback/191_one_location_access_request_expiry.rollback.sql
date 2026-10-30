BEGIN;

-- The old schema cannot represent expiry. Preserve terminal safety by mapping
-- both expired questions and still-pending timed questions to cancelled rather
-- than dropping their deadline and making them approvable forever. Linked NULL
-- requests keep their parent-owned pending lifecycle.
UPDATE one_location_access_requests
SET status = 'cancelled',
    resolved_at = COALESCE(resolved_at, NOW()),
    metadata = COALESCE(metadata, '{}'::jsonb) ||
      jsonb_build_object(
        'rollback_from_status', status,
        'rollback_reason', 'request_expiry_schema_removed'
      )
WHERE status = 'expired'
   OR (status = 'pending' AND expires_at IS NOT NULL);

DROP INDEX IF EXISTS idx_one_location_access_requests_pending_expiry;

ALTER TABLE one_location_access_requests
  DROP CONSTRAINT IF EXISTS chk_one_location_access_request_expiry_after_send;

ALTER TABLE one_location_access_requests
  DROP CONSTRAINT IF EXISTS one_location_access_requests_status_check;

ALTER TABLE one_location_access_requests
  ADD CONSTRAINT one_location_access_requests_status_check CHECK (
    status IN ('pending', 'approved', 'denied', 'cancelled')
  ) NOT VALID;

ALTER TABLE one_location_access_requests
  VALIDATE CONSTRAINT one_location_access_requests_status_check;

ALTER TABLE one_location_access_requests
  DROP COLUMN IF EXISTS expires_at;

COMMIT;
