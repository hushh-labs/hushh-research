BEGIN;

DROP INDEX IF EXISTS idx_gmail_personal_information_requests_retention;
DROP INDEX IF EXISTS idx_gmail_personal_information_request_monitor_claims;

ALTER TABLE gmail_personal_information_requests
  DROP COLUMN IF EXISTS attachment_review_required;

ALTER TABLE gmail_personal_information_request_preferences
  DROP COLUMN IF EXISTS last_scan_completed_at,
  DROP COLUMN IF EXISTS last_scan_attempted_at,
  DROP COLUMN IF EXISTS scan_lease_expires_at,
  DROP COLUMN IF EXISTS scan_lease_id,
  DROP COLUMN IF EXISTS monitor_cursor;

COMMIT;
