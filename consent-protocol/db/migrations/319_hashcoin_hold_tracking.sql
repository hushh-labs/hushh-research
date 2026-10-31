-- #8: when an owner earning entered review, so Payouts can say how long a hold
-- has lasted. updated_at cannot: the hourly source check bumps it.
-- Expand-only and replay-safe. UAT re-runs every migration on each deploy with
-- a short lock_timeout, so each table-locking step runs only once.
-- The stamp is a status side effect, kept out of the payout service:
--   entering 'hashcoins_held' sets held_at = clock_timestamp();
--   any other status change clears it.
-- Earnings already held get their last update time as a best-effort start.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_attribute
    WHERE attrelid='drive_request_owner_payouts'::regclass
      AND attname='held_at' AND NOT attisdropped) THEN
    ALTER TABLE drive_request_owner_payouts ADD COLUMN held_at TIMESTAMPTZ;
    COMMENT ON COLUMN drive_request_owner_payouts.held_at IS
      'When this earning entered hashcoins_held; NULL in every other status. Set by trigger drive_owner_payout_held_at.';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION stamp_drive_owner_payout_held_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status='hashcoins_held' THEN
    NEW.held_at := clock_timestamp();
  ELSE
    NEW.held_at := NULL;
  END IF;
  RETURN NEW;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
    WHERE tgname='drive_owner_payout_held_at'
      AND tgrelid='drive_request_owner_payouts'::regclass) THEN
    CREATE TRIGGER drive_owner_payout_held_at
      BEFORE UPDATE OF status ON drive_request_owner_payouts
      FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
      EXECUTE FUNCTION stamp_drive_owner_payout_held_at();
  END IF;
END $$;

-- Does not set status, so the trigger stays out of it; matches no row on replay.
UPDATE drive_request_owner_payouts SET held_at=updated_at
  WHERE status='hashcoins_held' AND held_at IS NULL;

COMMIT;
