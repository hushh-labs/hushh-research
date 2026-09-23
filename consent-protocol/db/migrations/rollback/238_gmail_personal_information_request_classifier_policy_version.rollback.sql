BEGIN;

ALTER TABLE gmail_personal_information_request_preferences
  DROP COLUMN IF EXISTS classifier_policy_version;

COMMIT;
