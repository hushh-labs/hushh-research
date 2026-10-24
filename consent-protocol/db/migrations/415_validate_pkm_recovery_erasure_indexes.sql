DO $$
DECLARE
  expected RECORD;
BEGIN
  FOR expected IN SELECT * FROM (VALUES
    ('idx_pkm_domain_commits_archived_revision', 'pkm_domain_commits', 'archived_revision_id'),
    ('idx_pkm_upgrade_claims_archived_revision', 'pkm_upgrade_claims', 'archived_revision_id'),
    ('idx_pkm_upgrade_steps_archived_revision', 'pkm_upgrade_steps', 'last_archived_revision_id')
  ) AS required(index_name, table_name, column_name)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_index i
      JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
      JOIN pg_catalog.pg_am am ON am.oid = c.relam
      WHERE i.indexrelid = to_regclass('public.' || expected.index_name)
        AND i.indrelid = to_regclass('public.' || expected.table_name)
        AND i.indisvalid AND i.indisready AND i.indislive
        AND i.indnatts = 1 AND i.indnkeyatts = 1
        AND NOT i.indisunique AND i.indpred IS NULL
        AND am.amname = 'btree'
        AND pg_get_indexdef(i.indexrelid, 1, false) = expected.column_name
    ) THEN
      RAISE EXCEPTION 'Recovery erasure index missing, invalid or incompatible: %', expected.index_name;
    END IF;
  END LOOP;
END;
$$;
