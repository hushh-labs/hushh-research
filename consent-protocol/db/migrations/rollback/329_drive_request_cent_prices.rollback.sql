-- App rollback is compatible with existing whole-dollar records. Refuse to
-- strand legitimate cent-denominated money: never round or rewrite an order.
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM drive_request_payment_orders WHERE amount_cents<100 OR amount_cents%100<>0)
    OR EXISTS (SELECT 1 FROM drive_request_payment_obligations WHERE amount_cents<100 OR amount_cents%100<>0)
    OR EXISTS (SELECT 1 FROM drive_request_owner_payouts WHERE gross_amount_cents<100 OR gross_amount_cents%100<>0)
    OR EXISTS (SELECT 1 FROM drive_request_owner_pricing WHERE amount_cents<100 OR amount_cents%100<>0)
    OR EXISTS (SELECT 1 FROM drive_share_requests WHERE quoted_amount_cents<100 OR quoted_amount_cents%100<>0 OR initial_quote_cents<100 OR initial_quote_cents%100<>0) THEN
    RAISE EXCEPTION 'Cent-denominated prices exist; retain the compatible price contract during rollback';
  END IF;
END $$;
ALTER TABLE drive_request_payment_orders DROP CONSTRAINT drive_request_payment_orders_amount_cents_check;
ALTER TABLE drive_request_payment_orders ADD CONSTRAINT drive_request_payment_orders_amount_cents_check CHECK (amount_cents BETWEEN 100 AND 50000 AND amount_cents%100=0);
ALTER TABLE drive_request_payment_obligations DROP CONSTRAINT drive_request_payment_obligations_amount_cents_check;
ALTER TABLE drive_request_payment_obligations ADD CONSTRAINT drive_request_payment_obligations_amount_cents_check CHECK (amount_cents BETWEEN 100 AND 50000 AND amount_cents%100=0);
ALTER TABLE drive_request_owner_payouts DROP CONSTRAINT drive_request_owner_payouts_gross_amount_cents_check;
ALTER TABLE drive_request_owner_payouts ADD CONSTRAINT drive_request_owner_payouts_gross_amount_cents_check CHECK (gross_amount_cents BETWEEN 100 AND 50000);
ALTER TABLE drive_request_owner_pricing DROP CONSTRAINT drive_request_owner_pricing_amount_cents_check;
ALTER TABLE drive_request_owner_pricing ADD CONSTRAINT drive_request_owner_pricing_amount_cents_check CHECK (amount_cents BETWEEN 100 AND 50000 AND amount_cents%100=0);
ALTER TABLE drive_share_requests DROP CONSTRAINT drive_share_requests_locked_quote_check;
ALTER TABLE drive_share_requests ADD CONSTRAINT drive_share_requests_locked_quote_check CHECK ((quoted_amount_cents IS NULL AND quote_version IS NULL) OR (payment_required=TRUE AND quoted_amount_cents BETWEEN 100 AND 50000 AND quoted_amount_cents%100=0 AND quote_version>=0));
ALTER TABLE drive_share_requests DROP CONSTRAINT drive_share_requests_initial_quote_check;
ALTER TABLE drive_share_requests ADD CONSTRAINT drive_share_requests_initial_quote_check CHECK (initial_quote_cents IS NULL OR (initial_quote_cents BETWEEN 100 AND 50000 AND initial_quote_cents%100=0));
COMMIT;
