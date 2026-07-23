BEGIN;

-- Your Map is a private view over existing recipient-scoped grants.  This
-- table stores only the owner's opt-in posture; it never stores a coordinate.
CREATE TABLE IF NOT EXISTS one_location_map_preferences (
  user_id TEXT PRIMARY KEY,
  presence_mode TEXT NOT NULL DEFAULT 'ghost',
  renderer_consent_version TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT one_location_map_preferences_presence_mode_check
    CHECK (presence_mode IN ('ghost', 'foreground_private'))
);

-- Existing and background-only envelopes must never become map-visible merely
-- because this feature is deployed.  A foreground owner explicitly opts in
-- before the client writes a foreground_map_visible envelope.
ALTER TABLE one_location_envelopes
  ADD COLUMN IF NOT EXISTS publication_context TEXT NOT NULL DEFAULT 'private_background';

ALTER TABLE one_location_envelopes
  DROP CONSTRAINT IF EXISTS one_location_envelopes_publication_context_check;

ALTER TABLE one_location_envelopes
  ADD CONSTRAINT one_location_envelopes_publication_context_check
    CHECK (publication_context IN (
      'private_background',
      'private_foreground',
      'foreground_map_visible'
    ));

COMMENT ON TABLE one_location_map_preferences IS
  'Coordinate-free owner controls for One Location Your Map. ghost is the safe default.';
COMMENT ON COLUMN one_location_envelopes.publication_context IS
  'Coordinate-free publication channel. Only foreground_map_visible can appear on Your Map.';

COMMIT;
