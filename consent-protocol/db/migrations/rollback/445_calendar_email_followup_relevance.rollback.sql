BEGIN;
DROP INDEX IF EXISTS calendar_email_followup_scanned_stale;
DROP INDEX IF EXISTS calendar_email_followup_requests_visible;
ALTER TABLE calendar_email_followup_scanned_messages
  DROP COLUMN IF EXISTS outcome,
  DROP COLUMN IF EXISTS assessment_version;
ALTER TABLE calendar_email_followup_requests
  DROP COLUMN IF EXISTS linked_event_ciphertext,
  DROP COLUMN IF EXISTS suppression_reason,
  DROP COLUMN IF EXISTS suppressed_at,
  DROP COLUMN IF EXISTS assessment_version,
  DROP COLUMN IF EXISTS meeting_state,
  DROP COLUMN IF EXISTS urgency,
  DROP COLUMN IF EXISTS category,
  DROP COLUMN IF EXISTS relevance;
ALTER TABLE calendar_email_followup_monitors DROP COLUMN IF EXISTS consecutive_failures;
COMMIT;
