\set ON_ERROR_STOP on

-- Fail account deletion closed while migration 201 and its tombstone-aware
-- runtime cross the rolling-deploy boundary. The explicit table lock drains
-- all earlier root-table writes before these statement triggers become
-- visible. A bounded lock wait aborts the release instead of guessing that
-- deletion traffic has drained.
BEGIN;
SET LOCAL lock_timeout = '20s';
SET LOCAL statement_timeout = '90s';

LOCK TABLE public.actor_profiles, public.vault_keys
  IN SHARE ROW EXCLUSIVE MODE;

CREATE OR REPLACE FUNCTION public.block_account_deletion_during_release()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '55000',
    MESSAGE = 'account deletion is temporarily unavailable during a lifecycle release';
END;
$$;

DROP TRIGGER IF EXISTS trg_block_account_deletion_during_release
  ON public.actor_profiles;
CREATE TRIGGER trg_block_account_deletion_during_release
  BEFORE DELETE ON public.actor_profiles
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.block_account_deletion_during_release();

DROP TRIGGER IF EXISTS trg_block_account_deletion_during_release
  ON public.vault_keys;
CREATE TRIGGER trg_block_account_deletion_during_release
  BEFORE DELETE ON public.vault_keys
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.block_account_deletion_during_release();

-- Prove both trigger registrations and their fail-closed SQLSTATE before the
-- transaction commits. DELETE ... WHERE false mutates no row but still fires
-- a statement trigger, so this check is safe against live UAT information.
DO $verify$
DECLARE
  enabled_fence_count integer;
BEGIN
  SELECT count(*)
    INTO enabled_fence_count
    FROM pg_trigger trigger_state
    JOIN pg_class table_state ON table_state.oid = trigger_state.tgrelid
    JOIN pg_namespace schema_state ON schema_state.oid = table_state.relnamespace
   WHERE schema_state.nspname = 'public'
     AND table_state.relname IN ('actor_profiles', 'vault_keys')
     AND trigger_state.tgname = 'trg_block_account_deletion_during_release'
     AND trigger_state.tgenabled = 'O'
     AND NOT trigger_state.tgisinternal;

  IF enabled_fence_count <> 2 THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'account deletion release fence registration is incomplete';
  END IF;

  BEGIN
    DELETE FROM public.actor_profiles WHERE false;
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'actor_profiles account deletion release fence did not fire';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    NULL;
  END;

  BEGIN
    DELETE FROM public.vault_keys WHERE false;
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'vault_keys account deletion release fence did not fire';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    NULL;
  END;
END;
$verify$;

COMMIT;

SELECT json_build_object(
  'status', 'enabled',
  'trigger', 'trg_block_account_deletion_during_release',
  'tables', json_build_array('actor_profiles', 'vault_keys')
) AS account_deletion_release_fence;
