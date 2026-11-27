BEGIN;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM one_attempt_email_outbox WHERE rfc_message_id IS NOT NULL OR bounced_at IS NOT NULL OR submission_attempts<>0)
    OR EXISTS(SELECT 1 FROM one_attempt_email_preferences WHERE delivery_blocked) THEN
    RAISE EXCEPTION 'rollback_refused_nonempty_attempt_email_feedback';
  END IF;
END $$;
DROP INDEX IF EXISTS one_attempt_email_unbound;
DROP INDEX IF EXISTS one_attempt_email_feedback_start;
DROP INDEX IF EXISTS one_attempt_email_unknown;
DROP INDEX IF EXISTS one_attempt_email_rfc_recipient;
DROP INDEX IF EXISTS one_attempt_email_provider;
ALTER TABLE one_attempt_email_outbox DROP CONSTRAINT IF EXISTS one_attempt_email_rfc_bound;
ALTER TABLE one_attempt_email_outbox DROP COLUMN IF EXISTS rfc_message_id, DROP COLUMN IF EXISTS bounced_at, DROP COLUMN IF EXISTS submission_attempts;
ALTER TABLE one_attempt_email_preferences DROP COLUMN IF EXISTS delivery_blocked;
COMMIT;
