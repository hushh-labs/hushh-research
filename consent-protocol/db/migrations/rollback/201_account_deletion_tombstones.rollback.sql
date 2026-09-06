BEGIN;

-- Removing a live suppression row would permit a deleted Firebase UID to
-- recreate account state. Code rollback may safely leave this additive table
-- and its triggers in place; schema rollback is allowed only before first use.
-- Lock in trigger acquisition order so an actor deletion cannot create the
-- first tombstone between the emptiness check and trigger/table removal.
DO $$
BEGIN
  IF to_regclass('public.actor_profiles') IS NOT NULL THEN
    LOCK TABLE public.actor_profiles IN ACCESS EXCLUSIVE MODE;
  END IF;
  IF to_regclass('public.vault_keys') IS NOT NULL THEN
    LOCK TABLE public.vault_keys IN ACCESS EXCLUSIVE MODE;
  END IF;
  IF to_regclass('public.account_deletion_tombstones') IS NOT NULL THEN
    LOCK TABLE public.account_deletion_tombstones IN ACCESS EXCLUSIVE MODE;
  END IF;
  IF to_regclass('public.account_identity_presence') IS NOT NULL THEN
    LOCK TABLE public.account_identity_presence IN ACCESS EXCLUSIVE MODE;
  END IF;
END;
$$;

DO $$
BEGIN
  IF to_regclass('public.account_deletion_tombstones') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.account_deletion_tombstones LIMIT 1) THEN
    RAISE EXCEPTION
      'Refusing to drop non-empty account_deletion_tombstones; preserve deletion suppression';
  END IF;
END;
$$;

-- Migration 201 discovers feature-profile tables at install time, so rollback
-- must discover those trigger attachments too. Parent partition triggers own
-- their clones; dropping the parent attachment removes the child copies.
DO $$
DECLARE
  guarded_trigger RECORD;
BEGIN
  FOR guarded_trigger IN
    SELECT
      table_namespace.nspname AS schema_name,
      table_class.relname AS table_name,
      deletion_trigger.tgname AS trigger_name
    FROM pg_trigger AS deletion_trigger
    JOIN pg_class AS table_class
      ON table_class.oid = deletion_trigger.tgrelid
    JOIN pg_namespace AS table_namespace
      ON table_namespace.oid = table_class.relnamespace
    WHERE table_namespace.nspname = 'public'
      AND table_class.relname <> 'account_deletion_tombstones'
      AND NOT table_class.relispartition
      AND NOT deletion_trigger.tgisinternal
      AND deletion_trigger.tgname IN (
        'trg_reject_deleted_account_insert',
        'trg_reject_deleted_account_reference_update',
        'trg_reject_deleted_actor_profile_write',
        'trg_reject_deleted_actor_identity_write',
        'trg_reject_deleted_runtime_persona_write',
        'trg_reject_deleted_vault_write',
        'trg_reject_deleted_push_token_write'
      )
  LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS %I ON %I.%I',
      guarded_trigger.trigger_name,
      guarded_trigger.schema_name,
      guarded_trigger.table_name
    );
  END LOOP;
END;
$$;
DROP EVENT TRIGGER IF EXISTS trg_refresh_account_deletion_guards_after_identity_ddl;
DROP FUNCTION IF EXISTS public.refresh_account_deletion_guards_after_identity_ddl();
DROP TRIGGER IF EXISTS trg_record_account_deletion_tombstone ON public.actor_profiles;
DO $$
BEGIN
  IF to_regclass('public.vault_keys') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS trg_record_account_deletion_tombstone ON public.vault_keys';
  END IF;
END;
$$;
DROP FUNCTION IF EXISTS public.install_account_deletion_write_guards();
DROP FUNCTION IF EXISTS public.reject_deleted_account_identity_write();
DROP FUNCTION IF EXISTS public.record_account_deletion_tombstone();
DROP TABLE IF EXISTS public.account_deletion_tombstones;
DROP TABLE IF EXISTS public.account_identity_presence;

COMMIT;
