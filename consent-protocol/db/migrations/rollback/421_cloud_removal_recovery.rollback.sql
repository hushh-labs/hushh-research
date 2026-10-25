-- Application rollback must retain this additive authority and its evidence.
-- Disable the new capability where safe; use a reviewed forward correction.
DO $$ BEGIN
 RAISE EXCEPTION 'cloud removal recovery requires forward recovery; preserve admitted removals, cancellation and execution receipts' USING ERRCODE='55000';
END $$;
