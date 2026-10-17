BEGIN;

-- One-time owner discovery handoff. Public evidence is revisioned separately
-- from the owner's encrypted PKM; this job row is workflow state only.
ALTER TABLE feed_events DROP CONSTRAINT IF EXISTS feed_events_source_domain_check;
ALTER TABLE feed_events
  ADD CONSTRAINT feed_events_source_domain_check CHECK (source_domain IN (
    'consent', 'location', 'kai', 'kyc', 'connected_systems', 'connections',
    'profile_discovery'
  ));

CREATE TABLE IF NOT EXISTS one_public_profile_entities (
  entity_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name TEXT NOT NULL,
  employer_hint TEXT,
  city_hint TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suppressed')),
  search_document TSVECTOR GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(display_name, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(employer_hint, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(city_hint, '')), 'C')
  ) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS one_public_profile_entities_search_gin
  ON one_public_profile_entities USING GIN(search_document)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS one_public_profile_identity_anchors (
  anchor_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id UUID NOT NULL REFERENCES one_public_profile_entities(entity_id) ON DELETE CASCADE,
  anchor_type TEXT NOT NULL CHECK (anchor_type IN ('profile_url')),
  anchor_hash CHAR(64) NOT NULL,
  canonical_url TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(anchor_type, anchor_hash)
);

CREATE INDEX IF NOT EXISTS one_public_profile_anchor_entity_idx
  ON one_public_profile_identity_anchors(entity_id);

CREATE TABLE IF NOT EXISTS one_public_profile_sources (
  source_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id UUID NOT NULL REFERENCES one_public_profile_entities(entity_id) ON DELETE CASCADE,
  source_url TEXT NOT NULL,
  source_domain TEXT NOT NULL,
  source_fingerprint CHAR(64),
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  observed_at TIMESTAMPTZ,
  cloud_object_uri TEXT,
  UNIQUE(entity_id, source_url)
);

CREATE INDEX IF NOT EXISTS one_public_profile_sources_entity_idx
  ON one_public_profile_sources(entity_id, acquired_at DESC);

CREATE TABLE IF NOT EXISTS one_public_profile_findings (
  finding_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id UUID NOT NULL REFERENCES one_public_profile_entities(entity_id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision > 0),
  category TEXT NOT NULL,
  claim TEXT NOT NULL,
  confidence TEXT CHECK (confidence IS NULL OR confidence IN ('low', 'medium', 'high')),
  support TEXT,
  source_urls TEXT[] NOT NULL DEFAULT '{}',
  observed_at TIMESTAMPTZ,
  model_name TEXT,
  model_version TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(entity_id, revision, claim)
);

CREATE INDEX IF NOT EXISTS one_public_profile_findings_entity_revision_idx
  ON one_public_profile_findings(entity_id, revision, created_at);

CREATE TABLE IF NOT EXISTS one_profile_discovery_jobs (
  job_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL UNIQUE,
  entity_id UUID REFERENCES one_public_profile_entities(entity_id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN (
      'queued', 'scanning', 'needs_details', 'ready', 'failed', 'claimed', 'cancelled'
    )),
  consent_version TEXT NOT NULL,
  consented_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  external_phone_consent BOOLEAN NOT NULL DEFAULT false,
  name_hint TEXT,
  email_hint TEXT,
  public_profile_url TEXT,
  employer_hint TEXT,
  city_hint TEXT,
  scan_id TEXT,
  scan_request_key UUID,
  scan_deadline_at TIMESTAMPTZ,
  profile_revision INTEGER,
  profile_payload JSONB,
  encrypted_draft_ciphertext TEXT,
  encrypted_draft_iv TEXT,
  encrypted_draft_tag TEXT,
  encrypted_draft_algorithm TEXT CHECK (encrypted_draft_algorithm IS NULL OR encrypted_draft_algorithm = 'aes-256-gcm'),
  encrypted_draft_profile_revision INTEGER,
  claim_decision TEXT CHECK (claim_decision IS NULL OR claim_decision IN ('accepted', 'rejected_all')),
  claim_idempotency_key UUID,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 3),
  event_revision INTEGER NOT NULL DEFAULT 0 CHECK (event_revision >= 0),
  lease_id UUID,
  lease_expires_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error_code TEXT CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z_]{1,80}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at TIMESTAMPTZ,
  CHECK ((lease_id IS NULL) = (lease_expires_at IS NULL)),
  CHECK ((status = 'claimed') = (claimed_at IS NOT NULL)),
  CHECK (status <> 'ready' OR (entity_id IS NOT NULL AND profile_revision IS NOT NULL AND profile_payload IS NOT NULL)),
  CHECK ((encrypted_draft_ciphertext IS NULL AND encrypted_draft_iv IS NULL AND encrypted_draft_tag IS NULL AND encrypted_draft_algorithm IS NULL AND encrypted_draft_profile_revision IS NULL)
      OR (encrypted_draft_ciphertext IS NOT NULL AND encrypted_draft_iv IS NOT NULL AND encrypted_draft_tag IS NOT NULL AND encrypted_draft_algorithm = 'aes-256-gcm' AND encrypted_draft_profile_revision = profile_revision)),
  CHECK (encrypted_draft_ciphertext IS NULL OR length(encrypted_draft_ciphertext) <= 262144),
  CHECK (status <> 'claimed' OR claim_decision IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS one_profile_discovery_jobs_due_idx
  ON one_profile_discovery_jobs(next_attempt_at, created_at, job_id)
  WHERE status IN ('queued', 'scanning', 'failed');

CREATE TABLE IF NOT EXISTS one_profile_discovery_events (
  event_id BIGSERIAL PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES one_profile_discovery_jobs(job_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  status TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(job_id, revision)
);

CREATE TABLE IF NOT EXISTS one_profile_discovery_feed_outbox (
  outbox_id BIGSERIAL PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES one_profile_discovery_jobs(job_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_id UUID,
  lease_expires_at TIMESTAMPTZ,
  settled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(job_id, revision),
  CHECK ((lease_id IS NULL) = (lease_expires_at IS NULL))
);

CREATE INDEX IF NOT EXISTS one_profile_discovery_feed_due_idx
  ON one_profile_discovery_feed_outbox(available_at, outbox_id)
  WHERE settled_at IS NULL;

CREATE TABLE IF NOT EXISTS one_profile_discovery_daily_usage (
  usage_date DATE PRIMARY KEY,
  scan_start_requests INTEGER NOT NULL DEFAULT 0 CHECK (scan_start_requests >= 0),
  scan_poll_requests INTEGER NOT NULL DEFAULT 0 CHECK (scan_poll_requests >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Keep the shared evidence pool service-only. No browser role can search it.
ALTER TABLE one_public_profile_entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE one_public_profile_identity_anchors ENABLE ROW LEVEL SECURITY;
ALTER TABLE one_public_profile_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE one_public_profile_findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE one_profile_discovery_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE one_profile_discovery_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE one_profile_discovery_feed_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE one_profile_discovery_daily_usage ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON one_public_profile_entities, one_public_profile_identity_anchors,
  one_public_profile_sources, one_public_profile_findings,
  one_profile_discovery_jobs, one_profile_discovery_events,
  one_profile_discovery_feed_outbox, one_profile_discovery_daily_usage FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON one_public_profile_entities, one_public_profile_identity_anchors,
      one_public_profile_sources, one_public_profile_findings,
      one_profile_discovery_jobs, one_profile_discovery_events,
      one_profile_discovery_feed_outbox, one_profile_discovery_daily_usage FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON one_public_profile_entities, one_public_profile_identity_anchors,
      one_public_profile_sources, one_public_profile_findings,
      one_profile_discovery_jobs, one_profile_discovery_events,
      one_profile_discovery_feed_outbox, one_profile_discovery_daily_usage FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON one_public_profile_entities,
      one_public_profile_identity_anchors, one_public_profile_sources,
      one_public_profile_findings, one_profile_discovery_jobs,
      one_profile_discovery_events, one_profile_discovery_feed_outbox TO service_role;
    GRANT SELECT, INSERT, UPDATE ON one_profile_discovery_daily_usage TO service_role;
    GRANT USAGE, SELECT ON SEQUENCE one_profile_discovery_events_event_id_seq,
      one_profile_discovery_feed_outbox_outbox_id_seq TO service_role;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'install_account_deletion_write_guards') THEN
    PERFORM public.install_account_deletion_write_guards();
  END IF;
END $$;

COMMENT ON TABLE one_public_profile_entities IS
  'Service-only pool of public profile entities. Opaque identity; no login email, phone, owner correction, or claim decision.';
COMMENT ON TABLE one_public_profile_findings IS
  'Revisioned source-linked public findings. Owner edits and claim decisions stay in encrypted PKM and owner workflow state.';
COMMENT ON TABLE one_profile_discovery_jobs IS
  'One owner-scoped public discovery and one-way PKM handoff. A claimed row is terminal and never schedules another scan.';
COMMENT ON TABLE one_profile_discovery_feed_outbox IS
  'Transactional intent to project a closed discovery status into Feed. Contains no findings, URLs, phone, or draft content.';
COMMENT ON TABLE one_profile_discovery_daily_usage IS
  'Daily bounded counts for external discovery acquisition and polling requests; no person identifiers or query content.';

COMMIT;
