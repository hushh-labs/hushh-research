BEGIN;

-- Provider credentials are encrypted operational state, not PKM. A single
-- Google account may grant several independently-managed services. Keeping
-- grants separate makes disconnecting Calendar possible without taking Gmail
-- receipts offline. A Redis-backed job/outbox can replace the bounded proposal
-- workflow later without changing this provider/service contract.
CREATE TABLE IF NOT EXISTS google_provider_connections (
  user_id TEXT NOT NULL REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider = 'google'),
  provider_subject TEXT,
  provider_email TEXT,
  status TEXT NOT NULL DEFAULT 'connected'
    CHECK (status IN ('connected', 'needs_reauth', 'disconnected')),
  refresh_token_ciphertext TEXT,
  refresh_token_iv TEXT,
  refresh_token_tag TEXT,
  access_token_ciphertext TEXT,
  access_token_iv TEXT,
  access_token_tag TEXT,
  token_key_version SMALLINT NOT NULL DEFAULT 1,
  access_token_expires_at TIMESTAMPTZ,
  connected_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, provider)
);

CREATE TABLE IF NOT EXISTS google_service_grants (
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'google' CHECK (provider = 'google'),
  service TEXT NOT NULL CHECK (service IN ('gmail', 'calendar', 'drive', 'contacts')),
  status TEXT NOT NULL DEFAULT 'connected'
    CHECK (status IN ('connected', 'needs_reauth', 'disconnected')),
  scope_csv TEXT NOT NULL DEFAULT '',
  access_level TEXT NOT NULL DEFAULT 'read'
    CHECK (access_level IN ('read', 'manage')),
  last_used_at TIMESTAMPTZ,
  disconnected_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, provider, service),
  FOREIGN KEY (user_id, provider)
    REFERENCES google_provider_connections(user_id, provider) ON DELETE CASCADE
);

-- State is opaque to the browser and one-time on the server. The verifier is
-- encrypted at rest, which lets the callback use PKCE without carrying a raw
-- verifier in a URL or browser storage.
CREATE TABLE IF NOT EXISTS google_oauth_attempts (
  attempt_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  service TEXT NOT NULL CHECK (service IN ('gmail', 'calendar', 'drive', 'contacts')),
  redirect_uri TEXT NOT NULL,
  requested_scope_csv TEXT NOT NULL,
  state_digest TEXT NOT NULL,
  verifier_ciphertext TEXT NOT NULL,
  verifier_iv TEXT NOT NULL,
  verifier_tag TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_google_oauth_attempts_expiry
  ON google_oauth_attempts (expires_at);

-- Calendar mutation plans are intentionally short-lived and contain no token
-- material. They are deleted on account deletion with their actor profile.
CREATE TABLE IF NOT EXISTS google_calendar_action_proposals (
  proposal_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('create', 'reschedule', 'cancel')),
  payload_json JSONB NOT NULL,
  expected_event_etag TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'executing', 'executed', 'expired', 'failed')),
  expires_at TIMESTAMPTZ NOT NULL,
  executed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_google_calendar_proposals_user_expiry
  ON google_calendar_action_proposals (user_id, expires_at);

COMMENT ON TABLE google_provider_connections IS
  'Encrypted Google OAuth credential envelope. Operational provider state only; no PKM or provider content.';
COMMENT ON TABLE google_service_grants IS
  'Per-Google-service grant, permission level, and local revoke state.';
COMMENT ON TABLE google_calendar_action_proposals IS
  'Short-lived, confirmation-bound Calendar mutation proposals; event content is never copied to PKM.';

COMMIT;
