-- Rollback for 318_payout_doorbell_kinds.sql: restores the 297 function body
-- (untyped doorbell). The trigger, money rows and event history are untouched;
-- readers treat a doorbell without kinds as "every kind".
BEGIN;
CREATE OR REPLACE FUNCTION public.notify_document_owner_earning_changed()
RETURNS TRIGGER
LANGUAGE plpgsql VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE owner_id TEXT;
BEGIN
  SELECT user_id INTO owner_id FROM drive_share_requests
    WHERE request_id=NEW.request_id;
  IF owner_id IS NOT NULL THEN
    PERFORM pg_notify('one_user_state_changed', json_build_object(
      'type','bank_payout_changed','user_id',owner_id)::TEXT);
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'drive_earning_feed_wake_failed sqlstate=%', SQLSTATE;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.notify_document_owner_earning_changed() FROM PUBLIC;
COMMIT;
