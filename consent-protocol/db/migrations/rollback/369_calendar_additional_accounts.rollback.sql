BEGIN;

-- Refuse a rollback that would silently discard a distinct authorized account.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM google_calendar_additional_accounts
             WHERE status IN ('connected', 'needs_reauth')) THEN
    RAISE EXCEPTION 'Disconnect additional Calendar accounts before rollback';
  END IF;
END $$;

DROP TABLE IF EXISTS google_calendar_additional_accounts;
ALTER TABLE google_oauth_attempts DROP COLUMN IF EXISTS calendar_additional;
ALTER TABLE google_oauth_attempts DROP COLUMN IF EXISTS calendar_account_id;

COMMIT;
