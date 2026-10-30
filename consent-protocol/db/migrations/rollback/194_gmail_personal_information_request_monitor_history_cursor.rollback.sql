BEGIN;

ALTER TABLE gmail_personal_information_request_preferences
  DROP COLUMN IF EXISTS monitor_history_id;

COMMIT;
