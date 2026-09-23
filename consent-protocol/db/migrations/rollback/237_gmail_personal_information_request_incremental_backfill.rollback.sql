BEGIN;

ALTER TABLE gmail_personal_information_request_preferences
  DROP COLUMN IF EXISTS initial_inbox_backfill_completed_at,
  DROP COLUMN IF EXISTS initial_inbox_cursor;

COMMIT;
