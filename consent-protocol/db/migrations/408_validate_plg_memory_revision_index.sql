BEGIN;

-- Parse the expected definition on this PostgreSQL version, without touching
-- live rows. Inherit the indexed columns' installed types and collations without
-- creating a new persistent identity shape or copying rows, guards or indexes.
-- Comparing only the name or indisvalid would accept a wrong index.
CREATE TEMPORARY TABLE plg_memory_index_contract (
  LIKE public.pkm_events
) ON COMMIT DROP;
CREATE INDEX plg_memory_expected_index
  ON plg_memory_index_contract (user_id, domain, (metadata->>'data_version'))
  WHERE operation_type = 'content_write'
    AND metadata->'provenance'->>'authorization_mode' = 'owner_confirmed'
    AND NULLIF(BTRIM(metadata->'provenance'->>'mutation_plan_id'), '') IS NOT NULL
    AND NULLIF(BTRIM(metadata->'provenance'->>'confirmation_receipt_id'), '') IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_index actual
    JOIN pg_catalog.pg_class relation ON relation.oid = actual.indexrelid
    JOIN pg_catalog.pg_am method ON method.oid = relation.relam
    CROSS JOIN pg_catalog.pg_index expected
    WHERE actual.indexrelid = to_regclass('public.idx_pkm_events_plg_memory_revision')
      AND actual.indrelid = 'public.pkm_events'::regclass
      AND expected.indexrelid = 'pg_temp.plg_memory_expected_index'::regclass
      AND method.amname = 'btree' AND relation.relkind = 'i'
      AND actual.indisvalid AND actual.indisready AND actual.indislive
      AND NOT actual.indisunique AND NOT actual.indisexclusion
      AND actual.indnkeyatts = 3 AND actual.indnatts = 3
      AND actual.indclass = expected.indclass
      AND actual.indcollation = expected.indcollation
      AND actual.indoption = expected.indoption
      AND pg_get_indexdef(actual.indexrelid, 1, false) = pg_get_indexdef(expected.indexrelid, 1, false)
      AND pg_get_indexdef(actual.indexrelid, 2, false) = pg_get_indexdef(expected.indexrelid, 2, false)
      AND pg_get_indexdef(actual.indexrelid, 3, false) = pg_get_indexdef(expected.indexrelid, 3, false)
      AND pg_get_expr(actual.indpred, actual.indrelid, false)
        = pg_get_expr(expected.indpred, expected.indrelid, false)
  ) THEN
    RAISE EXCEPTION 'PLG Memory index missing, invalid or incompatible; inspect and rebuild migration 407 before retrying 408';
  END IF;
END;
$$;
COMMIT;
