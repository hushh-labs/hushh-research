BEGIN;

ALTER TABLE gmail_personal_information_request_preferences
  DROP CONSTRAINT IF EXISTS gmail_personal_information_request_preferences_generation_nonnegative,
  DROP CONSTRAINT IF EXISTS gmail_personal_information_request_preferences_message_offset_nonnegative,
  DROP COLUMN IF EXISTS monitor_message_offset,
  DROP COLUMN IF EXISTS monitoring_generation;

COMMIT;
