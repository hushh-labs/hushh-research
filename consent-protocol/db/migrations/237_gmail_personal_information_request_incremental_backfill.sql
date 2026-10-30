-- Keep the opt-in personal Gmail KYC monitor incremental across app sessions.
-- Both fields are opaque Gmail pagination/monitor metadata; email content,
-- headers, addresses, and classifier output remain outside this table.

BEGIN;

ALTER TABLE gmail_personal_information_request_preferences
  ADD COLUMN IF NOT EXISTS initial_inbox_cursor TEXT,
  ADD COLUMN IF NOT EXISTS initial_inbox_backfill_completed_at TIMESTAMPTZ;

COMMENT ON COLUMN gmail_personal_information_request_preferences.initial_inbox_cursor IS
  'Server-only Gmail page token for resumable newest-to-oldest initial Inbox backfill.';
COMMENT ON COLUMN gmail_personal_information_request_preferences.initial_inbox_backfill_completed_at IS
  'Completion time for the current opt-in generation''s resumable initial Inbox backfill.';
COMMENT ON TABLE gmail_personal_information_request_scan_states IS
  'Metadata-only per-message KYC idempotency state. Retained until monitor opt-out or account deletion; never stores email content, headers, addresses, or classifier output.';

COMMIT;
