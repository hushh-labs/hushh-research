BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pkm_packet_orders WHERE status IN ('paid', 'refund_pending')) THEN
    RAISE EXCEPTION 'Cannot drop pkm_packet_orders while paid or refund-pending orders exist';
  END IF;
END $$;
DROP TABLE IF EXISTS pkm_packet_orders;
COMMIT;
