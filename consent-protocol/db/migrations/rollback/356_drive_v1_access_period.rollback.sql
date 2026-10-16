-- Native Google permission expiry remains effective even if application schema rolls back.
BEGIN;
DROP INDEX IF EXISTS drive_request_access_expiry_due;
ALTER TABLE drive_share_requests DROP CONSTRAINT IF EXISTS drive_request_access_period_valid;
ALTER TABLE drive_share_requests DROP COLUMN IF EXISTS access_expires_at,
  DROP COLUMN IF EXISTS approved_access_days, DROP COLUMN IF EXISTS requested_access_days;
COMMIT;
