-- Additive source adapter. Existing manual-card provenance and grants are unchanged.
BEGIN;
ALTER TABLE wallet_card_access_grants ADD COLUMN IF NOT EXISTS last_accessed_at TIMESTAMPTZ;
ALTER TABLE wallet_card_access_grants ADD COLUMN IF NOT EXISTS verification_attempts INTEGER;
ALTER TABLE wallet_card_access_grants ADD COLUMN IF NOT EXISTS verification_attempted_at TIMESTAMPTZ;
ALTER TABLE wallet_card_access_grants ADD COLUMN IF NOT EXISTS trusted_at_creation BOOLEAN;
CREATE TABLE IF NOT EXISTS wallet_profile_share_requests (
 owner_user_id TEXT NOT NULL REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
 request_id UUID NOT NULL, card_id TEXT NOT NULL,
 fingerprint TEXT NOT NULL CHECK(fingerprint ~ '^[0-9a-f]{64}$'),
 created_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
 duration_minutes INTEGER NOT NULL CHECK(duration_minutes IN(5,10,15)),
 PRIMARY KEY(owner_user_id,request_id),
 CHECK(expires_at=created_at+duration_minutes*interval '1 minute')
);
CREATE TABLE IF NOT EXISTS wallet_profile_access_grants (
 id UUID PRIMARY KEY,
 owner_user_id TEXT NOT NULL REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
 recipient_user_id TEXT NOT NULL REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
 request_id UUID NOT NULL, card_id TEXT NOT NULL CHECK(card_id ~ '^profile_[0-9a-f-]{36}$'),
 message_id UUID UNIQUE REFERENCES messages(id) ON DELETE SET NULL,
 created_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
 verification_required BOOLEAN NOT NULL, trusted_at_creation BOOLEAN NOT NULL, verification_started_at TIMESTAMPTZ,
 verified_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ, last_accessed_at TIMESTAMPTZ,
 verification_attempts INTEGER, verification_attempted_at TIMESTAMPTZ,
 permitted_fields TEXT[] NOT NULL,
 UNIQUE(owner_user_id,request_id,recipient_user_id),
 FOREIGN KEY(owner_user_id,request_id) REFERENCES wallet_profile_share_requests(owner_user_id,request_id) ON DELETE CASCADE,
 CHECK(owner_user_id<>recipient_user_id),
 CHECK(expires_at-created_at IN(interval '5 minutes',interval '10 minutes',interval '15 minutes')),
 CHECK(permitted_fields <@ ARRAY['fullName','username','headline','organisation','locationLabel','summary','skills','email','phone','website','linkedin','github','portfolio','preferredContact','avatarUrl','updatedOn'])
);
CREATE INDEX IF NOT EXISTS wallet_profile_grants_owner ON wallet_profile_access_grants(owner_user_id,created_at DESC,id);
CREATE INDEX IF NOT EXISTS wallet_profile_grants_recipient ON wallet_profile_access_grants(recipient_user_id,created_at DESC,id);
CREATE OR REPLACE VIEW wallet_all_access_grants AS
 SELECT id,owner_user_id,recipient_user_id,message_id FROM wallet_card_access_grants
 UNION ALL SELECT id,owner_user_id,recipient_user_id,message_id FROM wallet_profile_access_grants;
REVOKE ALL ON wallet_all_access_grants FROM PUBLIC;
ALTER TABLE wallet_card_access_audit ADD COLUMN IF NOT EXISTS profile_grant_id UUID REFERENCES wallet_profile_access_grants(id) ON DELETE CASCADE;
ALTER TABLE wallet_card_access_audit DROP CONSTRAINT IF EXISTS wallet_card_access_audit_event_type_check;
ALTER TABLE wallet_card_access_audit ADD CONSTRAINT wallet_card_access_audit_event_type_check
 CHECK(event_type IN('created','delivered','viewed','verified','revoked','denied','expired')) NOT VALID;
-- NOT VALID avoids a deployment scan of historical audit records.
ALTER TABLE wallet_card_access_audit DROP CONSTRAINT IF EXISTS wallet_audit_source_check;
ALTER TABLE wallet_card_access_audit ADD CONSTRAINT wallet_audit_source_check
 CHECK(num_nonnulls(grant_id,profile_grant_id)=1) NOT VALID;

CREATE OR REPLACE FUNCTION guard_wallet_profile_access_grant() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN
 IF TG_OP='INSERT' THEN
  IF NOT EXISTS(SELECT 1 FROM public.wallet_profile_share_requests q
   JOIN public.one_wallet_cards p ON p.user_id=q.owner_user_id
   JOIN public.messages m ON m.id=NEW.message_id JOIN public.conversations c ON c.id=m.conversation_id
   WHERE q.owner_user_id=NEW.owner_user_id AND q.request_id=NEW.request_id AND q.card_id=NEW.card_id
   AND NEW.card_id='profile_'||p.pass_serial::text AND p.status='active'
   AND (p.expires_at IS NULL OR p.expires_at>clock_timestamp())
   AND q.created_at=NEW.created_at AND q.expires_at=NEW.expires_at
   AND m.sender_user_id=NEW.owner_user_id AND m.deleted_for_everyone_at IS NULL
   AND ((c.participant_a_user_id=NEW.owner_user_id AND c.participant_b_user_id=NEW.recipient_user_id)
    OR (c.participant_b_user_id=NEW.owner_user_id AND c.participant_a_user_id=NEW.recipient_user_id))) THEN
   RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='WALLET_CARD_GRANT_BINDING_INVALID';
  END IF;
  PERFORM public.require_active_direct_message_connection(NEW.owner_user_id,NEW.recipient_user_id);
 ELSE
  IF (NEW.id,NEW.owner_user_id,NEW.recipient_user_id,NEW.request_id,NEW.card_id,NEW.created_at,NEW.expires_at,NEW.permitted_fields)
   IS DISTINCT FROM (OLD.id,OLD.owner_user_id,OLD.recipient_user_id,OLD.request_id,OLD.card_id,OLD.created_at,OLD.expires_at,OLD.permitted_fields)
   OR (NEW.message_id IS DISTINCT FROM OLD.message_id AND NEW.message_id IS NOT NULL)
   OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)
   OR (NEW.trusted_at_creation IS DISTINCT FROM OLD.trusted_at_creation)
   OR (OLD.verification_required AND NOT NEW.verification_required)
   OR (OLD.verification_started_at IS NOT NULL AND NEW.verification_started_at IS DISTINCT FROM OLD.verification_started_at)
   OR (OLD.verified_at IS NOT NULL AND NEW.verified_at IS DISTINCT FROM OLD.verified_at) THEN
   RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='WALLET_CARD_GRANT_IMMUTABLE';
  END IF;
 END IF;
 RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS wallet_profile_grant_guard ON wallet_profile_access_grants;
CREATE TRIGGER wallet_profile_grant_guard BEFORE INSERT OR UPDATE ON wallet_profile_access_grants
 FOR EACH ROW EXECUTE FUNCTION guard_wallet_profile_access_grant();

-- Revocation/deletion is terminal even if the Profile Card is later recreated.
-- Pause remains a live visibility gate; history never authorizes access.
CREATE OR REPLACE FUNCTION revoke_wallet_profile_grants() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN
 IF TG_OP='DELETE' OR NEW.status='revoked' OR NEW.pass_serial IS DISTINCT FROM OLD.pass_serial THEN
  UPDATE public.wallet_profile_access_grants SET revoked_at=clock_timestamp() WHERE owner_user_id=OLD.user_id AND revoked_at IS NULL;
 END IF;
 RETURN OLD;
END; $$;
DROP TRIGGER IF EXISTS wallet_profile_source_revoked ON one_wallet_cards;
CREATE TRIGGER wallet_profile_source_revoked AFTER UPDATE OF status,pass_serial OR DELETE ON one_wallet_cards
 FOR EACH ROW EXECUTE FUNCTION revoke_wallet_profile_grants();

-- One audit authority for both source adapters, including PKM/source-trigger revokes.
CREATE OR REPLACE FUNCTION audit_wallet_grant_revocation() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN
 IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN
  IF TG_TABLE_NAME='wallet_profile_access_grants' THEN
   INSERT INTO public.wallet_card_access_audit(profile_grant_id,actor_user_id,event_type,created_at) VALUES(NEW.id,NEW.owner_user_id,'revoked',NEW.revoked_at);
  ELSE
   INSERT INTO public.wallet_card_access_audit(grant_id,actor_user_id,event_type,created_at) VALUES(NEW.id,NEW.owner_user_id,'revoked',NEW.revoked_at);
  END IF;
 END IF;
 RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS wallet_payment_revoked_audit ON wallet_card_access_grants;
CREATE TRIGGER wallet_payment_revoked_audit AFTER UPDATE ON wallet_card_access_grants FOR EACH ROW EXECUTE FUNCTION audit_wallet_grant_revocation();
DROP TRIGGER IF EXISTS wallet_profile_revoked_audit ON wallet_profile_access_grants;
CREATE TRIGGER wallet_profile_revoked_audit AFTER UPDATE ON wallet_profile_access_grants FOR EACH ROW EXECUTE FUNCTION audit_wallet_grant_revocation();
DO $$ DECLARE t TEXT; BEGIN
 FOREACH t IN ARRAY ARRAY['wallet_profile_share_requests','wallet_profile_access_grants'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC',t);
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon',t); END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE format('REVOKE ALL ON TABLE public.%I FROM authenticated',t); END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public.%I TO service_role',t); END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT SELECT ON wallet_all_access_grants TO service_role; END IF;
 PERFORM public.install_account_deletion_write_guards();
END; $$;
REVOKE ALL ON FUNCTION guard_wallet_profile_access_grant(),revoke_wallet_profile_grants(),audit_wallet_grant_revocation() FROM PUBLIC;
CREATE OR REPLACE FUNCTION guard_wallet_creation_trust() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN
 IF NEW.trusted_at_creation IS DISTINCT FROM OLD.trusted_at_creation THEN
  RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='WALLET_CARD_GRANT_IMMUTABLE';
 END IF;
 RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS wallet_payment_trust_guard ON wallet_card_access_grants;
CREATE TRIGGER wallet_payment_trust_guard BEFORE UPDATE ON wallet_card_access_grants FOR EACH ROW EXECUTE FUNCTION guard_wallet_creation_trust();
REVOKE ALL ON FUNCTION guard_wallet_creation_trust() FROM PUBLIC;
COMMIT;
