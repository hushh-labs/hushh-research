BEGIN;

-- A Calendar credential may carry Gmail scope, but that never implies Mail
-- access for this product. Only an explicit selected-account Mail OAuth
-- callback enables this independent read grant.
ALTER TABLE google_calendar_additional_accounts
  ADD COLUMN IF NOT EXISTS gmail_read_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS gmail_read_granted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS gmail_read_generation UUID;

ALTER TABLE kai_gmail_connections
  ADD COLUMN IF NOT EXISTS followup_read_generation UUID NOT NULL DEFAULT gen_random_uuid();

CREATE OR REPLACE FUNCTION rotate_followup_read_generation() RETURNS trigger AS $$
BEGIN
  IF OLD.google_sub IS DISTINCT FROM NEW.google_sub
     OR OLD.scope_csv IS DISTINCT FROM NEW.scope_csv
     OR OLD.status IS DISTINCT FROM NEW.status
     OR OLD.revoked IS DISTINCT FROM NEW.revoked THEN
    NEW.followup_read_generation := gen_random_uuid();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path=public,pg_temp;

DROP TRIGGER IF EXISTS kai_gmail_followup_read_generation ON kai_gmail_connections;
CREATE TRIGGER kai_gmail_followup_read_generation
  BEFORE UPDATE ON kai_gmail_connections FOR EACH ROW
  EXECUTE FUNCTION rotate_followup_read_generation();

CREATE OR REPLACE FUNCTION fence_additional_calendar_mail_read() RETURNS trigger AS $$
BEGIN
  IF OLD.provider_subject IS DISTINCT FROM NEW.provider_subject
     OR OLD.status IS DISTINCT FROM NEW.status
     OR OLD.revoked_at IS DISTINCT FROM NEW.revoked_at THEN
    NEW.gmail_read_enabled := FALSE;
    NEW.gmail_read_generation := gen_random_uuid();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path=public,pg_temp;

DROP TRIGGER IF EXISTS additional_calendar_mail_read_fence ON google_calendar_additional_accounts;
CREATE TRIGGER additional_calendar_mail_read_fence
  BEFORE UPDATE ON google_calendar_additional_accounts FOR EACH ROW
  EXECUTE FUNCTION fence_additional_calendar_mail_read();

COMMENT ON COLUMN google_calendar_additional_accounts.gmail_read_enabled IS
  'Explicit Gmail read authorization for this exact additional Google Calendar account; scope alone is insufficient.';
COMMENT ON COLUMN kai_gmail_connections.followup_read_generation IS
  'Stable Gmail read epoch for account-bound follow-up monitoring; ordinary token refresh does not rotate it.';

SELECT install_account_deletion_write_guards();

COMMIT;
