BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM stripe_connect_bank_payouts)
    OR EXISTS (SELECT 1 FROM stripe_connect_bank_payout_events) THEN
    RAISE EXCEPTION 'Cannot remove retained Stripe Connect payout history';
  END IF;
END $$;
DROP TABLE IF EXISTS stripe_connect_bank_payout_events;
DROP TABLE IF EXISTS stripe_connect_bank_payouts;
COMMIT;
