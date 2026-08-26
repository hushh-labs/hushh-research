BEGIN;

-- Nearby check-in's visibility and connection-request defaults are standing
-- consent-adjacent choices (who can see you checked in, who can ask to
-- connect), so -- like one_location_auto_approve_preferences -- they are
-- server-authoritative rather than browser-only state. Unlike auto-approve,
-- nothing executes automatically off this row; it only pre-fills a value the
-- person still confirms on every check-in, so no rule_version lock is needed.
CREATE TABLE IF NOT EXISTS one_location_nearby_check_in_preferences (
  user_id TEXT PRIMARY KEY REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  visible BOOLEAN NOT NULL DEFAULT TRUE,
  allow_connection_requests BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE one_location_nearby_check_in_preferences IS
  'Per-user standing defaults for Nearby Check-In visibility and connection-request eligibility. Pre-fills each check-in; contains no coordinates.';

COMMIT;
