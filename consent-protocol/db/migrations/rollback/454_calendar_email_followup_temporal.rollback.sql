BEGIN;
DROP INDEX IF EXISTS calendar_email_followup_requests_primary;
DROP INDEX IF EXISTS calendar_email_followup_requests_merged;
-- The earlier category contract cannot represent a scheduled event. Hide those
-- rows instead of deleting them, then restore the narrower constraint.
UPDATE calendar_email_followup_requests
   SET suppressed_at = COALESCE(suppressed_at, NOW()),
       suppression_reason = COALESCE(suppression_reason, 'rollback_scheduled_event'),
       category = NULL
 WHERE category = 'scheduled_event';
ALTER TABLE calendar_email_followup_requests
  DROP CONSTRAINT IF EXISTS calendar_email_followup_requests_category_check;
ALTER TABLE calendar_email_followup_requests
  ADD CONSTRAINT calendar_email_followup_requests_category_check
  CHECK (category IS NULL OR category IN ('meeting_request','schedule_change',
    'document_or_information','deliverable_deadline','response_needed','assigned_task'));
ALTER TABLE calendar_email_followup_requests
  DROP COLUMN IF EXISTS merged_into,
  DROP COLUMN IF EXISTS after_date;
COMMIT;
