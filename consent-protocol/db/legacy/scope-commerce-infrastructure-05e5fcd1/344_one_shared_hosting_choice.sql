-- Release-only first-run support for the existing explicit Shared choice.
-- Pod placement stores remain parked; no backfill or default chooses for owners.
-- 285/286 are reserved by main's independent release history; never replay or
-- relabel that divergent history when upgrading the pinned Sandbox baseline.
BEGIN;

ALTER TABLE public.vault_keys
  ADD COLUMN IF NOT EXISTS one_hosting_choice TEXT,
  ADD COLUMN IF NOT EXISTS one_hosting_choice_at TIMESTAMPTZ;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.vault_keys'::regclass
      AND conname = 'vault_keys_one_shared_choice_pair_check'
  ) THEN
    ALTER TABLE public.vault_keys
      ADD CONSTRAINT vault_keys_one_shared_choice_pair_check CHECK (
        (one_hosting_choice IS NULL AND one_hosting_choice_at IS NULL)
        OR (one_hosting_choice IS NOT NULL AND one_hosting_choice = 'shared'
            AND one_hosting_choice_at IS NOT NULL)
      );
  END IF;
END $$;

COMMENT ON COLUMN public.vault_keys.one_hosting_choice IS
  'Explicit non-secret hosting tier choice; only shared. Absent means not chosen.';
COMMENT ON COLUMN public.vault_keys.one_hosting_choice_at IS
  'Server-recorded choice time; compared with the last placement detach.';
COMMIT;
