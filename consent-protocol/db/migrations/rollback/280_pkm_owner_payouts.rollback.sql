BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pkm_packet_orders WHERE owner_earning_status IN ('due', 'transferred')) THEN
    RAISE EXCEPTION 'Cannot remove payouts while owner earnings are due or recorded';
  END IF;
END $$;
DROP INDEX IF EXISTS idx_pkm_packet_orders_earning_due;
ALTER TABLE pkm_packet_orders DROP CONSTRAINT IF EXISTS pkm_packet_orders_owner_earning_status;
ALTER TABLE pkm_packet_orders DROP COLUMN IF EXISTS transferred_at;
ALTER TABLE pkm_packet_orders DROP COLUMN IF EXISTS stripe_transfer_id;
ALTER TABLE pkm_packet_orders DROP COLUMN IF EXISTS owner_earning_status;
DROP TABLE IF EXISTS pkm_owner_payout_accounts;
COMMIT;
