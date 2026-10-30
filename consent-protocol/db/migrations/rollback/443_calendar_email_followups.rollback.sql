BEGIN;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM calendar_email_followup_monitors WHERE enabled)
     OR EXISTS (SELECT 1 FROM calendar_email_followup_requests WHERE state IN ('pending','snoozed')) THEN
    RAISE EXCEPTION 'Disable follow-up monitoring and resolve reminders before rollback';
  END IF;
END $$;

DROP TABLE IF EXISTS calendar_email_followup_mutations;
DROP TABLE IF EXISTS calendar_email_followup_scanned_messages;
DROP TABLE IF EXISTS calendar_email_followup_requests;
DROP TABLE IF EXISTS calendar_email_followup_conversations;
DROP TABLE IF EXISTS calendar_email_followup_monitors;

COMMIT;
