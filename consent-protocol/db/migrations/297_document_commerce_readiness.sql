-- Readiness is a conservative cache of Stripe's full US transfer/bank check.
-- Existing mappings must be reverified; raw payouts_enabled is insufficient.
BEGIN;
ALTER TABLE pkm_owner_payout_accounts
  ADD COLUMN IF NOT EXISTS account_ready BOOLEAN NOT NULL DEFAULT FALSE;

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
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
    WHERE tgname='drive_owner_earning_feed_wake'
      AND tgrelid='drive_request_owner_payouts'::regclass) THEN
    CREATE TRIGGER drive_owner_earning_feed_wake
      AFTER UPDATE OF status ON drive_request_owner_payouts
      FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
      EXECUTE FUNCTION public.notify_document_owner_earning_changed();
  END IF;
END $$;
COMMIT;
