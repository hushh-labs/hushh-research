BEGIN;

-- Stripe's smallest USD charge is $0.50. Move the advisor price floor from $1
-- to $0.50 without touching existing rows (every one already satisfies it).
--
-- The loop removes the original unnamed CHECK whatever Postgres called it, so
-- the old $1 floor can never survive beside the new one. The explicit DROP
-- before the ADD is the replay idiom every deploy relies on (the migration set
-- is re-run in full): the second run drops what the first run added.
DO $$ DECLARE existing text; BEGIN
  FOR existing IN
    SELECT conname FROM pg_constraint
    WHERE conrelid='advisor_review_payments'::regclass AND contype='c'
      AND pg_get_constraintdef(oid) LIKE '%amount_cents%'
  LOOP
    EXECUTE format('ALTER TABLE advisor_review_payments DROP CONSTRAINT %I', existing);
  END LOOP;
END $$;

ALTER TABLE advisor_review_payments
  DROP CONSTRAINT IF EXISTS advisor_review_payments_amount_cents_check;
ALTER TABLE advisor_review_payments
  ADD CONSTRAINT advisor_review_payments_amount_cents_check
  CHECK(amount_cents BETWEEN 50 AND 100000);

COMMIT;
