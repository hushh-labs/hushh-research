-- Private reusable evidence, never an implicit listing or sharing grant.
BEGIN;
CREATE TABLE IF NOT EXISTS drive_document_facts (
  document_id UUID NOT NULL,
  user_id TEXT NOT NULL,
  connection_generation BIGINT NOT NULL,
  source_version TEXT NOT NULL,
  extraction_profile TEXT NOT NULL,
  extraction_version TEXT NOT NULL,
  facts_profile TEXT NOT NULL,
  facts_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','complete','failed')),
  after_page INTEGER NOT NULL DEFAULT 0 CHECK (after_page>=0),
  facts_envelope JSONB,
  has_gaps BOOLEAN NOT NULL DEFAULT FALSE,
  lease_id UUID,
  lease_expires_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts>=0),
  next_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  completed_at TIMESTAMPTZ,
  PRIMARY KEY(document_id,source_version,extraction_profile,facts_profile),
  UNIQUE(document_id,facts_version),
  FOREIGN KEY(document_id,user_id) REFERENCES connected_documents(document_id,user_id) ON DELETE CASCADE,
  CHECK ((lease_id IS NULL)=(lease_expires_at IS NULL)),
  CHECK(facts_envelope IS NULL OR jsonb_typeof(facts_envelope)='object')
);
CREATE INDEX IF NOT EXISTS drive_document_facts_due ON drive_document_facts(next_at,user_id)
  WHERE status IN ('pending','running');
CREATE TABLE IF NOT EXISTS drive_document_fact_pages (
  document_id UUID NOT NULL,
  user_id TEXT NOT NULL,
  source_version TEXT NOT NULL,
  extraction_profile TEXT NOT NULL,
  facts_profile TEXT NOT NULL,
  first_page INTEGER NOT NULL CHECK(first_page>0),
  last_page INTEGER NOT NULL CHECK(last_page>=first_page),
  evidence_envelope JSONB NOT NULL CHECK(jsonb_typeof(evidence_envelope)='object'),
  PRIMARY KEY(document_id,source_version,extraction_profile,facts_profile,first_page),
  FOREIGN KEY(document_id,source_version,extraction_profile,facts_profile)
    REFERENCES drive_document_facts(document_id,source_version,extraction_profile,facts_profile) ON DELETE CASCADE,
  FOREIGN KEY(document_id,user_id) REFERENCES connected_documents(document_id,user_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS drive_packet_heads (
  packet_id UUID PRIMARY KEY,
  user_id TEXT NOT NULL,
  connector_id TEXT NOT NULL DEFAULT 'google_drive' CHECK(connector_id='google_drive'),
  connection_generation BIGINT NOT NULL,
  key_fingerprint TEXT NOT NULL,
  key_envelope JSONB NOT NULL CHECK(jsonb_typeof(key_envelope)='object'),
  revision BIGINT NOT NULL DEFAULT 1,
  current_version BIGINT NOT NULL DEFAULT 0,
  dirty BOOLEAN NOT NULL DEFAULT TRUE,
  awaiting_collection BOOLEAN NOT NULL DEFAULT FALSE,
  lease_id UUID,
  lease_expires_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  error_code TEXT,
  build_envelope JSONB,
  after_document_id UUID,
  build_phase TEXT NOT NULL DEFAULT 'construct' CHECK(build_phase IN ('construct','verify','finalize')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(user_id,connection_generation,key_fingerprint),
  UNIQUE(packet_id,user_id),
  FOREIGN KEY(user_id,connector_id) REFERENCES user_external_connector_connections(user_id,connector_id) ON DELETE CASCADE,
  CHECK((lease_id IS NULL)=(lease_expires_at IS NULL))
);
CREATE INDEX IF NOT EXISTS drive_packet_build_due ON drive_packet_heads(next_at,user_id) WHERE dirty;
CREATE TABLE IF NOT EXISTS drive_packet_members (
  packet_id UUID NOT NULL REFERENCES drive_packet_heads(packet_id) ON DELETE CASCADE,
  document_id UUID NOT NULL,
  facts_version TEXT NOT NULL,
  PRIMARY KEY(packet_id,document_id),
  FOREIGN KEY(document_id,facts_version) REFERENCES drive_document_facts(document_id,facts_version) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS drive_packet_versions (
  packet_id UUID NOT NULL REFERENCES drive_packet_heads(packet_id) ON DELETE CASCADE,
  version BIGINT NOT NULL CHECK(version>0),
  user_id TEXT NOT NULL,
  connection_generation BIGINT NOT NULL,
  digest TEXT NOT NULL,
  manifest_envelope JSONB NOT NULL CHECK(jsonb_typeof(manifest_envelope)='object'),
  state TEXT NOT NULL CHECK(state IN ('ready','incomplete','unable_to_verify')),
  available BOOLEAN NOT NULL DEFAULT FALSE,
  document_count INTEGER NOT NULL CHECK(document_count>=0),
  price_cents INTEGER NOT NULL CHECK(price_cents BETWEEN 50 AND 50000),
  policy_version TEXT NOT NULL,
  verified_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(packet_id,version),
  FOREIGN KEY(packet_id,user_id) REFERENCES drive_packet_heads(packet_id,user_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS drive_packet_version_sources (
  packet_id UUID NOT NULL,
  version BIGINT NOT NULL,
  document_id UUID NOT NULL,
  source_version TEXT NOT NULL,
  facts_version TEXT NOT NULL,
  PRIMARY KEY(packet_id,version,document_id),
  FOREIGN KEY(packet_id,version) REFERENCES drive_packet_versions(packet_id,version) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS drive_packet_source_invalidation ON drive_packet_version_sources(document_id);
ALTER TABLE drive_share_requests
  ADD COLUMN IF NOT EXISTS reusable_packet_id UUID,
  ADD COLUMN IF NOT EXISTS reusable_packet_version BIGINT;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='drive_share_request_packet_version_fk' AND conrelid='drive_share_requests'::regclass) THEN
  ALTER TABLE drive_share_requests ADD CONSTRAINT drive_share_request_packet_version_fk
    FOREIGN KEY(reusable_packet_id,reusable_packet_version) REFERENCES drive_packet_versions(packet_id,version) ON DELETE SET NULL;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='drive_share_request_packet_pair_check' AND conrelid='drive_share_requests'::regclass) THEN
  ALTER TABLE drive_share_requests ADD CONSTRAINT drive_share_request_packet_pair_check
    CHECK((reusable_packet_id IS NULL)=(reusable_packet_version IS NULL));
 END IF;
END $$;
CREATE INDEX IF NOT EXISTS drive_share_request_packet_reuse
  ON drive_share_requests(user_id,recipient_user_id,reusable_packet_id,reusable_packet_version)
  WHERE reusable_packet_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS drive_packet_listings (
  packet_id UUID NOT NULL,
  version BIGINT NOT NULL,
  user_id TEXT NOT NULL,
  audience TEXT NOT NULL CHECK(audience='connections'),
  revision BIGINT NOT NULL DEFAULT 1,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  price_cents INTEGER NOT NULL CHECK(price_cents BETWEEN 50 AND 50000),
  disclosure TEXT NOT NULL CHECK(disclosure='drive-packet-listing-connections-v1'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(packet_id,version),
  FOREIGN KEY(packet_id,version) REFERENCES drive_packet_versions(packet_id,version) ON DELETE CASCADE,
  FOREIGN KEY(packet_id,user_id) REFERENCES drive_packet_heads(packet_id,user_id) ON DELETE CASCADE
);
COMMENT ON TABLE drive_packet_listings IS 'Owner-approved summary visibility only. Each buyer still requires exact-version owner approval through the existing Drive request purchase workflow.';
CREATE OR REPLACE FUNCTION invalidate_drive_packet_sources()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.source_version IS NOT DISTINCT FROM OLD.source_version
      AND NEW.active_version IS NOT DISTINCT FROM OLD.active_version
      AND NOT (NEW.last_error_code IS NOT DISTINCT FROM 'source_unavailable' AND OLD.last_error_code IS DISTINCT FROM NEW.last_error_code)
      THEN RETURN NEW; END IF;
  END IF;
  UPDATE drive_packet_heads SET dirty=TRUE,revision=revision+1,next_at=clock_timestamp(),
    lease_id=NULL,lease_expires_at=NULL,attempts=0,build_envelope=NULL,
    after_document_id=NULL,build_phase='construct',updated_at=clock_timestamp()
    WHERE packet_id IN (SELECT packet_id FROM drive_packet_members WHERE document_id=OLD.document_id);
  UPDATE drive_packet_versions SET available=FALSE WHERE (packet_id,version) IN
    (SELECT packet_id,version FROM drive_packet_version_sources WHERE document_id=OLD.document_id);
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='drive_packet_source_invalidation' AND tgrelid='connected_documents'::regclass) THEN
   CREATE TRIGGER drive_packet_source_invalidation BEFORE UPDATE OF source_version,active_version,status OR DELETE
     ON connected_documents FOR EACH ROW EXECUTE FUNCTION invalidate_drive_packet_sources();
 END IF;
END $$;
DO $$ DECLARE t TEXT; BEGIN
 FOREACH t IN ARRAY ARRAY['drive_document_facts','drive_document_fact_pages','drive_packet_heads',
   'drive_packet_members','drive_packet_versions','drive_packet_version_sources','drive_packet_listings'] LOOP
   EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
   EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',t);
   IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN EXECUTE format('REVOKE ALL ON %I FROM anon',t); END IF;
   IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN EXECUTE format('REVOKE ALL ON %I FROM authenticated',t); END IF;
   IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
     EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO service_role',t);
   END IF;
 END LOOP;
 IF to_regprocedure('install_account_deletion_write_guards()') IS NOT NULL THEN
   PERFORM install_account_deletion_write_guards();
 END IF;
END $$;
COMMIT;
