BEGIN;

-- Follow-ups gain what the owner's list needs to tell an expired opportunity
-- from an unresolved obligation, and to keep one obligation that several
-- emails restate. Both additions are nullable/defaulted, so the previous
-- scanner and reader keep working unchanged against the expanded schema.
--
-- after_date: what the extraction recorded about the date passing.
--   owed        the obligation stays owed after the date (an assigned document,
--               the owner's own bill)
--   lapses      the chance is gone after the date (a registration window, an
--               offer, an event that has taken place)
--   unspecified earlier rows and anything the extraction did not decide; the
--               reader never treats it as expired
-- merged_into: the request that carries the owner's decision for an obligation
--   that another email, or a later correction, restated. The merged row keeps
--   its own sealed source and is hidden from the default list.

ALTER TABLE calendar_email_followup_requests
  ADD COLUMN IF NOT EXISTS after_date TEXT NOT NULL DEFAULT 'unspecified'
    CHECK (after_date IN ('owed','lapses','unspecified')),
  ADD COLUMN IF NOT EXISTS merged_into UUID
    REFERENCES calendar_email_followup_requests(id) ON DELETE SET NULL;

-- A confirmed test or appointment is its own request, apart from the deadline
-- to register for it.
ALTER TABLE calendar_email_followup_requests
  DROP CONSTRAINT IF EXISTS calendar_email_followup_requests_category_check;
ALTER TABLE calendar_email_followup_requests
  ADD CONSTRAINT calendar_email_followup_requests_category_check
  CHECK (category IS NULL OR category IN ('meeting_request','schedule_change',
    'document_or_information','deliverable_deadline','response_needed','assigned_task',
    'scheduled_event'));

CREATE INDEX IF NOT EXISTS calendar_email_followup_requests_merged
  ON calendar_email_followup_requests(merged_into)
  WHERE merged_into IS NOT NULL;
-- The default list reads live, un-merged requests per owner and account.
CREATE INDEX IF NOT EXISTS calendar_email_followup_requests_primary
  ON calendar_email_followup_requests(user_id, account_id, conversation_id)
  WHERE suppressed_at IS NULL AND merged_into IS NULL;

SELECT install_account_deletion_write_guards();
COMMIT;
