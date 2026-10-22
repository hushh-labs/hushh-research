BEGIN;

-- The legacy provider row remains the default Google identity for older
-- Calendar, Drive and Gmail readers. Additional Calendar identities have one
-- encrypted credential and one Calendar grant each in this additive table.
CREATE TABLE IF NOT EXISTS google_calendar_additional_accounts (
  user_id TEXT NOT NULL REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  provider_subject TEXT NOT NULL,
  provider_email TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('connected', 'needs_reauth', 'disconnected')),
  scope_csv TEXT NOT NULL DEFAULT '',
  access_level TEXT NOT NULL CHECK (access_level IN ('read', 'manage')),
  refresh_token_ciphertext TEXT,
  refresh_token_iv TEXT,
  refresh_token_tag TEXT,
  access_token_ciphertext TEXT,
  access_token_iv TEXT,
  access_token_tag TEXT,
  access_token_expires_at TIMESTAMPTZ,
  connected_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, account_id),
  UNIQUE (user_id, provider_subject),
  CHECK (account_id <> 'default')
);

-- Only the owner-bound server attempt chooses whether a callback may attach
-- another Calendar identity. A callback body cannot turn a default grant into
-- an additional-account grant.
ALTER TABLE google_oauth_attempts
  ADD COLUMN IF NOT EXISTS calendar_additional BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE google_oauth_attempts
  ADD COLUMN IF NOT EXISTS calendar_account_id TEXT;

COMMENT ON TABLE google_calendar_additional_accounts IS
  'Additional owner-bound Google Calendar OAuth credentials; encrypted operational state, never PKM. The legacy provider row remains the default identity.';

SELECT install_account_deletion_write_guards();

COMMIT;
