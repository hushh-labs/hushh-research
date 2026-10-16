-- New V1 requests may carry a bounded access period; existing grants stay unchanged.
BEGIN;
ALTER TABLE drive_share_requests
  ADD COLUMN IF NOT EXISTS requested_access_days INTEGER,
  ADD COLUMN IF NOT EXISTS approved_access_days INTEGER,
  ADD COLUMN IF NOT EXISTS access_expires_at TIMESTAMPTZ;
ALTER TABLE drive_share_requests DROP CONSTRAINT IF EXISTS drive_request_access_period_valid;
ALTER TABLE drive_share_requests ADD CONSTRAINT drive_request_access_period_valid CHECK (
  (requested_access_days IS NULL AND approved_access_days IS NULL AND access_expires_at IS NULL)
  OR (v1_live_request AND requested_access_days IS NOT NULL AND requested_access_days BETWEEN 1 AND 90
      AND (approved_access_days IS NULL OR approved_access_days BETWEEN 1 AND requested_access_days)
      AND (access_expires_at IS NULL OR approved_access_days IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS drive_request_access_expiry_due
  ON drive_share_requests(access_expires_at,request_id)
  WHERE access_expires_at IS NOT NULL AND access_stop_requested_at IS NULL;
COMMENT ON COLUMN drive_share_requests.access_expires_at IS
  'Fixed at first paid grant dispatch; each created Google Viewer permission receives this native expiry.';
COMMIT;
