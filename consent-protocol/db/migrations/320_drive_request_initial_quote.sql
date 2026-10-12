-- #19: the estimate a requester saw when sending, kept apart from the owner's
-- price. create_request writes it once; nothing updates it. quoted_amount_cents
-- keeps its meaning: the owner's current price, which an owner's Allow may
-- change until an order freezes it. NULL means unknown (no backfill: an
-- earlier Allow may already have replaced the price that was shown).
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute
    WHERE attrelid='drive_share_requests'::regclass
      AND attname='initial_quote_cents' AND NOT attisdropped) THEN
    ALTER TABLE drive_share_requests ADD COLUMN initial_quote_cents INTEGER;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid='drive_share_requests'::regclass
      AND conname='drive_share_requests_initial_quote_check') THEN
    ALTER TABLE drive_share_requests
      ADD CONSTRAINT drive_share_requests_initial_quote_check CHECK (
        initial_quote_cents IS NULL OR (initial_quote_cents BETWEEN 100 AND 50000
          AND initial_quote_cents % 100 = 0)
      ) NOT VALID;
  END IF;
END $$;

COMMENT ON COLUMN drive_share_requests.quoted_amount_cents IS
  'Current owner price; immutable once an order exists. NULL for legacy/free requests.';
COMMENT ON COLUMN drive_share_requests.initial_quote_cents IS
  'Estimate the requester saw when sending; written once at creation. NULL when unknown.';

COMMIT;
