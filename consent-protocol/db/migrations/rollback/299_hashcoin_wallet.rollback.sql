-- Forward-compatible rollback only. Disable DRIVE_REQUEST_HASHCOINS_ENABLED;
-- retain balances, entries, mode fences and transfer guards until liabilities
-- are settled. Old workers cannot dispatch Hashcoin earnings as Stripe payouts.
BEGIN;
COMMENT ON TABLE hashcoin_wallets IS 'Hashcoin enrollment rolled back; financial liabilities and sandbox isolation retained.';
COMMIT;
