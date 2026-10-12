-- Rollback for 306_payout_activity_indexes.sql: drops only the three read
-- indexes it created. No rows, columns or constraints change, so every money
-- and audit record stays intact. An equivalent index that existed under
-- another name before 306 is left in place.
BEGIN;
DROP INDEX IF EXISTS hashcoin_ledger_wallet_seq;
DROP INDEX IF EXISTS hashcoin_redemptions_wallet_recent;
DROP INDEX IF EXISTS drive_request_owner_payouts_wallet_status;
COMMIT;
