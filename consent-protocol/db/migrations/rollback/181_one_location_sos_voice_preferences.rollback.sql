BEGIN;

DO $$
DECLARE
  has_rows BOOLEAN;
BEGIN
  IF to_regclass('public.one_location_sos_voice_preferences') IS NOT NULL THEN
    EXECUTE
      'SELECT EXISTS (SELECT 1 FROM one_location_sos_voice_preferences LIMIT 1)'
      INTO has_rows;
    IF has_rows THEN
      RAISE EXCEPTION
        'migration_181_rollback_refused_nonempty_table:one_location_sos_voice_preferences';
    END IF;
  END IF;
END
$$;

DROP TABLE IF EXISTS one_location_sos_voice_preferences;

COMMIT;
