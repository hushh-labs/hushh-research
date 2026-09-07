\set ON_ERROR_STOP on

-- Activation is intentionally one transaction. If either root table cannot be
-- locked, both fences remain installed and account deletion stays fail closed.
BEGIN;
SET LOCAL lock_timeout = '20s';
SET LOCAL statement_timeout = '90s';

LOCK TABLE public.actor_profiles, public.vault_keys
  IN SHARE ROW EXCLUSIVE MODE;

DROP TRIGGER IF EXISTS trg_block_account_deletion_during_release
  ON public.actor_profiles;
DROP TRIGGER IF EXISTS trg_block_account_deletion_during_release
  ON public.vault_keys;
DROP FUNCTION IF EXISTS public.block_account_deletion_during_release();

DO $verify$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_trigger trigger_state
      JOIN pg_class table_state ON table_state.oid = trigger_state.tgrelid
      JOIN pg_namespace schema_state ON schema_state.oid = table_state.relnamespace
     WHERE schema_state.nspname = 'public'
       AND table_state.relname IN ('actor_profiles', 'vault_keys')
       AND trigger_state.tgname = 'trg_block_account_deletion_during_release'
       AND NOT trigger_state.tgisinternal
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'account deletion release fence removal is incomplete';
  END IF;
END;
$verify$;

COMMIT;

SELECT json_build_object(
  'status', 'removed',
  'trigger', 'trg_block_account_deletion_during_release',
  'tables', json_build_array('actor_profiles', 'vault_keys')
) AS account_deletion_release_fence;
