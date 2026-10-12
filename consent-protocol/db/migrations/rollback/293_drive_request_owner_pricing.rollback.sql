-- A custom quoted request cannot safely fall back to the old default price.
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM drive_request_owner_pricing) THEN
    RAISE EXCEPTION 'Cannot drop saved Drive request prices';
  END IF;
  IF EXISTS (SELECT 1 FROM drive_share_requests
    WHERE quoted_amount_cents IS NOT NULL AND quoted_amount_cents <> 1000) THEN
    RAISE EXCEPTION 'Cannot drop pricing while custom Drive request quotes exist';
  END IF;
END $$;
ALTER TABLE drive_share_requests
  DROP CONSTRAINT IF EXISTS drive_share_requests_locked_quote_check;
ALTER TABLE drive_share_requests DROP COLUMN IF EXISTS quote_version;
ALTER TABLE drive_share_requests DROP COLUMN IF EXISTS quoted_amount_cents;
DROP TABLE IF EXISTS drive_request_owner_pricing;
COMMIT;
