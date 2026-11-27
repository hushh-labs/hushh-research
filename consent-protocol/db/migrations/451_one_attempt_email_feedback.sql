BEGIN;
ALTER TABLE one_attempt_email_preferences
  ADD COLUMN IF NOT EXISTS delivery_blocked BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE one_attempt_email_outbox
  ADD COLUMN IF NOT EXISTS rfc_message_id TEXT,
  ADD COLUMN IF NOT EXISTS bounced_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS submission_attempts SMALLINT NOT NULL DEFAULT 0 CHECK (submission_attempts BETWEEN 0 AND 3);
ALTER TABLE one_attempt_email_outbox DROP CONSTRAINT IF EXISTS one_attempt_email_rfc_bound;
ALTER TABLE one_attempt_email_outbox ADD CONSTRAINT one_attempt_email_rfc_bound
  CHECK (rfc_message_id IS NULL OR
    (provider_id IS NOT NULL AND char_length(rfc_message_id) BETWEEN 5 AND 404
      AND rfc_message_id !~ '[[:space:][:cntrl:]]'));
CREATE UNIQUE INDEX IF NOT EXISTS one_attempt_email_provider
  ON one_attempt_email_outbox(provider_id) WHERE provider_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS one_attempt_email_rfc_recipient
  ON one_attempt_email_outbox(rfc_message_id,recipient_hash) WHERE rfc_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS one_attempt_email_unbound
  ON one_attempt_email_outbox(created_at,id) WHERE provider_id IS NOT NULL AND rfc_message_id IS NULL;
CREATE INDEX IF NOT EXISTS one_attempt_email_feedback_start
  ON one_attempt_email_outbox(created_at,id) WHERE claimed_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS one_attempt_email_unknown
  ON one_attempt_email_outbox(id) WHERE status IN ('sending','uncertain') AND provider_id IS NULL;
COMMENT ON COLUMN one_attempt_email_preferences.delivery_blocked IS
  'A correlated provider hard failure holds future attempt emails, including reenrollment. Account deletion erases this state. No automatic clearing.';
COMMENT ON COLUMN one_attempt_email_outbox.rfc_message_id IS
  'Actual RFC Message-ID bound from exact provider acceptance metadata and recipient hash; requested headers alone are not proof.';
COMMIT;
