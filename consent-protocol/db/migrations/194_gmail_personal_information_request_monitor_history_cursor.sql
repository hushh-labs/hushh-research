-- Capture a Gmail History baseline at opt-in so this monitor processes only
-- inbox messages that arrive afterwards. The value is opaque provider metadata
-- and is never exposed to the browser.

BEGIN;

ALTER TABLE gmail_personal_information_request_preferences
  ADD COLUMN IF NOT EXISTS monitor_history_id TEXT;

COMMENT ON COLUMN gmail_personal_information_request_preferences.monitor_history_id IS
  'Gmail History API baseline captured at monitor opt-in; prevents historical inbox backfill.';

COMMIT;
