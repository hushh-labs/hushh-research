-- Roll back application code first. Preserve recorded approval and revocation
-- evidence; disable the pilot instead of dropping a populated authority table.
BEGIN;
DO $$
DECLARE has_rows BOOLEAN;
BEGIN
    IF to_regclass('one_private_text_processing_approvals') IS NOT NULL THEN
        EXECUTE 'SELECT EXISTS (SELECT 1 FROM one_private_text_processing_approvals LIMIT 1)'
            INTO has_rows;
        IF has_rows THEN
            RAISE EXCEPTION 'migration_364_rollback_refused_nonempty_table:one_private_text_processing_approvals';
        END IF;
    END IF;
END $$;
DROP TABLE IF EXISTS one_private_text_processing_approvals;
COMMIT;
