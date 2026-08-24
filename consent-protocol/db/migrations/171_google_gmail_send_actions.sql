BEGIN;

-- Gmail send is a distinct, incrementally requested provider capability. It
-- never upgrades a legacy gmail.readonly connection implicitly.
ALTER TABLE google_service_grants
  DROP CONSTRAINT IF EXISTS google_service_grants_access_level_check;
ALTER TABLE google_service_grants
  ADD CONSTRAINT google_service_grants_access_level_check
  CHECK (access_level IN ('read', 'manage', 'send'));

-- The browser owns editable draft text. This table is a short-lived,
-- single-use confirmation receipt: only HMACs, counts, status and Gmail IDs
-- are retained. It is deliberately not an email/PKM cache or an outbox.
CREATE TABLE IF NOT EXISTS google_email_send_actions (
  action_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'google' CHECK (provider = 'google'),
  payload_hmac TEXT NOT NULL,
  idempotency_hmac TEXT NOT NULL,
  recipient_count SMALLINT NOT NULL CHECK (recipient_count BETWEEN 1 AND 60),
  status TEXT NOT NULL DEFAULT 'prepared'
    CHECK (status IN ('prepared', 'sending', 'sent', 'failed', 'outcome_unknown', 'expired')),
  expires_at TIMESTAMPTZ NOT NULL,
  sending_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  provider_message_id TEXT,
  provider_thread_id TEXT,
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, idempotency_hmac)
);
CREATE INDEX IF NOT EXISTS idx_google_email_send_actions_user_expiry
  ON google_email_send_actions (user_id, expires_at);

COMMENT ON TABLE google_email_send_actions IS
  'Short-lived, owner-confirmed Gmail send actions. Contains no email body, subject, addresses, OAuth token, or PKM content.';

COMMIT;
