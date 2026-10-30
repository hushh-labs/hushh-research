-- The owner-earning trigger names what changed: kinds ["earnings","wallet"]
-- and the request. Same function, same trigger; only the payload grows.
-- The payload is deterministic (no random id) and byte-identical to
-- hushh_mcp.services.payout_doorbell.payout_doorbell_payload(owner,
-- ["earnings","wallet"], request_id), so PostgreSQL delivers one notification
-- when a service raises the same doorbell in the same transaction. Readers
-- that predate the new fields ignore them. Replaying this file is a no-op;
-- CREATE OR REPLACE takes no lock on drive_request_owner_payouts.
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
    PERFORM pg_notify('one_user_state_changed',
      '{"kinds":["earnings","wallet"],"request_id":'
      || to_json(NEW.request_id::TEXT)::TEXT
      || ',"type":"bank_payout_changed","user_id":'
      || to_json(owner_id)::TEXT
      || '}');
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'drive_earning_feed_wake_failed sqlstate=%', SQLSTATE;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.notify_document_owner_earning_changed() FROM PUBLIC;
COMMIT;
