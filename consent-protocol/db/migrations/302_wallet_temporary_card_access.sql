-- Additive, server-owned manual-card provenance and temporary recipient grants.
-- Owner-confirmed Wallet writes register saved payment cards automatically.
BEGIN;
CREATE TABLE IF NOT EXISTS wallet_card_registrations (
 owner_user_id TEXT NOT NULL, card_id TEXT NOT NULL, registration_request_id UUID NOT NULL,
 state TEXT NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','active','removed')),
 origin TEXT NOT NULL DEFAULT 'owner_manual_add_v1' CHECK(origin IN ('owner_manual_add_v1','owner_saved_card_v1')),
 reserved_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 reservation_expires_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()+interval '24 hours',
 activated_at TIMESTAMPTZ, source_commit_id UUID, source_manifest_revision INTEGER,
 source_projection JSONB, source_projection_revision INTEGER,
 PRIMARY KEY(owner_user_id,card_id), UNIQUE(owner_user_id,registration_request_id),
 CHECK(card_id ~ '^card_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
 CHECK(state<>'active' OR (activated_at IS NOT NULL AND source_commit_id IS NOT NULL))
);
ALTER TABLE wallet_card_registrations DROP CONSTRAINT IF EXISTS wallet_card_registrations_origin_check;
ALTER TABLE wallet_card_registrations ADD CONSTRAINT wallet_card_registrations_origin_check
 CHECK(origin IN ('owner_manual_add_v1','owner_saved_card_v1'));
CREATE TABLE IF NOT EXISTS wallet_card_share_requests (
 owner_user_id TEXT NOT NULL, request_id UUID NOT NULL, card_id TEXT NOT NULL,
 fingerprint TEXT NOT NULL CHECK(fingerprint ~ '^[0-9a-f]{64}$'),
 created_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
 duration_minutes INTEGER NOT NULL CHECK(duration_minutes IN(5,10,15)),
 PRIMARY KEY(owner_user_id,request_id),
 FOREIGN KEY(owner_user_id,card_id) REFERENCES wallet_card_registrations(owner_user_id,card_id) ON DELETE CASCADE,
 CHECK(expires_at=created_at+duration_minutes*interval '1 minute')
);
CREATE TABLE IF NOT EXISTS wallet_card_access_grants (
 id UUID PRIMARY KEY, owner_user_id TEXT NOT NULL, recipient_user_id TEXT NOT NULL,
 request_id UUID NOT NULL, card_id TEXT NOT NULL,
 message_id UUID UNIQUE REFERENCES messages(id) ON DELETE SET NULL,
 created_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
 verification_required BOOLEAN NOT NULL, verification_started_at TIMESTAMPTZ,
 verified_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ,
 permitted_fields TEXT[] NOT NULL DEFAULT ARRAY['brand','last4','expiryMonth','expiryYear','issuingRegion'],
 content_ciphertext TEXT NOT NULL, content_iv TEXT NOT NULL, content_algorithm TEXT NOT NULL,
 UNIQUE(owner_user_id,request_id,recipient_user_id),
 FOREIGN KEY(owner_user_id,request_id) REFERENCES wallet_card_share_requests(owner_user_id,request_id) ON DELETE CASCADE,
 FOREIGN KEY(owner_user_id,card_id) REFERENCES wallet_card_registrations(owner_user_id,card_id) ON DELETE CASCADE,
 CHECK(owner_user_id<>recipient_user_id),
 CHECK(expires_at-created_at IN(interval '5 minutes',interval '10 minutes',interval '15 minutes')),
 CHECK(permitted_fields=ARRAY['brand','last4','expiryMonth','expiryYear','issuingRegion']),
 CHECK(octet_length(content_ciphertext)<=4096)
);
CREATE INDEX IF NOT EXISTS wallet_card_grants_owner_card ON wallet_card_access_grants(owner_user_id,card_id,created_at DESC);
CREATE INDEX IF NOT EXISTS wallet_card_grants_recipient ON wallet_card_access_grants(recipient_user_id,expires_at);
CREATE TABLE IF NOT EXISTS wallet_card_access_audit (
 id BIGSERIAL PRIMARY KEY, grant_id UUID REFERENCES wallet_card_access_grants(id) ON DELETE CASCADE,
 actor_user_id TEXT NOT NULL, event_type TEXT NOT NULL CHECK(event_type IN('created','viewed','verified','revoked','denied')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
-- Postgres is the authority; future cache acceleration must never authorize a stale grant.
CREATE OR REPLACE FUNCTION activate_reserved_wallet_cards() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE projection JSONB; BEGIN
 IF NEW.domain<>'wallet' THEN RETURN NEW; END IF;
 SELECT summary_projection->'wallet_card_access_projection' INTO projection FROM public.pkm_manifests
 WHERE user_id=NEW.user_id AND domain='wallet' AND manifest_version=NEW.result_manifest_revision;
 IF jsonb_typeof(projection->'cardIds') IS DISTINCT FROM 'array'
 OR jsonb_typeof(projection->'cards') IS DISTINCT FROM 'array' THEN RETURN NEW; END IF;
 UPDATE public.wallet_card_registrations r SET state='removed'
 WHERE r.owner_user_id=NEW.user_id AND r.state='active'
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(projection->'cardIds') c(card_id) WHERE c.card_id=r.card_id);
 UPDATE public.wallet_card_access_grants g SET revoked_at=COALESCE(g.revoked_at,clock_timestamp())
 WHERE g.owner_user_id=NEW.user_id AND EXISTS(SELECT 1 FROM public.wallet_card_registrations r
 WHERE r.owner_user_id=g.owner_user_id AND r.card_id=g.card_id AND r.state='removed');
 UPDATE public.wallet_card_registrations r SET source_projection=e,
  source_projection_revision=NEW.result_manifest_revision
 FROM jsonb_array_elements(projection->'cards') e
 WHERE r.owner_user_id=NEW.user_id AND r.state='active' AND e->>'cardId'=r.card_id;
 IF NEW.commit_kind='mutation' THEN
  INSERT INTO public.wallet_card_registrations
   (owner_user_id,card_id,registration_request_id,state,origin,activated_at,
    source_commit_id,source_manifest_revision,source_projection,source_projection_revision)
  SELECT NEW.user_id,e->>'cardId',gen_random_uuid(),'active','owner_saved_card_v1',clock_timestamp(),
   NEW.commit_id,NEW.result_manifest_revision,e,NEW.result_manifest_revision
  FROM jsonb_array_elements(projection->'cards') e
  WHERE e->>'cardId' ~ '^card_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(projection->'cardIds') c(card_id) WHERE c.card_id=e->>'cardId')
  ON CONFLICT(owner_user_id,card_id) DO NOTHING;
  UPDATE public.wallet_card_registrations r SET state='active',activated_at=clock_timestamp(),
   origin=CASE WHEN r.reservation_expires_at<=clock_timestamp() THEN 'owner_saved_card_v1' ELSE r.origin END,
   source_commit_id=NEW.commit_id,source_manifest_revision=NEW.result_manifest_revision,
   source_projection=e,source_projection_revision=NEW.result_manifest_revision
  FROM jsonb_array_elements(projection->'cards') e
  WHERE r.owner_user_id=NEW.user_id AND r.state='reserved'
   AND e->>'cardId'=r.card_id
   AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(projection->'cardIds') c(card_id) WHERE c.card_id=r.card_id);
 END IF;
 RETURN NEW;
END; $$;
CREATE OR REPLACE FUNCTION remove_wallet_card_registrations() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN
 IF OLD.domain='wallet' THEN
  UPDATE public.wallet_card_registrations SET state='removed' WHERE owner_user_id=OLD.user_id;
  UPDATE public.wallet_card_access_grants SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE owner_user_id=OLD.user_id;
 END IF;
 RETURN OLD;
END; $$;
DROP TRIGGER IF EXISTS wallet_cards_activate_after_commit ON pkm_domain_commits;
CREATE TRIGGER wallet_cards_activate_after_commit AFTER INSERT ON pkm_domain_commits
 FOR EACH ROW EXECUTE FUNCTION activate_reserved_wallet_cards();
DROP TRIGGER IF EXISTS wallet_cards_domain_removed ON pkm_manifests;
CREATE TRIGGER wallet_cards_domain_removed AFTER DELETE ON pkm_manifests
 FOR EACH ROW EXECUTE FUNCTION remove_wallet_card_registrations();
CREATE OR REPLACE FUNCTION guard_wallet_card_access_grant() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN
 IF TG_OP='INSERT' THEN
  IF NOT EXISTS(SELECT 1 FROM public.wallet_card_share_requests q
   JOIN public.wallet_card_registrations r ON r.owner_user_id=q.owner_user_id AND r.card_id=q.card_id
   JOIN public.messages m ON m.id=NEW.message_id
   JOIN public.conversations c ON c.id=m.conversation_id
   WHERE q.owner_user_id=NEW.owner_user_id AND q.request_id=NEW.request_id AND q.card_id=NEW.card_id
   AND q.created_at=NEW.created_at AND q.expires_at=NEW.expires_at AND r.state='active'
   AND r.origin IN ('owner_manual_add_v1','owner_saved_card_v1') AND m.sender_user_id=NEW.owner_user_id
   AND m.deleted_for_everyone_at IS NULL
   AND ((c.participant_a_user_id=NEW.owner_user_id AND c.participant_b_user_id=NEW.recipient_user_id)
    OR (c.participant_b_user_id=NEW.owner_user_id AND c.participant_a_user_id=NEW.recipient_user_id))) THEN
   RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='WALLET_CARD_GRANT_BINDING_INVALID';
  END IF;
  PERFORM public.require_active_direct_message_connection(NEW.owner_user_id,NEW.recipient_user_id);
 ELSE
  IF (NEW.id,NEW.owner_user_id,NEW.recipient_user_id,NEW.request_id,NEW.card_id,NEW.created_at,NEW.expires_at,
   NEW.content_ciphertext,NEW.content_iv,NEW.content_algorithm,NEW.permitted_fields)
   IS DISTINCT FROM (OLD.id,OLD.owner_user_id,OLD.recipient_user_id,OLD.request_id,OLD.card_id,OLD.created_at,OLD.expires_at,
   OLD.content_ciphertext,OLD.content_iv,OLD.content_algorithm,OLD.permitted_fields)
   OR (NEW.message_id IS DISTINCT FROM OLD.message_id AND NEW.message_id IS NOT NULL)
   OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)
   OR (OLD.verification_required AND NOT NEW.verification_required)
   OR (OLD.verification_started_at IS NOT NULL AND NEW.verification_started_at IS DISTINCT FROM OLD.verification_started_at)
   OR (OLD.verified_at IS NOT NULL AND NEW.verified_at IS DISTINCT FROM OLD.verified_at) THEN
   RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='WALLET_CARD_GRANT_IMMUTABLE';
  END IF;
 END IF;
 RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS wallet_card_grant_guard ON wallet_card_access_grants;
CREATE TRIGGER wallet_card_grant_guard BEFORE INSERT OR UPDATE ON wallet_card_access_grants
 FOR EACH ROW EXECUTE FUNCTION guard_wallet_card_access_grant();
REVOKE ALL ON FUNCTION guard_wallet_card_access_grant() FROM PUBLIC;
DO $$ DECLARE t TEXT; BEGIN
 FOREACH t IN ARRAY ARRAY['wallet_card_registrations','wallet_card_share_requests','wallet_card_access_grants','wallet_card_access_audit'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC',t);
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon',t); END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE format('REVOKE ALL ON TABLE public.%I FROM authenticated',t); END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON TABLE public.%I TO service_role',t); END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT USAGE,SELECT ON SEQUENCE wallet_card_access_audit_id_seq TO service_role; END IF;
 PERFORM public.install_account_deletion_write_guards();
END; $$;
REVOKE ALL ON FUNCTION activate_reserved_wallet_cards() FROM PUBLIC;
REVOKE ALL ON FUNCTION remove_wallet_card_registrations() FROM PUBLIC;
COMMIT;
