BEGIN;

ALTER TABLE gmail_personal_information_request_preferences
  DROP COLUMN IF EXISTS initial_inbox_scan_completed_at;

COMMIT;
