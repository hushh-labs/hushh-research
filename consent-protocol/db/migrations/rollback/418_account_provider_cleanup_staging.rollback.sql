-- Application rollback must retain this additive authority and its evidence.
-- Disable the new capability where safe; use a reviewed forward correction.
DO $$ BEGIN
 RAISE EXCEPTION 'provider cleanup requires forward recovery; preserve encrypted retry custody and cleanup receipts' USING ERRCODE='55000';
END $$;
