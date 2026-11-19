-- Combined connection + Finance review approval. Pending snapshots stay sealed.
BEGIN;
CREATE TABLE IF NOT EXISTS advisor_review_requests (
  id uuid PRIMARY KEY,
  owner_user_id text NOT NULL REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  advisor_user_id text NOT NULL REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  advisor_person_ref uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','declined','withdrawn','stopped','expired')),
  fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
  content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),
  envelope jsonb,
  owner_envelope jsonb,
  introduction text NOT NULL DEFAULT '' CHECK(length(introduction)<=600),
  connection_id uuid REFERENCES connections(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  meeting jsonb,
  plan jsonb,
  plan_revision integer NOT NULL DEFAULT 0 CHECK(plan_revision>=0),
  CHECK(owner_user_id<>advisor_user_id),
  CHECK(expires_at>created_at),
  CHECK(status<>'accepted' OR accepted_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS advisor_review_owner ON advisor_review_requests(owner_user_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS advisor_review_inbox ON advisor_review_requests(advisor_user_id,created_at DESC,id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS advisor_review_one_open_pair ON advisor_review_requests(owner_user_id,advisor_user_id) WHERE status IN ('pending','accepted');

CREATE TABLE IF NOT EXISTS advisor_review_subscriptions (
  request_id uuid PRIMARY KEY REFERENCES advisor_review_requests(id) ON DELETE CASCADE,
  stripe_mode text NOT NULL CHECK(stripe_mode='test'),
  payee_account text NOT NULL,
  plan_revision integer NOT NULL,
  plan_hash text NOT NULL,
  checkout_session_id text UNIQUE,
  subscription_id text UNIQUE,
  customer_id text,
  status text NOT NULL DEFAULT 'preparing' CHECK(status IN ('preparing','checkout_pending','active','past_due','cancelled','unpaid','incomplete','unknown')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- Provider cleanup survives account deletion, without names or portfolio contents.
CREATE TABLE IF NOT EXISTS advisor_billing_cleanup (
  resource_id text PRIMARY KEY,
  resource_kind text NOT NULL CHECK(resource_kind IN ('checkout','subscription')),
  stripe_mode text NOT NULL CHECK(stripe_mode='test'),
  completed_at timestamptz,
  attempts integer NOT NULL DEFAULT 0
);
CREATE OR REPLACE FUNCTION advisor_subscription_retirement() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN
  IF OLD.subscription_id IS NOT NULL THEN
    INSERT INTO advisor_billing_cleanup(resource_id,resource_kind,stripe_mode)
    VALUES(OLD.subscription_id,'subscription',OLD.stripe_mode) ON CONFLICT DO NOTHING;
  END IF;
  IF OLD.checkout_session_id IS NOT NULL THEN
    INSERT INTO advisor_billing_cleanup(resource_id,resource_kind,stripe_mode)
    VALUES(OLD.checkout_session_id,'checkout',OLD.stripe_mode) ON CONFLICT DO NOTHING;
  END IF;
  RETURN OLD;
END; $$;
DROP TRIGGER IF EXISTS advisor_subscription_retirement ON advisor_review_subscriptions;
CREATE TRIGGER advisor_subscription_retirement BEFORE DELETE ON advisor_review_subscriptions FOR EACH ROW EXECUTE FUNCTION advisor_subscription_retirement();

CREATE OR REPLACE FUNCTION guard_advisor_review() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$ BEGIN
  IF (NEW.id,NEW.owner_user_id,NEW.advisor_user_id,NEW.advisor_person_ref,NEW.fingerprint,NEW.content_hash,NEW.introduction,NEW.created_at,NEW.expires_at)
    IS DISTINCT FROM (OLD.id,OLD.owner_user_id,OLD.advisor_user_id,OLD.advisor_person_ref,OLD.fingerprint,OLD.content_hash,OLD.introduction,OLD.created_at,OLD.expires_at)
    OR (NEW.envelope IS DISTINCT FROM OLD.envelope AND NEW.envelope IS NOT NULL)
    OR (NEW.owner_envelope IS DISTINCT FROM OLD.owner_envelope AND NEW.owner_envelope IS NOT NULL)
    OR (OLD.status NOT IN ('pending','accepted') AND NEW.status<>OLD.status)
    OR (OLD.status='accepted' AND NEW.status NOT IN ('accepted','stopped','expired')) THEN
    RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='ADVISOR_APPROVAL_IMMUTABLE';
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS advisor_review_guard ON advisor_review_requests;
CREATE TRIGGER advisor_review_guard BEFORE UPDATE ON advisor_review_requests FOR EACH ROW EXECUTE FUNCTION guard_advisor_review();
CREATE OR REPLACE FUNCTION end_advisor_reviews() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE a text; b text;
BEGIN
  IF TG_TABLE_NAME='direct_message_blocks' THEN a:=NEW.blocker_user_id; b:=NEW.blocked_user_id;
  ELSE
    IF TG_OP<>'DELETE' AND NEW.status='active' THEN RETURN NEW; END IF;
    a:=OLD.user_a_id; b:=OLD.user_b_id;
  END IF;
  UPDATE advisor_review_requests SET status='stopped',envelope=NULL,owner_envelope=NULL,updated_at=clock_timestamp()
    WHERE status IN ('pending','accepted') AND ((owner_user_id=a AND advisor_user_id=b) OR (owner_user_id=b AND advisor_user_id=a));
  IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS advisor_connection_ended ON connections;
CREATE TRIGGER advisor_connection_ended AFTER UPDATE OF status OR DELETE ON connections FOR EACH ROW EXECUTE FUNCTION end_advisor_reviews();
DROP TRIGGER IF EXISTS advisor_connection_blocked ON direct_message_blocks;
CREATE TRIGGER advisor_connection_blocked AFTER INSERT ON direct_message_blocks FOR EACH ROW EXECUTE FUNCTION end_advisor_reviews();
ALTER TABLE advisor_review_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE advisor_review_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE advisor_billing_cleanup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON advisor_review_requests,advisor_review_subscriptions,advisor_billing_cleanup FROM PUBLIC;
DO $$ DECLARE role_name text; BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN EXECUTE format('REVOKE ALL ON advisor_review_requests,advisor_review_subscriptions,advisor_billing_cleanup FROM %I',role_name); END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN GRANT SELECT,INSERT,UPDATE,DELETE ON advisor_review_requests,advisor_review_subscriptions,advisor_billing_cleanup TO service_role; END IF;
END $$;
SELECT install_account_deletion_write_guards();
COMMIT;
