BEGIN;

-- Roll back only after disabling the follow-up feature and removing dependent
-- account-specific Mail reads.
DROP TRIGGER IF EXISTS additional_calendar_mail_read_fence ON google_calendar_additional_accounts;
DROP FUNCTION IF EXISTS fence_additional_calendar_mail_read();
ALTER TABLE google_calendar_additional_accounts
  DROP COLUMN IF EXISTS gmail_read_generation,
  DROP COLUMN IF EXISTS gmail_read_granted_at,
  DROP COLUMN IF EXISTS gmail_read_enabled;

DROP TRIGGER IF EXISTS kai_gmail_followup_read_generation ON kai_gmail_connections;
DROP FUNCTION IF EXISTS rotate_followup_read_generation();
ALTER TABLE kai_gmail_connections DROP COLUMN IF EXISTS followup_read_generation;

COMMIT;
