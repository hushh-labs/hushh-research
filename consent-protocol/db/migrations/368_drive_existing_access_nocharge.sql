-- Opaque durable authority for late-money reconciliation after a retired checkout.
-- Only the server's exact-set ACL completion writes this marker; it is not paid delivery.
BEGIN;
ALTER TABLE drive_request_payment_obligations
  ADD COLUMN IF NOT EXISTS existing_access_waived_at TIMESTAMPTZ;
ALTER TABLE drive_share_requests
  ADD COLUMN IF NOT EXISTS existing_access_waived_at TIMESTAMPTZ;
ALTER TABLE drive_share_requests DROP CONSTRAINT IF EXISTS drive_share_requests_locked_quote_check;
ALTER TABLE drive_share_requests ADD CONSTRAINT drive_share_requests_locked_quote_check CHECK (
  (quoted_amount_cents IS NULL AND quote_version IS NULL) OR
  ((payment_required=TRUE OR existing_access_waived_at IS NOT NULL)
    AND quoted_amount_cents BETWEEN 50 AND 50000 AND quote_version >= 0)
) NOT VALID;
ALTER TABLE drive_share_requests VALIDATE CONSTRAINT drive_share_requests_locked_quote_check;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid='drive_share_requests'::regclass AND conname='drive_request_existing_access_waiver_check') THEN
    ALTER TABLE drive_share_requests ADD CONSTRAINT drive_request_existing_access_waiver_check
      CHECK (existing_access_waived_at IS NULL OR payment_required=FALSE);
  END IF;
END $$;
COMMIT;
