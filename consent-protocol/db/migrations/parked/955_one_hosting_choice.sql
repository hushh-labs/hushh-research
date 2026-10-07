-- Dev-only: the person's explicit Shared choice, recorded in pre-vault state.
--
-- PARKED (dev-only band, same contract as 900-954): out of
-- db/release_migration_manifest.json, applied only by the dev migration lane.
--
-- Shared stops being a default (founder direction, 2026-10-06). A person with no
-- placement is `unplaced` and gets the tier chooser; they run on the hub's shared
-- runtime only after choosing Hussh Shared, and only while that choice is newer
-- than their last detach (personal_agent_hosting.shared_choice_is_current).
--
-- The choice lives on the person's pre-vault row (vault_keys), beside the other
-- non-secret setup choices (one_runtime_setup_choice, 130). It is a tier word and
-- a time, never a credential, and account deletion removes it with the row.
--
-- Idempotent under the dev lane.
BEGIN;

ALTER TABLE vault_keys
  ADD COLUMN IF NOT EXISTS one_hosting_choice TEXT;

ALTER TABLE vault_keys
  ADD COLUMN IF NOT EXISTS one_hosting_choice_at TIMESTAMPTZ;

ALTER TABLE vault_keys
  DROP CONSTRAINT IF EXISTS vault_keys_one_hosting_choice_check;

-- Only Shared is recorded here: every other tier is recorded by its own placement
-- (the registry row or the setup job). A choice always carries its time, because a
-- choice without one cannot be compared with a detach.
ALTER TABLE vault_keys
  ADD CONSTRAINT vault_keys_one_hosting_choice_check
  CHECK (
    (one_hosting_choice IS NULL AND one_hosting_choice_at IS NULL)
    OR (one_hosting_choice = 'shared' AND one_hosting_choice_at IS NOT NULL)
  );

-- Backfill: keep today's Shared owners Shared. Before this migration, choosing
-- Shared wrote only the `cloud` setup marker and recorded no choice, so without
-- this every working Shared owner would read `unplaced` and lose hub chat and
-- voice. A row is backfilled only when the person finished the cloud step, has no
-- choice yet, no placement (registry deployment target), no detach (a detach
-- sends the person back to the chooser by design) and no setup job (a begun or
-- recorded own-cloud setup is pending, never Shared). The text match on the JSON
-- array avoids a cast that a malformed legacy value would fail. Re-running it
-- finds nothing new: every match now carries a choice.
UPDATE vault_keys AS vk
SET one_hosting_choice = 'shared', one_hosting_choice_at = now()
WHERE vk.one_hosting_choice IS NULL
  AND vk.one_hosting_choice_at IS NULL
  AND position('"cloud"' IN coalesce(vk.setup_capability_ids, '')) > 0
  AND NOT EXISTS (
    SELECT 1 FROM personal_agent_registry AS r
    WHERE r.user_id = vk.user_id
      AND (
        coalesce(r.deployment_target, '') <> ''
        OR coalesce(r.backend_metadata, '{}'::jsonb) ? 'detachedPlacements'
      )
  )
  AND NOT EXISTS (SELECT 1 FROM byoc_setup_jobs AS j WHERE j.user_id = vk.user_id);

COMMENT ON COLUMN vault_keys.one_hosting_choice IS
  'Explicit non-secret hosting tier choice; only ''shared''. Absent means not chosen.';
COMMENT ON COLUMN vault_keys.one_hosting_choice_at IS
  'When the hosting choice was recorded; compared with the last placement detach.';

COMMIT;
