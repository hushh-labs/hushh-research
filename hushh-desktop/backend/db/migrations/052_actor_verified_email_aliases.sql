-- Migration 052: verified account email aliases
-- ================================================================
-- Stores explicit, verified user-owned email aliases for identity resolution.
-- This does not infer Apple private relay mappings; aliases must be verified
-- through an account-owned ceremony before KYC intake can match them.

BEGIN;

CREATE TABLE IF NOT EXISTS actor_verified_email_aliases (
  alias_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  email_normalized TEXT NOT NULL,
  verification_status TEXT NOT NULL DEFAULT 'pending',
  verification_source TEXT NOT NULL DEFAULT 'user_verified',
  source_ref TEXT,
  verification_code_hash TEXT,
  verification_requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  verified_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  last_matched_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT actor_verified_email_aliases_user_email_unique
    UNIQUE (user_id, email_normalized),
  CONSTRAINT actor_verified_email_aliases_status_check
    CHECK (verification_status IN ('pending', 'verified', 'revoked', 'expired')),
  CONSTRAINT actor_verified_email_aliases_source_check
    CHECK (verification_source IN ('user_verified', 'firebase_auth', 'admin_seed', 'review_seed')),
  CONSTRAINT actor_verified_email_aliases_verified_without_code_check
    CHECK (
      verification_status <> 'verified'
      OR (verified_at IS NOT NULL AND verification_code_hash IS NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_actor_verified_email_aliases_one_verified_owner
  ON actor_verified_email_aliases(email_normalized)
  WHERE verification_status = 'verified'
    AND revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_actor_verified_email_aliases_user_status
  ON actor_verified_email_aliases(user_id, verification_status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_actor_verified_email_aliases_email_status
  ON actor_verified_email_aliases(email_normalized, verification_status)
  WHERE revoked_at IS NULL;

COMMIT;
