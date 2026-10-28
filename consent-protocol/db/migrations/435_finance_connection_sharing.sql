-- Curated Finance objects: encrypted contents, explicit per-person authority.
BEGIN;
CREATE TABLE IF NOT EXISTS finance_share_requests (
  owner_user_id text NOT NULL REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  id uuid NOT NULL,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  policy jsonb NOT NULL,
  owner_config jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz,
  PRIMARY KEY(owner_user_id,id),
  CHECK (policy->>'mode' IN ('snapshot','ongoing')),
  CHECK (expires_at IS NOT NULL OR policy->>'mode' = 'ongoing')
);
CREATE TABLE IF NOT EXISTS finance_access_grants (
  id uuid PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  recipient_user_id text NOT NULL REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  recipient_key_id text NOT NULL,
  envelope jsonb,
  owner_envelope jsonb,
  content_hash text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  message_id uuid NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz,
  FOREIGN KEY(owner_user_id,request_id) REFERENCES finance_share_requests(owner_user_id,id) ON DELETE CASCADE,
  UNIQUE(owner_user_id,request_id,recipient_user_id),
  CHECK (owner_user_id <> recipient_user_id)
);
CREATE INDEX IF NOT EXISTS finance_shares_recipient ON finance_access_grants(recipient_user_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS finance_shares_owner ON finance_access_grants(owner_user_id,created_at DESC,id DESC);
CREATE OR REPLACE FUNCTION guard_finance_share_request() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN
  IF (NEW.owner_user_id,NEW.id,NEW.fingerprint,NEW.policy,NEW.created_at,NEW.expires_at)
    IS DISTINCT FROM (OLD.owner_user_id,OLD.id,OLD.fingerprint,OLD.policy,OLD.created_at,OLD.expires_at)
    OR (NEW.owner_config IS DISTINCT FROM OLD.owner_config AND NEW.owner_config IS NOT NULL) THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='FINANCE_SHARE_APPROVAL_IMMUTABLE';
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS finance_share_request_guard ON finance_share_requests;
CREATE TRIGGER finance_share_request_guard BEFORE UPDATE ON finance_share_requests
  FOR EACH ROW EXECUTE FUNCTION guard_finance_share_request();
CREATE OR REPLACE FUNCTION guard_finance_access_grant() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE policy_mode text; deadline timestamptz;
BEGIN
  SELECT policy->>'mode',expires_at INTO policy_mode,deadline FROM finance_share_requests
    WHERE owner_user_id=NEW.owner_user_id AND id=NEW.request_id;
  IF TG_OP='INSERT' THEN
    IF NOT EXISTS(SELECT 1 FROM messages m JOIN conversations c ON c.id=m.conversation_id
      WHERE m.id=NEW.message_id AND m.sender_user_id=NEW.owner_user_id AND m.deleted_for_everyone_at IS NULL
      AND ((c.participant_a_user_id=NEW.owner_user_id AND c.participant_b_user_id=NEW.recipient_user_id)
        OR (c.participant_b_user_id=NEW.owner_user_id AND c.participant_a_user_id=NEW.recipient_user_id))) THEN
      RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='FINANCE_SHARE_RECIPIENT_BINDING_INVALID';
    END IF;
    PERFORM require_active_direct_message_connection(NEW.owner_user_id,NEW.recipient_user_id);
  ELSE
    IF (NEW.id,NEW.owner_user_id,NEW.recipient_user_id,NEW.request_id,NEW.recipient_key_id,NEW.message_id,NEW.created_at)
       IS DISTINCT FROM (OLD.id,OLD.owner_user_id,OLD.recipient_user_id,OLD.request_id,OLD.recipient_key_id,OLD.message_id,OLD.created_at)
       OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
      RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='FINANCE_SHARE_GRANT_IMMUTABLE';
    END IF;
    IF NEW.envelope IS NOT NULL AND (NEW.envelope,NEW.owner_envelope,NEW.content_hash,NEW.revision)
      IS DISTINCT FROM (OLD.envelope,OLD.owner_envelope,OLD.content_hash,OLD.revision) THEN
      IF OLD.revoked_at IS NOT NULL OR policy_mode<>'ongoing' OR deadline<=clock_timestamp()
        OR NEW.revision<>OLD.revision+1 THEN
        RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='FINANCE_SHARE_REFRESH_DENIED';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS finance_access_grant_guard ON finance_access_grants;
CREATE TRIGGER finance_access_grant_guard BEFORE INSERT OR UPDATE ON finance_access_grants
  FOR EACH ROW EXECUTE FUNCTION guard_finance_access_grant();
-- Ending a relationship is terminal. Reconnect/unblock never revives a grant.
CREATE OR REPLACE FUNCTION end_finance_connection_shares() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE a text; b text;
BEGIN
  IF TG_TABLE_NAME='direct_message_blocks' THEN
    a:=NEW.blocker_user_id; b:=NEW.blocked_user_id;
  ELSE
    IF TG_OP<>'DELETE' AND NEW.status='active' THEN RETURN NEW; END IF;
    a:=OLD.user_a_id; b:=OLD.user_b_id;
  END IF;
  UPDATE finance_access_grants SET revoked_at=COALESCE(revoked_at,clock_timestamp()),envelope=NULL,owner_envelope=NULL
    WHERE revoked_at IS NULL AND ((owner_user_id=a AND recipient_user_id=b) OR (owner_user_id=b AND recipient_user_id=a));
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS finance_connection_ended ON connections;
CREATE TRIGGER finance_connection_ended AFTER UPDATE OF status OR DELETE ON connections
  FOR EACH ROW EXECUTE FUNCTION end_finance_connection_shares();
DROP TRIGGER IF EXISTS finance_connection_blocked ON direct_message_blocks;
CREATE TRIGGER finance_connection_blocked AFTER INSERT ON direct_message_blocks
  FOR EACH ROW EXECUTE FUNCTION end_finance_connection_shares();
ALTER TABLE finance_share_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance_access_grants ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON finance_share_requests,finance_access_grants FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON finance_share_requests,finance_access_grants FROM anon;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    REVOKE ALL ON finance_share_requests,finance_access_grants FROM authenticated;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON finance_share_requests,finance_access_grants TO service_role;
  END IF;
END $$;
SELECT install_account_deletion_write_guards();
COMMIT;
