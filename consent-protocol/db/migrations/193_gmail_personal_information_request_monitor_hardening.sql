-- Harden the opted-in personal Gmail monitor without storing Gmail content,
-- addresses, PKM values, or draft bodies. Cursor and lease values are opaque
-- provider/work coordination metadata only.

BEGIN;

ALTER TABLE gmail_personal_information_request_preferences
  ADD COLUMN IF NOT EXISTS monitor_cursor TEXT,
  ADD COLUMN IF NOT EXISTS scan_lease_id UUID,
  ADD COLUMN IF NOT EXISTS scan_lease_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_scan_attempted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_scan_completed_at TIMESTAMPTZ;

ALTER TABLE gmail_personal_information_requests
  ADD COLUMN IF NOT EXISTS attachment_review_required BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_gmail_personal_information_request_monitor_claims
  ON gmail_personal_information_request_preferences (
    monitoring_enabled,
    last_scan_attempted_at ASC,
    scan_lease_expires_at ASC
  );

CREATE INDEX IF NOT EXISTS idx_gmail_personal_information_requests_retention
  ON gmail_personal_information_requests (updated_at);

COMMENT ON COLUMN gmail_personal_information_request_preferences.monitor_cursor IS
  'Opaque Gmail History API page token used only by the background monitor; never browser-visible.';
COMMENT ON COLUMN gmail_personal_information_request_preferences.scan_lease_id IS
  'Short-lived Postgres coordination lease for one monitor run; Redis-compatible seam.';
COMMENT ON COLUMN gmail_personal_information_requests.attachment_review_required IS
  'True only when the source message has attachments; attachment content is never read or retained.';

COMMIT;
