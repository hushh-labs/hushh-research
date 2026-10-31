-- Keep the expanded validator and approved retention receipts on application rollback.
DO $$ BEGIN
 RAISE EXCEPTION 'shared provider authority requires forward recovery; preserve reviewed cleanup receipts' USING ERRCODE='55000';
END $$;
