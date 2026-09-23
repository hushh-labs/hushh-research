-- Track the approved classifier instruction revision without retaining email
-- content. A revision change may re-evaluate one newest Inbox page, then the
-- normal per-message metadata-only idempotency boundary resumes.

BEGIN;

ALTER TABLE gmail_personal_information_request_preferences
  ADD COLUMN IF NOT EXISTS classifier_policy_version SMALLINT NOT NULL DEFAULT 1;

COMMENT ON COLUMN gmail_personal_information_request_preferences.classifier_policy_version IS
  'Approved personal-information request classifier instruction revision. Used only for bounded newest-page corrective re-evaluation.';

COMMIT;
