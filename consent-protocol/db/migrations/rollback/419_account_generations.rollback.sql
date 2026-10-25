-- Application rollback must retain this additive authority and its evidence.
-- Disable the new capability where safe; use a reviewed forward correction.
DO $$ BEGIN
 RAISE EXCEPTION 'account generations require forward recovery; never restore a retired generation or roll back consumers after replacement activation' USING ERRCODE='55000';
END $$;
