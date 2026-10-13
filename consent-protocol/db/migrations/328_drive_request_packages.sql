-- Content assessment belongs to each encrypted search result, never a second index.
BEGIN;
-- Subsequent deploy replays inspect catalogs and do not wait for live writers.
DO $$ DECLARE field RECORD; BEGIN
  FOR field IN SELECT * FROM (VALUES
    ('drive_share_requests','agent_package_required','BOOLEAN NOT NULL DEFAULT FALSE'),
    ('drive_owner_search_jobs','evaluation_status',
      'TEXT NOT NULL DEFAULT ''pending'' CHECK (evaluation_status IN (''pending'',''running'',''ready'',''no_match'',''failed'',''obsolete''))'),
    ('drive_owner_search_jobs','evaluation_next_at','TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()'),
    ('drive_owner_search_jobs','evaluation_attempts',
      'INTEGER NOT NULL DEFAULT 0 CHECK (evaluation_attempts BETWEEN 0 AND 3)'),
    ('drive_owner_search_jobs','evaluation_error_code','TEXT'),
    ('drive_owner_search_results','evaluation_envelope',
      'JSONB CHECK (evaluation_envelope IS NULL OR jsonb_typeof(evaluation_envelope)=''object'')'),
    ('drive_owner_search_results','evaluated_at','TIMESTAMPTZ')
  ) AS fields(table_name,column_name,column_definition)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=field.table_name::regclass
      AND attname=field.column_name AND NOT attisdropped) THEN
      EXECUTE format('ALTER TABLE %I ADD COLUMN %I %s',field.table_name,field.column_name,field.column_definition);
    END IF;
  END LOOP;
  IF to_regclass('drive_request_package_due') IS NULL THEN
    CREATE INDEX drive_request_package_due ON drive_owner_search_jobs(evaluation_next_at,inspected_at)
      WHERE status='completed' AND evaluation_status IN ('pending','running');
  END IF;
  IF to_regclass('drive_request_package_unread') IS NULL THEN
    CREATE INDEX drive_request_package_unread ON drive_owner_search_results(job_id,position)
      WHERE evaluated_at IS NULL;
  END IF;
END $$;
COMMENT ON COLUMN drive_share_requests.agent_package_required IS
  'Non-authoritative routing hint for owner Feed. Only the encrypted request marker and exact package Allow grant authority.';
COMMIT;
