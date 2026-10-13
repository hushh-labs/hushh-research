BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS one_location_recipient_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  public_key_jwk JSONB NOT NULL,
  public_key_fingerprint TEXT,
  algorithm TEXT NOT NULL DEFAULT 'ECDH-P256-AES256-GCM',
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'rotated', 'revoked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT one_location_recipient_keys_unique_key
    UNIQUE (user_id, key_id)
);

CREATE TABLE IF NOT EXISTS one_location_share_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id TEXT NOT NULL,
  recipient_user_id TEXT NOT NULL,
  recipient_key_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'expired', 'revoked')),
  consent_scope TEXT NOT NULL DEFAULT 'cap.location.live.view',
  capability_scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
  duration_hours NUMERIC(6, 2) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT one_location_share_grants_not_self
    CHECK (owner_user_id <> recipient_user_id),
  CONSTRAINT one_location_share_grants_duration_bounds
    CHECK (duration_hours > 0 AND duration_hours <= 24)
);

CREATE TABLE IF NOT EXISTS one_location_envelopes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_id UUID NOT NULL REFERENCES one_location_share_grants(id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL,
  recipient_user_id TEXT NOT NULL,
  recipient_key_id TEXT NOT NULL,
  algorithm TEXT NOT NULL DEFAULT 'ECDH-P256-AES256-GCM',
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  sender_ephemeral_public_key_jwk JSONB NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL,
  source_platform TEXT NOT NULL DEFAULT 'web'
    CHECK (source_platform IN ('web', 'ios', 'android', 'native', 'unknown')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

ALTER TABLE one_location_share_grants
  ADD COLUMN IF NOT EXISTS latest_envelope_id UUID
  REFERENCES one_location_envelopes(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS one_location_access_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id TEXT NOT NULL,
  requester_user_id TEXT NOT NULL,
  referred_by_user_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'denied', 'cancelled')),
  message TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  approved_grant_id UUID REFERENCES one_location_share_grants(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT one_location_access_requests_not_self
    CHECK (owner_user_id <> requester_user_id)
);

CREATE TABLE IF NOT EXISTS one_location_referrals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_id UUID NOT NULL REFERENCES one_location_share_grants(id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL,
  referring_user_id TEXT NOT NULL,
  referred_user_id TEXT NOT NULL,
  request_id UUID REFERENCES one_location_access_requests(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending_owner_approval'
    CHECK (status IN ('pending_owner_approval', 'approved', 'denied', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT one_location_referrals_no_self_referral
    CHECK (referring_user_id <> referred_user_id)
);

CREATE TABLE IF NOT EXISTS one_location_events (
  id BIGSERIAL PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  actor_user_id TEXT,
  recipient_user_id TEXT,
  grant_id UUID,
  envelope_id UUID,
  request_id UUID,
  referral_id UUID,
  event_type TEXT NOT NULL CHECK (
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
      'location_referral_invite'
    )
  ),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_one_location_recipient_keys_user_status
  ON one_location_recipient_keys (user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_one_location_share_grants_owner_status_expiry
  ON one_location_share_grants (owner_user_id, status, expires_at DESC);

CREATE INDEX IF NOT EXISTS idx_one_location_share_grants_recipient_status_expiry
  ON one_location_share_grants (recipient_user_id, status, expires_at DESC);

CREATE INDEX IF NOT EXISTS idx_one_location_envelopes_grant_created
  ON one_location_envelopes (grant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_one_location_access_requests_owner_status
  ON one_location_access_requests (owner_user_id, status, requested_at DESC);

CREATE INDEX IF NOT EXISTS idx_one_location_access_requests_requester_status
  ON one_location_access_requests (requester_user_id, status, requested_at DESC);

CREATE INDEX IF NOT EXISTS idx_one_location_referrals_owner_status
  ON one_location_referrals (owner_user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_one_location_events_owner_created
  ON one_location_events (owner_user_id, created_at DESC);

COMMENT ON TABLE one_location_recipient_keys IS
  'Recipient public key material for One Location Agent. Private keys remain on recipient devices.';
COMMENT ON TABLE one_location_share_grants IS
  'One-owned live-location grants bound to authenticated owner and recipient identities.';
COMMENT ON TABLE one_location_envelopes IS
  'Latest live-location ciphertext envelopes. Coordinates must be present only inside ciphertext.';
COMMENT ON TABLE one_location_access_requests IS
  'Metadata-only requests for owner-approved live-location access.';
COMMENT ON TABLE one_location_referrals IS
  'Metadata-only referrals. Referrals create requests and never grant access by themselves.';
COMMENT ON TABLE one_location_events IS
  'One Location Agent audit metadata. Coordinates, addresses, map previews, and movement traces are forbidden.';

COMMIT;
