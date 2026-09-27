-- Roll back code first: the previous backend never reads this table. Rows are
-- evidence of what each person agreed to, so the rollback refuses to drop a
-- populated table rather than destroy that record.
BEGIN;

DO $$
DECLARE
  has_rows BOOLEAN;
BEGIN
  IF to_regclass('public.account_legal_acceptances') IS NOT NULL THEN
    EXECUTE
      'SELECT EXISTS (SELECT 1 FROM account_legal_acceptances LIMIT 1)'
      INTO has_rows;
    IF has_rows THEN
      RAISE EXCEPTION
        'migration_255_rollback_refused_nonempty_table:account_legal_acceptances';
    END IF;
  END IF;
END
$$;

DROP TABLE IF EXISTS account_legal_acceptances;

COMMIT;
