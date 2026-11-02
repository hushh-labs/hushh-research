BEGIN;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM advisor_review_subscriptions WHERE status NOT IN ('cancelled'))
    OR EXISTS(SELECT 1 FROM advisor_billing_cleanup WHERE completed_at IS NULL) THEN
    RAISE EXCEPTION 'Cancel and reconcile advisor subscriptions before rollback';
  END IF;
END $$;
DROP TRIGGER IF EXISTS advisor_connection_ended ON connections;
DROP TRIGGER IF EXISTS advisor_connection_blocked ON direct_message_blocks;
DROP TABLE IF EXISTS advisor_review_subscriptions;
DROP TABLE IF EXISTS advisor_review_requests;
DROP TABLE IF EXISTS advisor_billing_cleanup;
DROP FUNCTION IF EXISTS guard_advisor_review();
DROP FUNCTION IF EXISTS end_advisor_reviews();
DROP FUNCTION IF EXISTS advisor_subscription_retirement();
COMMIT;
