-- Migration 110: server-authoritative One Email KYC preferences
-- ============================================================================
-- Automatic mailbox processing is explicit opt-in. The preference is account-
-- scoped so web, iOS, Android, and the asynchronous Gmail webhook all enforce
-- the same value. Absence of a row means disabled.

BEGIN;

CREATE TABLE IF NOT EXISTS one_email_kyc_preferences (
  user_id TEXT PRIMARY KEY REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  automatic_response_preparation_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;
