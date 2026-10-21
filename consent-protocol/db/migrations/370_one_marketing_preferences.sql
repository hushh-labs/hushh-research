BEGIN;

-- Explicit email permission is operational account metadata, separate from
-- Terms, research notices, writing style and protected-information consent.
CREATE TABLE IF NOT EXISTS one_marketing_preferences (
  user_id TEXT PRIMARY KEY CHECK (char_length(user_id) BETWEEN 1 AND 128),
  user_hash TEXT UNIQUE NOT NULL CHECK (user_hash ~ '^sha256:[0-9a-f]{64}$'),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  frequency TEXT NOT NULL DEFAULT 'weekly' CHECK (frequency IN ('daily','weekly','updates')),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  generation UUID NOT NULL DEFAULT gen_random_uuid(),
  disclosure_version TEXT NOT NULL CHECK (disclosure_version='one-email-updates-v1'),
  email_hash CHAR(64),
  consent_at TIMESTAMPTZ,
  chosen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  surface TEXT NOT NULL CHECK (surface IN ('setup','account','email_link')),
  CHECK (user_hash='sha256:' || encode(digest(user_id,'sha256'),'hex')),
  CHECK (NOT enabled OR (email_hash IS NOT NULL AND email_hash ~ '^[0-9a-f]{64}$' AND consent_at IS NOT NULL))
);

-- One coalesced pending projection per account. Explicit acknowledgement of an
-- exact revision avoids commit-order gaps inherent in a sequence-only cursor.
-- This contains no raw UID, email, phone, name, token or provider payload.
CREATE TABLE IF NOT EXISTS one_marketing_changes (
  user_hash TEXT PRIMARY KEY CHECK (user_hash ~ '^sha256:[0-9a-f]{64}$'),
  revision BIGINT NOT NULL CHECK (revision > 0),
  erased BOOLEAN NOT NULL DEFAULT FALSE,
  pending BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS one_marketing_pending ON one_marketing_changes(updated_at,user_hash) WHERE pending;
CREATE INDEX IF NOT EXISTS one_marketing_reconcile ON one_marketing_changes(updated_at,user_hash)
  WHERE NOT pending AND NOT erased;

CREATE OR REPLACE FUNCTION public.record_one_marketing_change() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    INSERT INTO one_marketing_changes(user_hash,revision,erased)
      VALUES(OLD.user_hash,OLD.revision+1,TRUE)
      ON CONFLICT(user_hash) DO UPDATE SET
        revision=GREATEST(one_marketing_changes.revision+1,EXCLUDED.revision),
        erased=TRUE,pending=TRUE,updated_at=NOW();
    RETURN OLD;
  END IF;
  INSERT INTO one_marketing_changes(user_hash,revision)
    VALUES(NEW.user_hash,NEW.revision)
    ON CONFLICT(user_hash) DO UPDATE SET revision=EXCLUDED.revision,
      pending=TRUE,updated_at=NOW();
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS one_marketing_change ON one_marketing_preferences;
CREATE TRIGGER one_marketing_change AFTER INSERT OR UPDATE OR DELETE
  ON one_marketing_preferences FOR EACH ROW EXECUTE FUNCTION public.record_one_marketing_change();

CREATE OR REPLACE FUNCTION public.erase_one_marketing_preference() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  DELETE FROM one_marketing_preferences WHERE user_hash=NEW.user_id_hash;
  INSERT INTO one_marketing_changes(user_hash,revision,erased)
    VALUES(NEW.user_id_hash,1,TRUE)
    ON CONFLICT(user_hash) DO UPDATE SET revision=one_marketing_changes.revision+1,
      erased=TRUE,pending=TRUE,updated_at=NOW();
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS one_marketing_erasure ON account_deletion_tombstones;
CREATE TRIGGER one_marketing_erasure AFTER INSERT ON account_deletion_tombstones
  FOR EACH ROW EXECUTE FUNCTION public.erase_one_marketing_preference();

ALTER TABLE one_marketing_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE one_marketing_changes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON one_marketing_preferences,one_marketing_changes FROM PUBLIC;
DO $$ DECLARE role_name TEXT; BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON one_marketing_preferences,one_marketing_changes FROM %I',role_name);
    END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON one_marketing_preferences,one_marketing_changes TO service_role;
  END IF;
  PERFORM public.install_account_deletion_write_guards();
END $$;

COMMENT ON TABLE one_marketing_preferences IS
  'Explicit optional email permission tied to a verified address hash. Server-owned choice time and monotonic revision; survives product reset, erased on account deletion. No marketing permission is inferred from registration.';
COMMENT ON TABLE one_marketing_changes IS
  'Coalesced durable subscription projection queue, one hash-only row per account; exact-revision acknowledgement cannot discard a newer change. Erasure hashes retain suppression without raw identity.';
COMMIT;
