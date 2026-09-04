BEGIN;

-- Standing approval is consent authority, so it cannot live only in browser
-- storage. The server owns the activation time and monotonically increasing
-- version that every automatic approval must re-check under lock.
CREATE TABLE IF NOT EXISTS one_location_auto_approve_preferences (
  user_id TEXT PRIMARY KEY REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  scope_kind TEXT,
  circle_id UUID,
  enabled_at TIMESTAMPTZ,
  rule_version BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT one_location_auto_approve_rule_version_check
    CHECK (rule_version >= 0),
  CONSTRAINT one_location_auto_approve_scope_check
    CHECK (
      (
        NOT enabled
        AND scope_kind IS NULL
        AND circle_id IS NULL
        AND enabled_at IS NULL
      )
      OR
      (
        enabled
        AND enabled_at IS NOT NULL
        AND (
          (scope_kind = 'all_contacts' AND circle_id IS NULL)
          OR
          (scope_kind = 'circle' AND circle_id IS NOT NULL)
        )
      )
    )
);

COMMENT ON TABLE one_location_auto_approve_preferences IS
  'Server-authoritative, revocable standing rules for automatic One Location request approval. Contains no coordinates.';
COMMENT ON COLUMN one_location_auto_approve_preferences.rule_version IS
  'Increments on every enable, disable, or scope change; automatic approvals must present and lock the current version.';

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
      'location_share_shortened',
      'location_share_duration_changed',
      'location_share_expired',
      'location_access_request',
      'location_access_approved',
      'location_auto_approve_rule_changed',
      'location_access_denied',
      'location_access_request_withdrawn',
      'location_referral_invite',
      'location_public_invite_created',
      'location_public_invite_revoked',
      'location_public_invite_submitted',
      'location_circle_invite_created',
      'location_circle_invite_claimed',
      'location_circle_invite_revoked',
      'location_one_network_joined',
      -- Added by migration 180. Kept identical to 064's list; the
      -- declarations must agree.
      'location_circle_code_joined',
      'location_circle_member_invite_accepted',
      'circle_member_added'
    )
  ) NOT VALID;

COMMIT;
