-- Application rollback retains the expanded receipt validator. It can still
-- consume previously recorded revoked items without contacting Google.
DO $$ BEGIN
 RAISE EXCEPTION 'prior Drive revocation receipts require forward recovery' USING ERRCODE='55000';
END $$;
