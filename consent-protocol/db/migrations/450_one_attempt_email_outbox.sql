BEGIN;

-- Separate from promotional email permission. No existing account is enrolled.
CREATE TABLE IF NOT EXISTS one_attempt_email_preferences (
  user_id TEXT PRIMARY KEY REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  user_hash TEXT GENERATED ALWAYS AS ('sha256:' || encode(digest(user_id,'sha256'),'hex')) STORED UNIQUE,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  revision BIGINT NOT NULL CHECK (revision > 0),
  generation UUID NOT NULL DEFAULT gen_random_uuid(),
  activity_generation UUID NOT NULL,
  email_hash CHAR(64) CHECK (email_hash IS NULL OR email_hash ~ '^[0-9a-f]{64}$'),
  disclosure_version TEXT NOT NULL CHECK (disclosure_version='one-attempt-email-v1'),
  consent_at TIMESTAMPTZ,
  chosen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (NOT enabled OR (email_hash IS NOT NULL AND consent_at IS NOT NULL))
);

-- The unique owner/epoch/attempt key is retained until reset/account erasure.
-- Provider submission is never performed inside a replayed SQL transaction.
CREATE TABLE IF NOT EXISTS one_attempt_email_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES one_product_activity_epochs(user_id) ON DELETE CASCADE,
  activity_generation UUID NOT NULL,
  attempt_key CHAR(64) NOT NULL CHECK (attempt_key ~ '^[0-9a-f]{64}$'),
  permission_generation UUID NOT NULL,
  permission_revision BIGINT NOT NULL CHECK (permission_revision > 0),
  recipient_hash CHAR(64) NOT NULL CHECK (recipient_hash ~ '^[0-9a-f]{64}$'),
  agent_id TEXT NOT NULL CHECK (char_length(agent_id) BETWEEN 1 AND 128),
  action_id TEXT NOT NULL CHECK (char_length(action_id) BETWEEN 1 AND 256),
  phase TEXT NOT NULL CHECK (phase IN ('returned','failed','cancelled','blocked')),
  observed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','sending','accepted','uncertain','suppressed')),
  claim_id UUID,
  claimed_at TIMESTAMPTZ,
  provider_id TEXT CHECK (provider_id IS NULL OR
    (char_length(provider_id) BETWEEN 1 AND 256 AND provider_id ~ '^[A-Za-z0-9_-]+$')),
  accepted_at TIMESTAMPTZ,
  UNIQUE(user_id,activity_generation,attempt_key),
  CHECK (status NOT IN ('sending','accepted','uncertain') OR (claim_id IS NOT NULL AND claimed_at IS NOT NULL)),
  CHECK (status <> 'accepted' OR (provider_id IS NOT NULL AND accepted_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS one_attempt_email_pending
  ON one_attempt_email_outbox(created_at,id) WHERE status='pending';
CREATE INDEX IF NOT EXISTS one_attempt_email_expiry
  ON one_attempt_email_outbox(expires_at,id) WHERE status='pending';
CREATE INDEX IF NOT EXISTS one_attempt_email_unsettled
  ON one_attempt_email_outbox(claimed_at,id) WHERE status='sending';

CREATE OR REPLACE FUNCTION public.enqueue_one_attempt_email() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  -- Interactive client attempts only. SDK/tool observations may describe the
  -- same attempt and do not receive an additional email. A terminal report is
  -- labelled as reported; it never proves an external effect succeeded.
  IF NEW.source <> 'client_reported' OR NEW.phase='started' OR NEW.operation_key IS NULL THEN RETURN NEW; END IF;
  INSERT INTO one_attempt_email_outbox
    (user_id,activity_generation,attempt_key,permission_generation,permission_revision,
     recipient_hash,agent_id,action_id,phase,observed_at)
  SELECT NEW.user_id,NEW.generation,NEW.operation_key,
    p.generation,p.revision,p.email_hash,NEW.agent_id,NEW.action_id,NEW.phase,NEW.observed_at
  FROM one_attempt_email_preferences p
  JOIN one_product_activity_epochs e ON e.user_id=p.user_id
  WHERE p.user_id=NEW.user_id AND p.enabled AND p.activity_generation=NEW.generation
    AND e.generation=NEW.generation AND NEW.observed_at>=p.consent_at
  ON CONFLICT(user_id,activity_generation,attempt_key) DO NOTHING;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS one_attempt_email_observation ON one_product_activity_observations;
CREATE TRIGGER one_attempt_email_observation AFTER INSERT ON one_product_activity_observations
  FOR EACH ROW EXECUTE FUNCTION public.enqueue_one_attempt_email();

CREATE OR REPLACE FUNCTION public.fence_one_attempt_email_preference() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    UPDATE one_attempt_email_outbox SET status='suppressed'
      WHERE user_id=OLD.user_id AND status='pending';
    RETURN OLD;
  END IF;
  UPDATE one_attempt_email_outbox SET status='suppressed'
    WHERE user_id=NEW.user_id AND status='pending'
      AND (NOT NEW.enabled OR permission_generation<>NEW.generation
        OR permission_revision<>NEW.revision OR recipient_hash IS DISTINCT FROM NEW.email_hash);
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS one_attempt_email_preference_fence ON one_attempt_email_preferences;
CREATE TRIGGER one_attempt_email_preference_fence AFTER UPDATE OR DELETE ON one_attempt_email_preferences
  FOR EACH ROW EXECUTE FUNCTION public.fence_one_attempt_email_preference();

CREATE OR REPLACE FUNCTION public.reset_one_attempt_email() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.generation IS DISTINCT FROM OLD.generation THEN
    UPDATE one_attempt_email_preferences SET enabled=FALSE,revision=revision+1,chosen_at=NOW()
      WHERE user_id=NEW.user_id;
    DELETE FROM one_attempt_email_outbox WHERE user_id=NEW.user_id;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS one_attempt_email_reset ON one_product_activity_epochs;
CREATE TRIGGER one_attempt_email_reset AFTER UPDATE OF generation ON one_product_activity_epochs
  FOR EACH ROW EXECUTE FUNCTION public.reset_one_attempt_email();

CREATE OR REPLACE FUNCTION public.erase_one_attempt_email() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.cleanup_intent_kind='phone_orphan' THEN RETURN NEW; END IF;
  DELETE FROM one_attempt_email_outbox WHERE user_id IN
    (SELECT user_id FROM one_attempt_email_preferences WHERE user_hash=NEW.user_id_hash);
  DELETE FROM one_attempt_email_preferences WHERE user_hash=NEW.user_id_hash;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS one_attempt_email_erasure ON account_deletion_tombstones;
CREATE TRIGGER one_attempt_email_erasure AFTER INSERT ON account_deletion_tombstones
  FOR EACH ROW EXECUTE FUNCTION public.erase_one_attempt_email();

ALTER TABLE one_attempt_email_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE one_attempt_email_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON one_attempt_email_preferences,one_attempt_email_outbox FROM PUBLIC;
DO $$ DECLARE role_name TEXT; BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON one_attempt_email_preferences,one_attempt_email_outbox FROM %I',role_name);
    END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON one_attempt_email_preferences,one_attempt_email_outbox TO service_role;
  END IF;
  PERFORM public.install_account_deletion_write_guards();
END $$;
COMMENT ON TABLE one_attempt_email_preferences IS
  'Explicit optional attempt-email preference, separate from marketing; verified email hash and current activity epoch. Reset requires a new choice. No raw address, body, prompt or tool result.';
COMMENT ON TABLE one_attempt_email_outbox IS
  'Atomic accepted-client-terminal outbox with permanent per-epoch attempt deduplication. Pending rows expire after 24h; ambiguous provider submissions never retry. Account reset/deletion erases rows. Not complete agent-capture evidence. A future managed queue must retain this SQL dedup and claim authority.';
COMMIT;
