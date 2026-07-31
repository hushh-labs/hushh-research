BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Production-safe, event-scoped admission for One Location Nearby Check-In.
--
-- The event venue is a public organizer-selected place. A user's foreground
-- GPS fix remains request-memory-only and is never stored. Admission proofs are
-- signed, short-lived, one-time values; only a SHA-256 JTI digest is persisted.

CREATE TABLE IF NOT EXISTS one_location_nearby_event_pilots (
  event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name TEXT NOT NULL CHECK (char_length(display_name) BETWEEN 2 AND 120),
  venue_place_id TEXT NOT NULL CHECK (char_length(venue_place_id) BETWEEN 1 AND 300),
  venue_label TEXT NOT NULL CHECK (char_length(venue_label) BETWEEN 1 AND 300),
  venue_latitude DOUBLE PRECISION NOT NULL
    CHECK (venue_latitude BETWEEN -90 AND 90),
  venue_longitude DOUBLE PRECISION NOT NULL
    CHECK (venue_longitude BETWEEN -180 AND 180),
  radius_meters SMALLINT NOT NULL DEFAULT 500 CHECK (radius_meters = 500),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'active', 'paused', 'closed')),
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  created_by_user_id TEXT
    REFERENCES actor_profiles(user_id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_one_location_nearby_event_window CHECK (ends_at > starts_at)
);

CREATE INDEX IF NOT EXISTS idx_one_location_nearby_event_active
  ON one_location_nearby_event_pilots (status, starts_at, ends_at);

CREATE TABLE IF NOT EXISTS one_location_nearby_admission_claims (
  admission_claim_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL
    REFERENCES one_location_nearby_event_pilots(event_id) ON DELETE CASCADE,
  jti_hash CHAR(64) NOT NULL UNIQUE
    CHECK (jti_hash ~ '^[0-9a-f]{64}$'),
  expires_at TIMESTAMPTZ NOT NULL,
  claimed_by_user_id TEXT
    REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  claimed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_one_location_nearby_admission_claim
    CHECK (
      (claimed_by_user_id IS NULL AND claimed_at IS NULL)
      OR (claimed_by_user_id IS NOT NULL AND claimed_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_one_location_nearby_admission_event
  ON one_location_nearby_admission_claims (event_id, expires_at);

ALTER TABLE one_location_nearby_presences
  ADD COLUMN IF NOT EXISTS admission_mode TEXT NOT NULL DEFAULT 'uat_simulation'
    CHECK (admission_mode IN ('uat_simulation', 'event_pilot')),
  ADD COLUMN IF NOT EXISTS event_id UUID
    REFERENCES one_location_nearby_event_pilots(event_id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS admission_claim_id UUID
    REFERENCES one_location_nearby_admission_claims(admission_claim_id) ON DELETE CASCADE;

ALTER TABLE one_location_nearby_presences
  DROP CONSTRAINT IF EXISTS chk_one_location_nearby_presence_admission;

ALTER TABLE one_location_nearby_presences
  ADD CONSTRAINT chk_one_location_nearby_presence_admission
  CHECK (
    (
      admission_mode = 'uat_simulation'
      AND event_id IS NULL
      AND admission_claim_id IS NULL
    )
    OR
    (
      admission_mode = 'event_pilot'
      AND event_id IS NOT NULL
      AND admission_claim_id IS NOT NULL
    )
  );

CREATE INDEX IF NOT EXISTS idx_one_location_nearby_presence_event
  ON one_location_nearby_presences (event_id, expires_at)
  WHERE status = 'active' AND admission_mode = 'event_pilot';

CREATE TABLE IF NOT EXISTS one_location_nearby_blocks (
  blocker_user_id TEXT NOT NULL
    REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  blocked_user_id TEXT NOT NULL
    REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (blocker_user_id, blocked_user_id),
  CONSTRAINT chk_one_location_nearby_block_not_self
    CHECK (blocker_user_id <> blocked_user_id)
);

CREATE INDEX IF NOT EXISTS idx_one_location_nearby_blocks_reverse
  ON one_location_nearby_blocks (blocked_user_id, blocker_user_id);

CREATE TABLE IF NOT EXISTS one_location_nearby_reports (
  report_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_user_id TEXT NOT NULL
    REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  reported_user_id TEXT NOT NULL
    REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  event_id UUID
    REFERENCES one_location_nearby_event_pilots(event_id) ON DELETE SET NULL,
  reason_code TEXT NOT NULL
    CHECK (reason_code IN ('spam', 'harassment', 'unsafe_behavior', 'other')),
  reporter_presence_version INTEGER NOT NULL CHECK (reporter_presence_version > 0),
  reported_presence_version INTEGER NOT NULL CHECK (reported_presence_version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '90 days'),
  CONSTRAINT chk_one_location_nearby_report_not_self
    CHECK (reporter_user_id <> reported_user_id)
);

-- PostgreSQL UNIQUE constraints treat NULL values as distinct. Normalize the
-- UAT/no-event scope so retrying the same metadata-only report stays idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS uq_one_location_nearby_report_scope
  ON one_location_nearby_reports (
    reporter_user_id,
    reported_user_id,
    COALESCE(event_id, '00000000-0000-0000-0000-000000000000'::UUID)
  );

CREATE INDEX IF NOT EXISTS idx_one_location_nearby_reports_retention
  ON one_location_nearby_reports (expires_at);

CREATE TABLE IF NOT EXISTS one_location_nearby_abuse_windows (
  principal_user_id TEXT NOT NULL
    REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  action TEXT NOT NULL
    CHECK (action IN (
      'admission',
      'nearby_places',
      'check_in',
      'roster',
      'connect',
      'block',
      'report'
    )),
  window_started_at TIMESTAMPTZ NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count > 0),
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (principal_user_id, action, window_started_at)
);

CREATE INDEX IF NOT EXISTS idx_one_location_nearby_abuse_retention
  ON one_location_nearby_abuse_windows (expires_at);

CREATE TABLE IF NOT EXISTS one_location_nearby_audit_events (
  audit_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id TEXT NOT NULL
    REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  target_user_id TEXT
    REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  event_id UUID
    REFERENCES one_location_nearby_event_pilots(event_id) ON DELETE SET NULL,
  action TEXT NOT NULL
    CHECK (action IN (
      'admission_claimed',
      'checked_in',
      'checked_out',
      'expired',
      'connection_requested',
      'blocked',
      'reported'
    )),
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'rejected')),
  presence_version INTEGER CHECK (presence_version IS NULL OR presence_version > 0),
  operation_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '90 days'),
  CONSTRAINT uq_one_location_nearby_audit_operation
    UNIQUE (actor_user_id, action, operation_id)
);

CREATE INDEX IF NOT EXISTS idx_one_location_nearby_audit_retention
  ON one_location_nearby_audit_events (expires_at);

COMMENT ON TABLE one_location_nearby_event_pilots IS
  'Allowlisted event windows and public venue anchors for the One Location production Nearby Check-In pilot.';

COMMENT ON TABLE one_location_nearby_admission_claims IS
  'One-time organizer admission claims. Only SHA-256 JTI digests are stored; raw signed passes are never persisted.';

COMMENT ON TABLE one_location_nearby_blocks IS
  'Persistent bidirectional discovery suppression enforced when either user blocks the other.';

COMMENT ON TABLE one_location_nearby_reports IS
  'Metadata-only Nearby safety reports. No location, distance, place label, roster, or admission token is stored.';

COMMENT ON TABLE one_location_nearby_abuse_windows IS
  'Postgres-authoritative shared abuse counters; replaceable by a Redis adapter without changing the service contract.';

COMMENT ON TABLE one_location_nearby_audit_events IS
  'Bounded Nearby mutation audit metadata. Location, distance, aliases, place details, and admission tokens are prohibited.';

COMMIT;
