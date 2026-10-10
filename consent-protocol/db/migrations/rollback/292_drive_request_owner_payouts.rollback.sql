BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM drive_request_owner_payouts) THEN
    RAISE EXCEPTION 'Cannot remove retained Drive owner payout obligations';
  END IF;
END $$;
DROP TRIGGER IF EXISTS drive_request_owner_payout_erasure ON drive_request_payment_orders;
DROP FUNCTION IF EXISTS preserve_drive_request_owner_payout();
DROP TRIGGER IF EXISTS drive_request_owner_delivery_preserve ON drive_bulk_shares;
DROP FUNCTION IF EXISTS preserve_drive_owner_delivery_basis();
DROP TABLE IF EXISTS drive_request_owner_payouts;
ALTER TABLE drive_request_payment_refunds DROP COLUMN IF EXISTS amount_cents;
COMMIT;
