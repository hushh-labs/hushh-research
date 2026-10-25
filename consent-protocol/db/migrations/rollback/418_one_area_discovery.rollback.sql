-- Roll back callers before this additive schema. Preference removal withdraws discovery.
BEGIN;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM one_area_discovery_preferences) OR EXISTS(SELECT 1 FROM one_area_discovery_search_budgets) THEN
    RAISE EXCEPTION 'rollback_refused_nonempty_area_state';
  END IF;
END $$;
DROP TRIGGER IF EXISTS one_area_discovery_erasure ON account_deletion_tombstones;
DROP FUNCTION IF EXISTS public.erase_one_area_discovery();
DROP TABLE IF EXISTS one_area_discovery_search_budgets;
DROP TABLE IF EXISTS one_area_discovery_preferences;
COMMIT;
