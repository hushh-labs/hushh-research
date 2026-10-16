-- Metadata-only asks. Card contents and consent remain in the existing grant owners.
BEGIN;
CREATE TABLE IF NOT EXISTS wallet_card_requests (
 id UUID PRIMARY KEY,
 requester_user_id TEXT NOT NULL REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
 target_user_id TEXT NOT NULL REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
 client_request_id UUID NOT NULL,
 message_id UUID UNIQUE REFERENCES messages(id) ON DELETE SET NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','fulfilled','declined','cancelled','expired')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 expires_at TIMESTAMPTZ NOT NULL,
 resolved_at TIMESTAMPTZ,
 payment_grant_id UUID UNIQUE REFERENCES wallet_card_access_grants(id) ON DELETE SET NULL,
 profile_grant_id UUID UNIQUE REFERENCES wallet_profile_access_grants(id) ON DELETE SET NULL,
 UNIQUE(requester_user_id,client_request_id),
 CHECK(requester_user_id<>target_user_id),
 CHECK(expires_at=created_at+interval '7 days'),
 CHECK((status='pending')=(resolved_at IS NULL)),
 CHECK(num_nonnulls(payment_grant_id,profile_grant_id)<=1),
 CHECK(status='fulfilled' OR num_nonnulls(payment_grant_id,profile_grant_id)=0)
);
CREATE INDEX IF NOT EXISTS wallet_card_requests_target ON wallet_card_requests(target_user_id,status,created_at DESC,id);
CREATE UNIQUE INDEX IF NOT EXISTS wallet_card_requests_pending_pair ON wallet_card_requests(requester_user_id,target_user_id) WHERE status='pending';
CREATE OR REPLACE FUNCTION guard_wallet_card_request() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.status<>'pending' OR NEW.message_id IS NULL OR NOT EXISTS(
   SELECT 1 FROM public.messages m JOIN public.conversations c ON c.id=m.conversation_id
   WHERE m.id=NEW.message_id AND m.sender_user_id=NEW.requester_user_id
    AND m.deleted_for_everyone_at IS NULL
    AND ((c.participant_a_user_id=NEW.requester_user_id AND c.participant_b_user_id=NEW.target_user_id)
      OR (c.participant_b_user_id=NEW.requester_user_id AND c.participant_a_user_id=NEW.target_user_id))
  ) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='WALLET_CARD_REQUEST_BINDING_INVALID'; END IF;
  PERFORM public.require_active_direct_message_connection(NEW.requester_user_id,NEW.target_user_id);
 ELSE
  IF (NEW.id,NEW.requester_user_id,NEW.target_user_id,NEW.client_request_id,NEW.created_at,NEW.expires_at)
   IS DISTINCT FROM (OLD.id,OLD.requester_user_id,OLD.target_user_id,OLD.client_request_id,OLD.created_at,OLD.expires_at)
   OR (NEW.message_id IS DISTINCT FROM OLD.message_id AND NEW.message_id IS NOT NULL)
   OR (OLD.status<>'pending' AND (NEW.status,NEW.resolved_at) IS DISTINCT FROM (OLD.status,OLD.resolved_at))
  THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='WALLET_CARD_REQUEST_IMMUTABLE'; END IF;
  IF (NEW.payment_grant_id,NEW.profile_grant_id) IS DISTINCT FROM (OLD.payment_grant_id,OLD.profile_grant_id)
   AND num_nonnulls(NEW.payment_grant_id,NEW.profile_grant_id)>0
   AND NOT (OLD.status='pending' AND NEW.status='fulfilled')
  THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='WALLET_CARD_REQUEST_IMMUTABLE'; END IF;
  IF OLD.status='pending' AND NEW.status='fulfilled' THEN
   IF OLD.expires_at<=clock_timestamp() OR NOT (
    EXISTS(SELECT 1 FROM public.wallet_card_access_grants g WHERE g.id=NEW.payment_grant_id
     AND g.owner_user_id=NEW.target_user_id AND g.recipient_user_id=NEW.requester_user_id AND g.created_at>=NEW.created_at)
    OR EXISTS(SELECT 1 FROM public.wallet_profile_access_grants g WHERE g.id=NEW.profile_grant_id
     AND g.owner_user_id=NEW.target_user_id AND g.recipient_user_id=NEW.requester_user_id AND g.created_at>=NEW.created_at)
   ) THEN RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='WALLET_CARD_REQUEST_RESPONSE_INVALID'; END IF;
  END IF;
 END IF;
 RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS wallet_card_request_guard ON wallet_card_requests;
CREATE TRIGGER wallet_card_request_guard BEFORE INSERT OR UPDATE ON wallet_card_requests
 FOR EACH ROW EXECUTE FUNCTION guard_wallet_card_request();
ALTER TABLE wallet_card_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE wallet_card_requests FROM PUBLIC;
REVOKE ALL ON FUNCTION guard_wallet_card_request() FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN REVOKE ALL ON wallet_card_requests FROM anon; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN REVOKE ALL ON wallet_card_requests FROM authenticated; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT SELECT,INSERT,UPDATE,DELETE ON wallet_card_requests TO service_role; END IF;
 PERFORM public.install_account_deletion_write_guards();
END; $$;
COMMIT;
