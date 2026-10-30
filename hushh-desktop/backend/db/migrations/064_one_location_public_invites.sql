BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS one_location_public_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id TEXT NOT NULL,
  public_code_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'expired', 'revoked')),
  duration_hours NUMERIC(6, 2) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT one_location_public_invites_duration_bounds
    CHECK (duration_hours > 0 AND duration_hours <= 24)
);

CREATE TABLE IF NOT EXISTS one_location_public_invite_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invite_id UUID NOT NULL REFERENCES one_location_public_invites(id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL,
  visitor_display_name TEXT NOT NULL,
  visitor_phone_hash TEXT NOT NULL,
  visitor_phone_last4 TEXT,
  matched_user_id TEXT,
  request_id UUID REFERENCES one_location_access_requests(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending_identity'
    CHECK (
      status IN (
        'pending_identity',
        'identity_pending_key',
        'matched_request_pending',
        'approved',
        'denied',
        'cancelled'
      )
    ),
  message TEXT,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_one_location_public_invites_owner_status_expiry
  ON one_location_public_invites (owner_user_id, status, expires_at DESC);

CREATE INDEX IF NOT EXISTS idx_one_location_public_invites_hash
  ON one_location_public_invites (public_code_hash);

CREATE INDEX IF NOT EXISTS idx_one_location_public_invite_submissions_owner_status
  ON one_location_public_invite_submissions (owner_user_id, status, submitted_at DESC);

CREATE INDEX IF NOT EXISTS idx_one_location_public_invite_submissions_invite
  ON one_location_public_invite_submissions (invite_id, submitted_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_one_location_public_invite_submissions_phone_once
  ON one_location_public_invite_submissions (invite_id, visitor_phone_hash);

CREATE INDEX IF NOT EXISTS idx_one_location_public_invite_submissions_fingerprint_window
  ON one_location_public_invite_submissions (
    invite_id,
    (metadata->>'submitter_fingerprint_hash'),
    submitted_at DESC
  );

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
      'location_public_invite_submitted'
    )
  );

COMMENT ON TABLE one_location_public_invites IS
  'Shareable public request links for One Location Agent. Tokens are hash-only and never grant location access.';
COMMENT ON TABLE one_location_public_invite_submissions IS
  'Metadata-only public request submissions. Public viewers never receive coordinates or encrypted envelopes from this path.';

COMMIT;
