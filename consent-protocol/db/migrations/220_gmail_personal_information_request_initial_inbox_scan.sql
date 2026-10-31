-- Record completion of the bounded first Inbox scan separately from the
-- forward-only Gmail History checkpoint. This remains metadata only.

BEGIN;

ALTER TABLE gmail_personal_information_request_preferences
  ADD COLUMN IF NOT EXISTS initial_inbox_scan_completed_at TIMESTAMPTZ;

COMMENT ON COLUMN gmail_personal_information_request_preferences.initial_inbox_scan_completed_at IS
  'Completion time for the current opt-in generation''s bounded newest-30 Inbox scan.';

COMMIT;
