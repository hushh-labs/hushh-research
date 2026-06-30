BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS kai_location_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  tier TEXT NOT NULL CHECK (tier IN ('family', 'friend')),
  auto_approve BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  CONSTRAINT kai_location_contacts_family_auto_approve_check
    CHECK (tier = 'family' OR auto_approve = FALSE)
);

CREATE TABLE IF NOT EXISTS kai_location_latest (
  owner_user_id TEXT PRIMARY KEY,
  latitude DOUBLE PRECISION NOT NULL CHECK (latitude >= -90 AND latitude <= 90),
  longitude DOUBLE PRECISION NOT NULL CHECK (longitude >= -180 AND longitude <= 180),
  accuracy_m DOUBLE PRECISION CHECK (accuracy_m IS NULL OR accuracy_m >= 0),
  heading_deg DOUBLE PRECISION CHECK (heading_deg IS NULL OR (heading_deg >= 0 AND heading_deg <= 360)),
  speed_mps DOUBLE PRECISION CHECK (speed_mps IS NULL OR speed_mps >= 0),
  captured_at TIMESTAMPTZ NOT NULL,
  source_platform TEXT NOT NULL DEFAULT 'web'
    CHECK (source_platform IN ('web', 'ios', 'android', 'native', 'unknown')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS kai_location_shares (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id TEXT NOT NULL,
  contact_id UUID REFERENCES kai_location_contacts(id) ON DELETE SET NULL,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'expired', 'deactivated', 'revoked')),
  live_mode BOOLEAN NOT NULL DEFAULT TRUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_viewed_at TIMESTAMPTZ,
  deactivated_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS kai_location_access_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  share_id UUID NOT NULL REFERENCES kai_location_shares(id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL,
  contact_id UUID REFERENCES kai_location_contacts(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'denied', 'auto_approved')),
  requester_label TEXT,
  requester_message TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  renewed_share_id UUID REFERENCES kai_location_shares(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS kai_location_update_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id TEXT NOT NULL,
  session_token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'expired', 'revoked')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT kai_location_update_sessions_expiry_window_check
    CHECK (expires_at <= created_at + INTERVAL '24 hours' + INTERVAL '1 minute')
);

CREATE TABLE IF NOT EXISTS kai_location_events (
  id BIGSERIAL PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  contact_id UUID,
  share_id UUID,
  request_id UUID,
  event_type TEXT NOT NULL CHECK (
    event_type IN (
      'CONTACT_CREATED',
      'CONTACT_UPDATED',
      'CONTACT_REVOKED',
      'SHARE_CREATED',
      'SHARE_VIEWED',
      'SHARE_EXPIRED',
      'SHARE_DEACTIVATED',
      'SHARE_REVOKED',
      'ACCESS_REQUESTED',
      'ACCESS_APPROVED',
      'ACCESS_DENIED',
      'ACCESS_AUTO_APPROVED',
      'LOCATION_UPDATED',
      'UPDATE_SESSION_CREATED',
      'UPDATE_SESSION_REVOKED'
    )
  ),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kai_location_contacts_owner_tier_status
  ON kai_location_contacts (owner_user_id, tier, status);

CREATE INDEX IF NOT EXISTS idx_kai_location_shares_owner_status_expiry
  ON kai_location_shares (owner_user_id, status, expires_at DESC);

CREATE INDEX IF NOT EXISTS idx_kai_location_shares_contact_status
  ON kai_location_shares (contact_id, status);

CREATE INDEX IF NOT EXISTS idx_kai_location_access_requests_owner_status
  ON kai_location_access_requests (owner_user_id, status, requested_at DESC);

CREATE INDEX IF NOT EXISTS idx_kai_location_access_requests_share_status
  ON kai_location_access_requests (share_id, status);

CREATE INDEX IF NOT EXISTS idx_kai_location_update_sessions_owner_status
  ON kai_location_update_sessions (owner_user_id, status, expires_at DESC);

CREATE INDEX IF NOT EXISTS idx_kai_location_events_owner_created
  ON kai_location_events (owner_user_id, created_at DESC);

COMMENT ON TABLE kai_location_contacts IS
  'Owner-created KAI location recipients. Active limits are enforced in the service: 3 family and 7 friends.';
COMMENT ON TABLE kai_location_latest IS
  'Latest-only KAI GPS point per owner. No historical coordinate trail is retained by default.';
COMMENT ON TABLE kai_location_shares IS
  'Bearer-token KAI location shares. Only SHA-256 token hashes are stored; raw tokens are returned once.';
COMMENT ON TABLE kai_location_access_requests IS
  'Requests to renew an expired/deactivated KAI location share.';
COMMENT ON TABLE kai_location_events IS
  'KAI location audit events. Event metadata must not contain coordinates.';

COMMIT;
