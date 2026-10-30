-- Roll back code first: the previous backend never reads this table. Rows only
-- record that One reached out (no content), but they are what keeps a card or a
-- push from repeating, so the rollback refuses to drop a populated table.
BEGIN;

DO $$
DECLARE
  has_rows BOOLEAN;
BEGIN
  IF to_regclass('public.one_attention_ledger') IS NOT NULL THEN
    EXECUTE
      'SELECT EXISTS (SELECT 1 FROM one_attention_ledger LIMIT 1)'
      INTO has_rows;
    IF has_rows THEN
      RAISE EXCEPTION
        'migration_258_rollback_refused_nonempty_table:one_attention_ledger';
    END IF;
  END IF;
END
$$;

DROP TABLE IF EXISTS one_attention_ledger;

COMMIT;
