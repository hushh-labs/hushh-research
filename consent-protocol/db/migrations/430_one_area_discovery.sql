-- Area opt-in is separate from name discovery and device-location sharing.
BEGIN;
CREATE TABLE IF NOT EXISTS one_area_discovery_preferences (
  user_id TEXT PRIMARY KEY REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  postal_code TEXT,
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  consent_version TEXT NOT NULL CHECK (consent_version='one-area-discovery-v1'),
  adult_self_attested_at TIMESTAMPTZ,
  consent_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((enabled AND postal_code ~ '^[0-9]{5}$' AND postal_code IS NOT NULL
          AND adult_self_attested_at IS NOT NULL AND consent_at IS NOT NULL)
      OR (NOT enabled AND postal_code IS NULL AND adult_self_attested_at IS NULL AND consent_at IS NULL))
);
CREATE INDEX IF NOT EXISTS one_area_discovery_postal ON one_area_discovery_preferences(postal_code,user_id) WHERE enabled;
CREATE TABLE IF NOT EXISTS one_area_discovery_search_budgets (
  user_id TEXT NOT NULL REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  bucket_date DATE NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC')::date,
  searches INTEGER NOT NULL DEFAULT 1 CHECK (searches BETWEEN 1 AND 30),
  PRIMARY KEY(user_id,bucket_date)
);
CREATE OR REPLACE FUNCTION public.erase_one_area_discovery() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF NEW.cleanup_intent_kind='phone_orphan' THEN RETURN NEW; END IF;
  DELETE FROM one_area_discovery_preferences WHERE 'sha256:' || encode(digest(user_id,'sha256'),'hex')=NEW.user_id_hash;
  DELETE FROM one_area_discovery_search_budgets WHERE 'sha256:' || encode(digest(user_id,'sha256'),'hex')=NEW.user_id_hash;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS one_area_discovery_erasure ON account_deletion_tombstones;
CREATE TRIGGER one_area_discovery_erasure AFTER INSERT ON account_deletion_tombstones
  FOR EACH ROW EXECUTE FUNCTION public.erase_one_area_discovery();
ALTER TABLE one_area_discovery_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE one_area_discovery_search_budgets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON one_area_discovery_preferences,one_area_discovery_search_budgets FROM PUBLIC;
DO $$ DECLARE role_name TEXT; BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON one_area_discovery_preferences,one_area_discovery_search_budgets FROM %I',role_name);
    END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON one_area_discovery_preferences,one_area_discovery_search_budgets TO service_role;
  END IF;
  PERFORM public.install_account_deletion_write_guards();
END $$;
COMMENT ON TABLE one_area_discovery_preferences IS 'Explicit coarse US postal-area consent; adult status is self-declared, never verified. Off deletes ZIP and consent/attestation timestamps. No GPS, DOB, address or private memory.';
COMMENT ON TABLE one_area_discovery_search_budgets IS 'Cross-instance daily search budget, one row per searching account/day. Expired rows pruned on that account search; no search terms or results.';
COMMIT;
