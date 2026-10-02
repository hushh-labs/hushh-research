BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pkm_credit_subscriptions WHERE status IN ('active', 'past_due'))
     OR EXISTS (SELECT 1 FROM pkm_credit_subscription_cancellations)
     OR EXISTS (SELECT 1 FROM pkm_packet_orders WHERE payment_method = 'credits'
                AND status IN ('paid', 'refund_pending')) THEN
    RAISE EXCEPTION 'Cannot remove credits while subscriptions or credit-paid orders are unsettled';
  END IF;
END $$;
DROP FUNCTION IF EXISTS pkm_spend_credits(TEXT, INTEGER, TEXT);
DROP FUNCTION IF EXISTS pkm_grant_credits(TEXT, INTEGER, TEXT);
ALTER TABLE pkm_packet_orders DROP CONSTRAINT IF EXISTS pkm_packet_orders_payment_method;
ALTER TABLE pkm_packet_orders DROP COLUMN IF EXISTS credits_spent;
ALTER TABLE pkm_packet_orders DROP COLUMN IF EXISTS payment_method;
DROP TABLE IF EXISTS pkm_credit_subscription_cancellations;
DROP TABLE IF EXISTS pkm_credit_ledger;
DROP TABLE IF EXISTS pkm_credit_subscriptions;
COMMIT;
