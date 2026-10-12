-- Owner Allow for a document request from outside the owner's Trusted circle.
-- The Drive owner allows one request and, when it is paid, chooses a
-- whole-dollar price from $1 to $500. The request then runs the same automatic
-- search, payment and sharing pipeline as a Trusted request. The sealed request
-- envelope holds that authority. owner_allowed_at is the plaintext Consent
-- Center projection hint: it never grants authority, and a disconnect clears it
-- to end the Allow. Trusted requests keep the 1000-cent default price.
--
-- Replay runs this file on every deploy. Each change is guarded by the
-- catalog, so a replay changes nothing and waits behind no live reader or
-- writer: it reads the catalog and takes no lock stronger than ACCESS SHARE.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute
    WHERE attrelid='drive_share_requests'::regclass
      AND attname='owner_allowed_at' AND NOT attisdropped) THEN
    ALTER TABLE drive_share_requests ADD COLUMN owner_allowed_at TIMESTAMPTZ;
    COMMENT ON COLUMN drive_share_requests.owner_allowed_at IS
      'When the owner allowed this request; a disconnect clears it, ending the Allow. Never authority on its own: the sealed request envelope holds the authority.';
  END IF;
END $$;

-- 262 declared each amount as an unnamed CHECK (amount_cents = 1000). Match
-- checks by definition, not by a generated name, ignoring the parentheses and
-- spacing PostgreSQL adds. pg_get_constraintdef also prints NOT VALID, so the
-- bounded check matches only when it is installed and validated. Tables are
-- altered in the request -> order -> obligation order the services lock in.
DO $$
DECLARE
  target TEXT;
  fixed_check NAME;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'drive_request_payment_orders','drive_request_payment_obligations'] LOOP
    FOR fixed_check IN SELECT conname FROM pg_constraint
      WHERE conrelid=target::regclass AND contype='c'
        AND regexp_replace(pg_get_constraintdef(oid),'[()[:space:]]','','g')
          ='CHECKamount_cents=1000'
      ORDER BY conname
    LOOP
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', target, fixed_check);
    END LOOP;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid='drive_request_payment_orders'::regclass AND contype='c'
      AND regexp_replace(pg_get_constraintdef(oid),'[()[:space:]]','','g')
        ='CHECKamount_cents>=100ANDamount_cents<=50000ANDamount_cents%100=0') THEN
    ALTER TABLE drive_request_payment_orders
      DROP CONSTRAINT IF EXISTS drive_request_payment_orders_amount_cents_check;
    ALTER TABLE drive_request_payment_orders
      ADD CONSTRAINT drive_request_payment_orders_amount_cents_check
      CHECK (amount_cents BETWEEN 100 AND 50000 AND amount_cents % 100 = 0);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid='drive_request_payment_obligations'::regclass AND contype='c'
      AND regexp_replace(pg_get_constraintdef(oid),'[()[:space:]]','','g')
        ='CHECKamount_cents>=100ANDamount_cents<=50000ANDamount_cents%100=0') THEN
    ALTER TABLE drive_request_payment_obligations
      DROP CONSTRAINT IF EXISTS drive_request_payment_obligations_amount_cents_check;
    ALTER TABLE drive_request_payment_obligations
      ADD CONSTRAINT drive_request_payment_obligations_amount_cents_check
      CHECK (amount_cents BETWEEN 100 AND 50000 AND amount_cents % 100 = 0);
  END IF;
END $$;

COMMIT;
