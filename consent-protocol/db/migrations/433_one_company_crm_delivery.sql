BEGIN;

-- Delivery projection only. The existing product-activity ledger still owns
-- observation admission and meaning. No prompt, value, response or provider body.
CREATE TABLE IF NOT EXISTS one_company_crm_deliveries (
  item_id CHAR(64) PRIMARY KEY,
  owner_user_id TEXT REFERENCES actor_profiles(user_id) ON DELETE SET NULL,
  owner_hash TEXT NOT NULL CHECK (owner_hash ~ '^sha256:[0-9a-f]{64}$'),
  kind TEXT NOT NULL CHECK (kind IN ('contact','summary','activity')),
  generation UUID,
  payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  portal_id TEXT CHECK (portal_id ~ '^[0-9]{1,32}$'),
  remote_contact_id TEXT CHECK (remote_contact_id ~ '^[0-9]{1,64}$'),
  remote_note_id TEXT CHECK (remote_note_id ~ '^[0-9]{1,64}$'),
  owned_email_hash CHAR(64),
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','sending','sent','unknown','cleanup','blocked')),
  cleanup_requested BOOLEAN NOT NULL DEFAULT FALSE,
  remote_outcome_unknown BOOLEAN NOT NULL DEFAULT FALSE,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts>=0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (jsonb_typeof(payload)='object' AND octet_length(payload::text)<=4096),
  CHECK ((payload - ARRAY['agentId','actionId','source','phase','observedAt'])='{}'::JSONB),
  CHECK (owner_user_id IS NOT NULL OR (cleanup_requested AND payload='{}'::JSONB AND generation IS NULL)),
  CHECK (kind<>'activity' OR expires_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS one_company_crm_due
  ON one_company_crm_deliveries(next_attempt_at,item_id) WHERE state<>'sent';
CREATE INDEX IF NOT EXISTS one_company_crm_owner
  ON one_company_crm_deliveries(owner_user_id);
CREATE INDEX IF NOT EXISTS one_company_crm_retention
  ON one_company_crm_deliveries(expires_at) WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS one_company_crm_cursor (
  destination TEXT PRIMARY KEY CHECK (destination='hubspot'),
  owner_cursor TEXT CHECK (length(owner_cursor)<=8192),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO one_company_crm_cursor(destination) VALUES ('hubspot') ON CONFLICT DO NOTHING;

ALTER TABLE one_company_crm_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE one_company_crm_cursor ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON one_company_crm_deliveries,one_company_crm_cursor FROM PUBLIC;
DO $$ DECLARE role_name TEXT; BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON one_company_crm_deliveries,one_company_crm_cursor FROM %I',role_name);
    END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON one_company_crm_deliveries,one_company_crm_cursor TO service_role;
  END IF;
  PERFORM public.install_account_deletion_write_guards();
END $$;
COMMENT ON TABLE one_company_crm_deliveries IS
 'Company HubSpot delivery projection: approved fixed activity metadata for 90 days. Deletion/reset scrubs payload and queues remote cleanup; only opaque receipts survive erasure until provider cleanup is confirmed. No private agent memory or marketing enrollment authority.';
COMMIT;
