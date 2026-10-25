-- Application rollback must retain this additive authority and its evidence.
-- Disable the new capability where safe; use a reviewed forward correction.
DO $$ BEGIN
 RAISE EXCEPTION 'private agent lifecycle requires forward recovery; preserve resource inventories, reviews and erasure authority' USING ERRCODE='55000';
END $$;
