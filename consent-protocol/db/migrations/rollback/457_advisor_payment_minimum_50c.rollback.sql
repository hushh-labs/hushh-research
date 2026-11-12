BEGIN;
LOCK TABLE advisor_review_payments IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM advisor_review_payments WHERE amount_cents<100) THEN
    RAISE EXCEPTION 'Retain advisor payments under $1 before restoring the $1 floor';
  END IF;
  ALTER TABLE advisor_review_payments DROP CONSTRAINT IF EXISTS advisor_review_payments_amount_cents_check;
  ALTER TABLE advisor_review_payments
    ADD CONSTRAINT advisor_review_payments_amount_cents_check
    CHECK(amount_cents BETWEEN 100 AND 100000);
END $$;
COMMIT;
