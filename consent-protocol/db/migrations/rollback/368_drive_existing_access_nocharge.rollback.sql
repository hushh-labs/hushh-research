-- Never discard retained late-payment refund authority during rollback.
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM drive_share_requests WHERE existing_access_waived_at IS NOT NULL)
    OR EXISTS (SELECT 1 FROM drive_request_payment_obligations WHERE existing_access_waived_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Existing-access waiver receipts must be preserved; roll forward';
  END IF;
END $$;
ALTER TABLE drive_share_requests DROP CONSTRAINT IF EXISTS drive_request_existing_access_waiver_check;
ALTER TABLE drive_share_requests DROP CONSTRAINT IF EXISTS drive_share_requests_locked_quote_check;
ALTER TABLE drive_share_requests ADD CONSTRAINT drive_share_requests_locked_quote_check CHECK (
  (quoted_amount_cents IS NULL AND quote_version IS NULL) OR
  (payment_required=TRUE AND quoted_amount_cents BETWEEN 50 AND 50000 AND quote_version >= 0)
) NOT VALID;
ALTER TABLE drive_share_requests VALIDATE CONSTRAINT drive_share_requests_locked_quote_check;
ALTER TABLE drive_share_requests DROP COLUMN IF EXISTS existing_access_waived_at;
ALTER TABLE drive_request_payment_obligations DROP COLUMN IF EXISTS existing_access_waived_at;
COMMIT;
