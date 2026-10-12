-- Restore the fixed 1000-cent price and remove the owner Allow projection hint.
-- Refuse while a live order or retained obligation has an owner-set price:
-- that payment must settle and be retained under the bounded check. Sealed
-- owner Allow markers stay in request envelopes. The previous release requires
-- current Trusted membership for automatic work, so those requests fail closed.
BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM drive_request_payment_orders WHERE amount_cents <> 1000)
     OR EXISTS (SELECT 1 FROM drive_request_payment_obligations WHERE amount_cents <> 1000) THEN
    RAISE EXCEPTION 'Cannot restore the fixed price while owner-priced document payments exist';
  END IF;
END $$;

ALTER TABLE drive_share_requests DROP COLUMN IF EXISTS owner_allowed_at;

DO $$
DECLARE
  target TEXT;
  bounded_check NAME;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'drive_request_payment_orders','drive_request_payment_obligations'] LOOP
    FOR bounded_check IN SELECT conname FROM pg_constraint
      WHERE conrelid=target::regclass AND contype='c'
        AND regexp_replace(pg_get_constraintdef(oid),'[()[:space:]]','','g')
          ='CHECKamount_cents>=100ANDamount_cents<=50000ANDamount_cents%100=0'
      ORDER BY conname
    LOOP
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', target, bounded_check);
    END LOOP;
  END LOOP;
END $$;

-- A concurrent owner-priced insert after the check above fails this validation
-- and aborts the whole rollback.
ALTER TABLE drive_request_payment_orders
  DROP CONSTRAINT IF EXISTS drive_request_payment_orders_amount_cents_check;
ALTER TABLE drive_request_payment_orders
  ADD CONSTRAINT drive_request_payment_orders_amount_cents_check CHECK (amount_cents = 1000);
ALTER TABLE drive_request_payment_obligations
  DROP CONSTRAINT IF EXISTS drive_request_payment_obligations_amount_cents_check;
ALTER TABLE drive_request_payment_obligations
  ADD CONSTRAINT drive_request_payment_obligations_amount_cents_check CHECK (amount_cents = 1000);

COMMIT;
