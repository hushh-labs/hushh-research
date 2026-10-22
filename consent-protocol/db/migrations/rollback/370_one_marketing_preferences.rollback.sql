BEGIN;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM one_marketing_preferences) OR EXISTS(SELECT 1 FROM one_marketing_changes) THEN
    RAISE EXCEPTION 'rollback_refused_nonempty_marketing_state';
  END IF;
END $$;
DROP TRIGGER IF EXISTS one_marketing_erasure ON account_deletion_tombstones;
DROP FUNCTION IF EXISTS public.erase_one_marketing_preference();
DROP TRIGGER IF EXISTS one_marketing_change ON one_marketing_preferences;
DROP FUNCTION IF EXISTS public.record_one_marketing_change();
DROP TABLE IF EXISTS one_marketing_preferences;
DROP TABLE IF EXISTS one_marketing_changes;
COMMIT;
