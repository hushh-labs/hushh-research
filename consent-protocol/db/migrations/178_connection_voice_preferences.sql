BEGIN;

-- Whether voice-initiated connection requests may reuse a previously-used
-- scope set for the same recipient is a consent-adjacent default (it shapes
-- what the app proposes on the requester's behalf), so it is server-
-- authoritative rather than browser-only state, matching
-- one_location_auto_approve_preferences and
-- one_location_nearby_check_in_preferences. It never grants access by
-- itself -- the recipient still approves every request -- so no
-- rule_version lock is needed.
CREATE TABLE IF NOT EXISTS connection_voice_preferences (
  user_id TEXT PRIMARY KEY REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  share_scopes_from_last_request BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE connection_voice_preferences IS
  'Per-user standing default for whether voice-initiated connection requests may reuse scopes from the same recipient''s most recent request. Never grants access by itself.';

COMMIT;
