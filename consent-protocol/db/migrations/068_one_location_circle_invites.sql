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

CREATE TABLE IF NOT EXISTS one_location_network_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_a_id TEXT NOT NULL,
  user_b_id TEXT NOT NULL,
  inviter_user_id TEXT NOT NULL,
  invitee_user_id TEXT NOT NULL,
  invite_id UUID REFERENCES one_location_circle_invites(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked')),
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT one_location_network_connections_ordered_pair
    CHECK (user_a_id < user_b_id),
  CONSTRAINT one_location_network_connections_inviter_in_pair
    CHECK (inviter_user_id IN (user_a_id, user_b_id)),
  CONSTRAINT one_location_network_connections_invitee_in_pair
    CHECK (invitee_user_id IN (user_a_id, user_b_id)),
  CONSTRAINT one_location_network_connections_no_self
    CHECK (user_a_id <> user_b_id AND inviter_user_id <> invitee_user_id)
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_one_location_network_connections_pair
  ON one_location_network_connections (user_a_id, user_b_id);

CREATE INDEX IF NOT EXISTS idx_one_location_network_connections_user_a_status
  ON one_location_network_connections (user_a_id, status, connected_at DESC);

CREATE INDEX IF NOT EXISTS idx_one_location_network_connections_user_b_status
  ON one_location_network_connections (user_b_id, status, connected_at DESC);

CREATE INDEX IF NOT EXISTS idx_one_location_network_connections_invite
  ON one_location_network_connections (invite_id)
  WHERE invite_id IS NOT NULL;

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
      'location_circle_invite_revoked',
      'location_one_network_joined'
    )
  );

COMMENT ON TABLE one_location_circle_invites IS
  'Hash-only Invite to One links. Claiming creates a mutual One Network connection and never grants live location access directly.';

COMMENT ON TABLE one_location_network_connections IS
  'Metadata-only One Network connections created by accepted One Location invites. Live location grants remain explicit and encrypted.';

COMMIT;
