BEGIN;

-- Stripe's smallest USD charge is $0.50. Move the advisor price floor from $1
-- to $0.50 without touching existing rows (every one already satisfies it).
DO $$ DECLARE existing text; BEGIN
  FOR existing IN
    SELECT conname FROM pg_constraint
    WHERE conrelid='advisor_review_payments'::regclass AND contype='c'
      AND pg_get_constraintdef(oid) LIKE '%amount_cents%'
  LOOP
    EXECUTE format('ALTER TABLE advisor_review_payments DROP CONSTRAINT %I', existing);
  END LOOP;
  ALTER TABLE advisor_review_payments
    ADD CONSTRAINT advisor_review_payments_amount_cents_check
    CHECK(amount_cents BETWEEN 50 AND 100000);
END $$;

COMMIT;
