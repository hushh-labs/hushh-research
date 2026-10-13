BEGIN;

CREATE INDEX IF NOT EXISTS idx_one_location_share_grants_terminal_retention
  ON one_location_share_grants (
    status,
    expires_at,
    revoked_at,
    updated_at
  );

CREATE INDEX IF NOT EXISTS idx_one_location_access_requests_terminal_retention
  ON one_location_access_requests (
    status,
    resolved_at,
    requested_at
  );

CREATE INDEX IF NOT EXISTS idx_one_location_referrals_terminal_retention
  ON one_location_referrals (
    status,
    resolved_at,
    created_at
  );

CREATE INDEX IF NOT EXISTS idx_one_location_public_invites_terminal_retention
  ON one_location_public_invites (
    status,
    expires_at,
    revoked_at,
    updated_at
  );

CREATE INDEX IF NOT EXISTS idx_one_location_public_invite_submissions_terminal_retention
  ON one_location_public_invite_submissions (
    status,
    resolved_at,
    submitted_at
  );

CREATE INDEX IF NOT EXISTS idx_one_location_events_retention_links
  ON one_location_events (
    grant_id,
    request_id,
    referral_id
  );

COMMENT ON INDEX idx_one_location_share_grants_terminal_retention IS
  'Supports One Location 12-hour terminal grant cleanup after expiry or revocation.';
COMMENT ON INDEX idx_one_location_access_requests_terminal_retention IS
  'Supports One Location terminal request cleanup after the retention window.';
COMMENT ON INDEX idx_one_location_referrals_terminal_retention IS
  'Supports One Location terminal referral cleanup after the retention window.';
COMMENT ON INDEX idx_one_location_public_invites_terminal_retention IS
  'Supports One Location terminal public request-link cleanup after expiry or revocation.';
COMMENT ON INDEX idx_one_location_public_invite_submissions_terminal_retention IS
  'Supports One Location terminal public submission cleanup after the retention window.';
COMMENT ON INDEX idx_one_location_events_retention_links IS
  'Supports One Location metadata-only event cleanup for purged workflow rows.';

COMMIT;
