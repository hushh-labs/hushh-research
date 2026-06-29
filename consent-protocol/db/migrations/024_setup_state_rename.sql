-- Migration 024: Rename pre-vault onboarding/tour columns to unified "setup" naming
-- ============================================================================
-- Renames the pre-vault user-state columns on vault_keys from the legacy
-- "pre_onboarding_*" / "pre_nav_tour_*" / "pre_explored_*" / "pre_state_*"
-- naming to a single, scalable "setup_*" vocabulary. Setup is the umbrella for
-- both first-run capability setup AND the navigation tour, so the tour columns
-- fold into the setup namespace too.
--
-- The runner (db/migrate.py) has no version table, so this must be re-runnable.
-- Postgres lacks RENAME COLUMN IF NOT EXISTS, so each rename is guarded by a
-- DO block that only renames when the old column still exists and the new one
-- does not. Running this twice is a no-op.
--
-- Mapping:
--   pre_onboarding_completed     -> setup_completed
--   pre_onboarding_skipped       -> setup_skipped
--   pre_onboarding_completed_at  -> setup_completed_at
--   pre_nav_tour_completed_at    -> nav_setup_completed_at
--   pre_nav_tour_skipped_at      -> nav_setup_skipped_at
--   pre_explored_capability_ids  -> setup_capability_ids
--   pre_explored_updated_at      -> setup_capabilities_updated_at
--   pre_state_updated_at         -> setup_state_updated_at

BEGIN;

DO $$
DECLARE
  pairs TEXT[][] := ARRAY[
    ARRAY['pre_onboarding_completed', 'setup_completed'],
    ARRAY['pre_onboarding_skipped', 'setup_skipped'],
    ARRAY['pre_onboarding_completed_at', 'setup_completed_at'],
    ARRAY['pre_nav_tour_completed_at', 'nav_setup_completed_at'],
    ARRAY['pre_nav_tour_skipped_at', 'nav_setup_skipped_at'],
    ARRAY['pre_explored_capability_ids', 'setup_capability_ids'],
    ARRAY['pre_explored_updated_at', 'setup_capabilities_updated_at'],
    ARRAY['pre_state_updated_at', 'setup_state_updated_at']
  ];
  old_name TEXT;
  new_name TEXT;
  i INT;
BEGIN
  FOR i IN 1 .. array_length(pairs, 1) LOOP
    old_name := pairs[i][1];
    new_name := pairs[i][2];
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'vault_keys' AND column_name = old_name
    ) AND NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_name = 'vault_keys' AND column_name = new_name
    ) THEN
      EXECUTE format('ALTER TABLE vault_keys RENAME COLUMN %I TO %I', old_name, new_name);
    END IF;
  END LOOP;
END $$;

-- Backstop: if a fresh table was created with the new names and an old table
-- still lacks the new columns (neither old nor new present), add the new
-- columns idempotently so reads/writes never fail.
ALTER TABLE vault_keys
  ADD COLUMN IF NOT EXISTS setup_completed BOOLEAN,
  ADD COLUMN IF NOT EXISTS setup_skipped BOOLEAN,
  ADD COLUMN IF NOT EXISTS setup_completed_at BIGINT,
  ADD COLUMN IF NOT EXISTS nav_setup_completed_at BIGINT,
  ADD COLUMN IF NOT EXISTS nav_setup_skipped_at BIGINT,
  ADD COLUMN IF NOT EXISTS setup_capability_ids TEXT,
  ADD COLUMN IF NOT EXISTS setup_capabilities_updated_at BIGINT,
  ADD COLUMN IF NOT EXISTS setup_state_updated_at BIGINT;

COMMIT;
