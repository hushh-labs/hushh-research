BEGIN;

DO $$
DECLARE
  has_rows BOOLEAN;
BEGIN
  IF to_regclass('public.connection_voice_preferences') IS NOT NULL THEN
    EXECUTE
      'SELECT EXISTS (SELECT 1 FROM connection_voice_preferences LIMIT 1)'
      INTO has_rows;
    IF has_rows THEN
      RAISE EXCEPTION
        'migration_177_rollback_refused_nonempty_table:connection_voice_preferences';
    END IF;
  END IF;
END
$$;

DROP TABLE IF EXISTS connection_voice_preferences;

COMMIT;
