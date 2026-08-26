BEGIN;

-- Whether a bare, ambiguous emergency phrase ("save me", "turn on sos") opens
-- the SOS screen or goes straight to the send-alert confirm card is a
-- standing, consent-adjacent default -- like one_location_auto_approve_preferences
-- and one_location_nearby_check_in_preferences, it is server-authoritative
-- rather than browser-only state, since a phone with a fresh browser session
-- must not lose this choice during a real emergency. It never sends an alert
-- by itself: "trigger" still lands on trigger_sos's own mandatory, unconditional
-- confirm card, so no rule_version lock is needed.
CREATE TABLE IF NOT EXISTS one_location_sos_voice_preferences (
  user_id TEXT PRIMARY KEY REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  default_action TEXT NOT NULL DEFAULT 'open' CHECK (default_action IN ('open', 'trigger')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE one_location_sos_voice_preferences IS
  'Per-user standing default for what a bare emergency voice phrase does: open the SOS screen, or go straight to the send-alert confirm card. Never sends an alert by itself.';

COMMIT;
