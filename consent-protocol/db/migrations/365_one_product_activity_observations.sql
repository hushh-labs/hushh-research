BEGIN;

-- Bounded measurement projection, never an action, consent or reward authority.
-- Epochs survive reset so callbacks from the old account state cannot reappear.
CREATE TABLE IF NOT EXISTS one_product_activity_epochs (
  user_id TEXT PRIMARY KEY REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  generation UUID NOT NULL DEFAULT gen_random_uuid(),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS one_product_activity_observations (
  event_id CHAR(64) PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES one_product_activity_epochs(user_id) ON DELETE CASCADE,
  generation UUID NOT NULL,
  agent_id TEXT NOT NULL CHECK (length(agent_id) BETWEEN 1 AND 128),
  action_id TEXT NOT NULL CHECK (length(action_id) BETWEEN 1 AND 256),
  catalog_revision CHAR(64) NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('client_reported','execution_observed')),
  phase TEXT NOT NULL CHECK (phase IN ('started','returned','failed','cancelled','blocked')),
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '7 days'
);
CREATE INDEX IF NOT EXISTS one_product_activity_owner_time
  ON one_product_activity_observations(user_id,observed_at);
CREATE INDEX IF NOT EXISTS one_product_activity_expiry
  ON one_product_activity_observations(expires_at);

ALTER TABLE one_product_activity_epochs ENABLE ROW LEVEL SECURITY;
ALTER TABLE one_product_activity_observations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON one_product_activity_epochs,one_product_activity_observations FROM PUBLIC;
DO $$ DECLARE role_name TEXT; BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON one_product_activity_epochs,one_product_activity_observations FROM %I',role_name);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON one_product_activity_epochs,one_product_activity_observations TO service_role;
  END IF;
  PERFORM public.install_account_deletion_write_guards();
END $$;

COMMENT ON TABLE one_product_activity_observations IS
  'Production enrolled-pilot metadata-only observations; 500 per owner/day, seven-day TTL. Client reports and execution returns never prove a domain effect. No prompts, arguments, responses, provider IDs, routes or financial/location information.';
COMMIT;
