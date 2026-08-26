-- Operational rollback for migration 172.
--
-- Normal rollback disables the UAT cohort and leaves these additive tables in
-- place. This down path is intentionally limited to empty environments so it
-- cannot erase mappings, audit evidence, or synthetic reconciliation state.

BEGIN;

DO $$
DECLARE
  table_name TEXT;
  has_rows BOOLEAN;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'hushh_tech_launch_authorizations',
    'hushh_tech_account_links',
    'hushh_tech_link_events',
    'hushh_tech_shadow_records',
    'hushh_tech_migration_runs',
    'hushh_tech_migration_events'
  ]
  LOOP
    IF to_regclass('public.' || table_name) IS NOT NULL THEN
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I LIMIT 1)', table_name)
        INTO has_rows;
      IF has_rows THEN
        RAISE EXCEPTION
          'migration_170_rollback_refused_nonempty_table:%', table_name;
      END IF;
    END IF;
  END LOOP;
END
$$;

DROP TABLE IF EXISTS hushh_tech_link_events;
DROP TABLE IF EXISTS hushh_tech_account_links;
DROP TABLE IF EXISTS hushh_tech_launch_authorizations;
DROP TABLE IF EXISTS hushh_tech_shadow_records;
DROP TABLE IF EXISTS hushh_tech_migration_events;
DROP TABLE IF EXISTS hushh_tech_migration_runs;
DROP FUNCTION IF EXISTS hushh_tech_link_events_enforce_append_only();
DROP FUNCTION IF EXISTS hushh_tech_migration_events_enforce_append_only();

COMMIT;
