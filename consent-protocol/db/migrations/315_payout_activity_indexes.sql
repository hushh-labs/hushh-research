-- Read indexes for the owner payout activity and receipts (indexes only).
--
-- hashcoin_ledger_wallet_seq: one index-only scan per wallet in commit order
--   for the running balance (SUM over created_at, entry_id).
-- hashcoin_redemptions_wallet_recent: an owner's cash-outs, newest first.
-- drive_request_owner_payouts_wallet_status: a wallet's earnings by status.
-- hashcoin_redemptions_wallet_changed, drive_request_owner_payouts_wallet_changed
--   and drive_request_owner_payouts_sandbox_changed: what changed in one wallet
--   since a time (activity since=), without reading every owner's rows.
--
-- UAT replays every migration on every deploy, and CREATE INDEX IF NOT EXISTS
-- still takes a SHARE lock on these busy money tables before it finds nothing
-- to do. Each index is therefore created only when the catalog shows neither
-- its name nor a valid index with the same definition under another name.
BEGIN;

DO $$
BEGIN
  IF to_regclass('hashcoin_ledger_entries') IS NOT NULL
    AND to_regclass('hashcoin_ledger_wallet_seq') IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM pg_index i
      WHERE i.indrelid = to_regclass('hashcoin_ledger_entries')
        AND i.indisvalid AND i.indisready
        AND substring(pg_get_indexdef(i.indexrelid) FROM ' USING .*$') =
          ' USING btree (wallet_id, created_at, entry_id) INCLUDE (amount_coins, entry_kind, source_ref)'
    ) THEN
    CREATE INDEX hashcoin_ledger_wallet_seq ON hashcoin_ledger_entries
      (wallet_id, created_at, entry_id) INCLUDE (amount_coins, entry_kind, source_ref);
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('hashcoin_redemptions') IS NOT NULL
    AND to_regclass('hashcoin_redemptions_wallet_recent') IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM pg_index i
      WHERE i.indrelid = to_regclass('hashcoin_redemptions')
        AND i.indisvalid AND i.indisready
        AND substring(pg_get_indexdef(i.indexrelid) FROM ' USING .*$') =
          ' USING btree (wallet_id, created_at DESC, redemption_id DESC)'
    ) THEN
    CREATE INDEX hashcoin_redemptions_wallet_recent ON hashcoin_redemptions
      (wallet_id, created_at DESC, redemption_id DESC);
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('drive_request_owner_payouts') IS NOT NULL
    AND to_regclass('drive_request_owner_payouts_wallet_status') IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM pg_index i
      WHERE i.indrelid = to_regclass('drive_request_owner_payouts')
        AND i.indisvalid AND i.indisready
        AND substring(pg_get_indexdef(i.indexrelid) FROM ' USING .*$') =
          ' USING btree (wallet_id, status) WHERE (wallet_id IS NOT NULL)'
    ) THEN
    CREATE INDEX drive_request_owner_payouts_wallet_status ON drive_request_owner_payouts
      (wallet_id, status) WHERE wallet_id IS NOT NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('hashcoin_redemptions') IS NOT NULL
    AND to_regclass('hashcoin_redemptions_wallet_changed') IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM pg_index i
      WHERE i.indrelid = to_regclass('hashcoin_redemptions')
        AND i.indisvalid AND i.indisready
        AND substring(pg_get_indexdef(i.indexrelid) FROM ' USING .*$') =
          ' USING btree (wallet_id, updated_at)'
    ) THEN
    CREATE INDEX hashcoin_redemptions_wallet_changed ON hashcoin_redemptions
      (wallet_id, updated_at);
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('drive_request_owner_payouts') IS NOT NULL
    AND to_regclass('drive_request_owner_payouts_wallet_changed') IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM pg_index i
      WHERE i.indrelid = to_regclass('drive_request_owner_payouts')
        AND i.indisvalid AND i.indisready
        AND substring(pg_get_indexdef(i.indexrelid) FROM ' USING .*$') =
          ' USING btree (wallet_id, updated_at) WHERE (wallet_id IS NOT NULL)'
    ) THEN
    CREATE INDEX drive_request_owner_payouts_wallet_changed ON drive_request_owner_payouts
      (wallet_id, updated_at) WHERE wallet_id IS NOT NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('drive_request_owner_payouts') IS NOT NULL
    AND to_regclass('drive_request_owner_payouts_sandbox_changed') IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM pg_index i
      WHERE i.indrelid = to_regclass('drive_request_owner_payouts')
        AND i.indisvalid AND i.indisready
        AND substring(pg_get_indexdef(i.indexrelid) FROM ' USING .*$') =
          ' USING btree (sandbox_wallet_id, updated_at) WHERE (sandbox_wallet_id IS NOT NULL)'
    ) THEN
    CREATE INDEX drive_request_owner_payouts_sandbox_changed ON drive_request_owner_payouts
      (sandbox_wallet_id, updated_at) WHERE sandbox_wallet_id IS NOT NULL;
  END IF;
END $$;

COMMIT;
