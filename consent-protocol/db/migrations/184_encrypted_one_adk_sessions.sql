-- Durable AG-UI/ADK session payloads. State and events are encrypted as one
-- authenticated payload; clear columns contain routing metadata only.

BEGIN;

CREATE TABLE IF NOT EXISTS one_adk_sessions (
  app_name TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  payload_ciphertext TEXT NOT NULL,
  payload_iv TEXT NOT NULL,
  payload_tag TEXT NOT NULL,
  payload_algorithm TEXT NOT NULL DEFAULT 'aes-256-gcm',
  revision BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (app_name, user_id, session_id)
);

CREATE INDEX IF NOT EXISTS idx_one_adk_sessions_owner_updated
  ON one_adk_sessions(app_name, user_id, updated_at DESC);

COMMIT;
