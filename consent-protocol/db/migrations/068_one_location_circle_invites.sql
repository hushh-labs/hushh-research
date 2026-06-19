BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS one_location_circle_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id TEXT NOT NULL,
  invite_code_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'claimed', 'expired', 'revoked')),
  duration_hours NUMERIC(6, 2) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  claimed_by_user_id TEXT,
  request_id UUID REFERENCES one_location_access_requests(id) ON DELETE SET NULL,
  message TEXT,
  claimed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT one_location_circle_invites_duration_bounds
    CHECK (duration_hours > 0 AND duration_hours <= 24),
  CONSTRAINT one_location_circle_invites_no_self_claim
    CHECK (claimed_by_user_id IS NULL OR claimed_by_user_id <> owner_user_id)
);

CREATE INDEX IF NOT EXISTS idx_one_location_circle_invites_owner_status_expiry
  ON one_location_circle_invites (owner_user_id, status, expires_at DESC);

CREATE INDEX IF NOT EXISTS idx_one_location_circle_invites_hash
  ON one_location_circle_invites (invite_code_hash);

CREATE INDEX IF NOT EXISTS idx_one_location_circle_invites_claimant_status
  ON one_location_circle_invites (claimed_by_user_id, status, claimed_at DESC)
  WHERE claimed_by_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_one_location_circle_invites_terminal_retention
  ON one_location_circle_invites (
    status,
    COALESCE(revoked_at, claimed_at, updated_at, expires_at, created_at)
  )
  WHERE status IN ('claimed', 'expired', 'revoked');

ALTER TABLE one_location_events
  DROP CONSTRAINT IF EXISTS one_location_events_event_type_check;

ALTER TABLE one_location_events
  ADD CONSTRAINT one_location_events_event_type_check CHECK (
    event_type IN (
      'location_recipient_key_registered',
      'location_share_created',
      'location_envelope_updated',
      'location_share_viewed',
      'location_share_revoked',
      'location_share_expired',
      'location_access_request',
      'location_access_approved',
      'location_access_denied',
      'location_referral_invite',
      'location_public_invite_created',
      'location_public_invite_revoked',
      'location_public_invite_submitted',
      'location_circle_invite_created',
      'location_circle_invite_claimed',
      'location_circle_invite_revoked'
    )
  );

COMMENT ON TABLE one_location_circle_invites IS
  'Hash-only One Location Circle invitation links. Claiming creates an owner-approval request and never grants location access directly.';

COMMIT;
