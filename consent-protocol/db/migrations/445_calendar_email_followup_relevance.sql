BEGIN;

-- Calendar follow-ups gain a stored relevance verdict, so earlier
-- misclassified rows (for example security notices) can be reassessed and
-- hidden without deleting anything the owner decided, and the scanner can
-- retry recoverable failures with a bounded schedule.

ALTER TABLE calendar_email_followup_monitors
  ADD COLUMN IF NOT EXISTS consecutive_failures INTEGER NOT NULL DEFAULT 0
    CHECK (consecutive_failures >= 0);

ALTER TABLE calendar_email_followup_requests
  ADD COLUMN IF NOT EXISTS relevance TEXT NOT NULL DEFAULT 'actionable'
    CHECK (relevance IN ('actionable','informational','uncertain')),
  ADD COLUMN IF NOT EXISTS category TEXT
    CHECK (category IS NULL OR category IN ('meeting_request','schedule_change',
      'document_or_information','deliverable_deadline','response_needed','assigned_task')),
  ADD COLUMN IF NOT EXISTS urgency TEXT NOT NULL DEFAULT 'none'
    CHECK (urgency IN ('asap','time_bound','none')),
  ADD COLUMN IF NOT EXISTS meeting_state TEXT NOT NULL DEFAULT 'none'
    CHECK (meeting_state IN ('proposed','confirmed','none')),
  -- 1 = rows written before relevance existed; they are reassessed once.
  ADD COLUMN IF NOT EXISTS assessment_version SMALLINT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS suppressed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS suppression_reason TEXT,
  ADD COLUMN IF NOT EXISTS linked_event_ciphertext TEXT;

ALTER TABLE calendar_email_followup_scanned_messages
  ADD COLUMN IF NOT EXISTS assessment_version SMALLINT NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS outcome TEXT NOT NULL DEFAULT 'assessed'
    CHECK (outcome IN ('assessed','unreadable','gone'));

-- Only messages that produced a request under the old contract can have been
-- surfaced wrongly. Those are marked for one reassessment; messages that
-- produced nothing are already correct under the stricter contract and are
-- never re-read.
UPDATE calendar_email_followup_scanned_messages s
   SET assessment_version = 1
 WHERE EXISTS (
   SELECT 1 FROM calendar_email_followup_requests r
    WHERE r.user_id = s.user_id AND r.account_id = s.account_id
      AND r.source_message_hmac = s.message_hmac
      AND r.assessment_version = 1);

CREATE INDEX IF NOT EXISTS calendar_email_followup_requests_visible
  ON calendar_email_followup_requests(user_id, account_id, state)
  WHERE suppressed_at IS NULL;
CREATE INDEX IF NOT EXISTS calendar_email_followup_scanned_stale
  ON calendar_email_followup_scanned_messages(user_id, account_id, assessment_version)
  WHERE outcome = 'assessed';

SELECT install_account_deletion_write_guards();
COMMIT;
