-- Rollback for 319_hashcoin_hold_tracking.sql: drops only what it added and keeps money evidence.
-- held_at is a derived display time. Payout status, review codes and every
-- ledger row stay. Roll the application back first: it reads held_at.
BEGIN;
DROP TRIGGER IF EXISTS drive_owner_payout_held_at ON drive_request_owner_payouts;
DROP FUNCTION IF EXISTS stamp_drive_owner_payout_held_at();
ALTER TABLE drive_request_owner_payouts DROP COLUMN IF EXISTS held_at;
COMMIT;
