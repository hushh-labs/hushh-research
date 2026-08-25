-- Hushh Tech UAT client foundation.
--
-- This migration is additive and contains only short-lived launch state,
-- canonical Firebase-to-legacy account mappings, metadata-only audit events,
-- synthetic UAT shadow records, and importer checkpoints. It never stores a
-- Firebase token, legacy session token, connector private key, owner token,
-- decrypted PKM value, Supabase credential, or production export.
--
-- Postgres is the shared replay/nonce tier today. The launch authorization
-- store is intentionally isolated behind the product service so its one-time
-- code and replay guard can move to Redis/Memorystore without changing the
-- HTTP contract.

BEGIN;

CREATE TABLE IF NOT EXISTS hushh_tech_launch_authorizations (
  authorization_id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  firebase_uid TEXT NOT NULL REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  audience TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  code_challenge_method TEXT NOT NULL DEFAULT 'S256'
    CHECK (code_challenge_method = 'S256'),
  firebase_valid_after_ms BIGINT NOT NULL CHECK (firebase_valid_after_ms >= 0),
  created_at_ms BIGINT NOT NULL CHECK (created_at_ms >= 0),
  expires_at_ms BIGINT NOT NULL CHECK (expires_at_ms > created_at_ms),
  consumed_at_ms BIGINT,
  CHECK (consumed_at_ms IS NULL OR consumed_at_ms >= created_at_ms)
);

CREATE INDEX IF NOT EXISTS idx_hushh_tech_launch_authorizations_expiry
  ON hushh_tech_launch_authorizations (expires_at_ms)
  WHERE consumed_at_ms IS NULL;

CREATE INDEX IF NOT EXISTS idx_hushh_tech_launch_authorizations_uid
  ON hushh_tech_launch_authorizations (firebase_uid, created_at_ms DESC);

CREATE TABLE IF NOT EXISTS hushh_tech_account_links (
  link_id TEXT PRIMARY KEY,
  legacy_project TEXT NOT NULL
    CHECK (legacy_project = 'hushh-tech-uat-synthetic'),
  legacy_user_uuid TEXT NOT NULL,
  firebase_uid TEXT NOT NULL REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  linked_at_ms BIGINT NOT NULL CHECK (linked_at_ms >= 0),
  revoked_at_ms BIGINT,
  created_by_app_id TEXT NOT NULL,
  provenance JSONB NOT NULL DEFAULT '{}'::JSONB
    CHECK (jsonb_typeof(provenance) = 'object'),
  CHECK (
    (status = 'active' AND revoked_at_ms IS NULL)
    OR (status = 'revoked' AND revoked_at_ms IS NOT NULL AND revoked_at_ms >= linked_at_ms)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_hushh_tech_account_links_active_legacy
  ON hushh_tech_account_links (legacy_project, legacy_user_uuid)
  WHERE status = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS idx_hushh_tech_account_links_active_firebase
  ON hushh_tech_account_links (legacy_project, firebase_uid)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_hushh_tech_account_links_firebase_history
  ON hushh_tech_account_links (firebase_uid, linked_at_ms DESC);

CREATE TABLE IF NOT EXISTS hushh_tech_link_events (
  event_id TEXT PRIMARY KEY,
  -- Audit provenance is intentionally not foreign-keyed. ON DELETE SET NULL
  -- would rewrite history and would also conflict with the append-only trigger
  -- below. Parent account/actor teardown therefore leaves the original event
  -- evidence intact until the approved UAT audit-retention process runs.
  link_id TEXT,
  firebase_uid TEXT NOT NULL,
  legacy_project TEXT NOT NULL
    CHECK (legacy_project = 'hushh-tech-uat-synthetic'),
  legacy_user_uuid TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (
    event_type IN (
      'attempted',
      'relink_attempt',
      'activated',
      'conflict',
      'revoked',
      'recovery_attempted',
      'recovered',
      'migration_imported'
    )
  ),
  app_id TEXT NOT NULL,
  proof_session_id TEXT UNIQUE
    CHECK (proof_session_id IS NULL OR proof_session_id ~ '^[A-Za-z0-9_-]{16,128}$'),
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB
    CHECK (jsonb_typeof(metadata) = 'object'),
  created_at_ms BIGINT NOT NULL CHECK (created_at_ms >= 0)
);

CREATE INDEX IF NOT EXISTS idx_hushh_tech_link_events_firebase
  ON hushh_tech_link_events (firebase_uid, created_at_ms DESC);

CREATE INDEX IF NOT EXISTS idx_hushh_tech_link_events_legacy
  ON hushh_tech_link_events (legacy_project, legacy_user_uuid, created_at_ms DESC);

CREATE OR REPLACE FUNCTION hushh_tech_link_events_enforce_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'hushh_tech_link_events is append-only; % is not allowed', TG_OP
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS hushh_tech_link_events_enforce_append_only
  ON hushh_tech_link_events;

CREATE TRIGGER hushh_tech_link_events_enforce_append_only
  BEFORE UPDATE OR DELETE ON hushh_tech_link_events
  FOR EACH ROW
  EXECUTE FUNCTION hushh_tech_link_events_enforce_append_only();

CREATE TABLE IF NOT EXISTS hushh_tech_shadow_records (
  record_id TEXT PRIMARY KEY,
  legacy_project TEXT NOT NULL
    CHECK (legacy_project = 'hushh-tech-uat-synthetic'),
  legacy_user_uuid TEXT NOT NULL,
  record_type TEXT NOT NULL CHECK (
    record_type IN (
      'profile',
      'onboarding',
      'access_state',
      'report_asset'
    )
  ),
  payload JSONB NOT NULL DEFAULT '{}'::JSONB
    CHECK (jsonb_typeof(payload) = 'object'),
  source_hash TEXT NOT NULL CHECK (source_hash ~ '^[0-9a-f]{64}$'),
  source_deleted BOOLEAN NOT NULL DEFAULT FALSE,
  imported_at_ms BIGINT NOT NULL CHECK (imported_at_ms >= 0),
  updated_at_ms BIGINT NOT NULL CHECK (updated_at_ms >= 0),
  UNIQUE (legacy_project, legacy_user_uuid, record_type)
);

CREATE INDEX IF NOT EXISTS idx_hushh_tech_shadow_records_source_state
  ON hushh_tech_shadow_records (legacy_project, source_deleted, updated_at_ms DESC);

CREATE TABLE IF NOT EXISTS hushh_tech_migration_runs (
  run_id TEXT PRIMARY KEY,
  fixture_name TEXT NOT NULL UNIQUE,
  fixture_hash TEXT NOT NULL CHECK (fixture_hash ~ '^[0-9a-f]{64}$'),
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'completed', 'failed')),
  record_count INTEGER NOT NULL CHECK (record_count >= 0),
  applied_count INTEGER NOT NULL DEFAULT 0 CHECK (applied_count >= 0),
  skipped_count INTEGER NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),
  checkpoint_sequence INTEGER NOT NULL DEFAULT 0 CHECK (checkpoint_sequence >= 0),
  started_at_ms BIGINT NOT NULL CHECK (started_at_ms >= 0),
  completed_at_ms BIGINT,
  updated_at_ms BIGINT NOT NULL CHECK (updated_at_ms >= 0),
  error_code TEXT,
  CHECK (checkpoint_sequence <= record_count),
  CHECK (applied_count + skipped_count <= checkpoint_sequence),
  CHECK (
    (status = 'completed' AND completed_at_ms IS NOT NULL
      AND checkpoint_sequence = record_count
      AND applied_count + skipped_count = record_count)
    OR (status IN ('running', 'failed'))
  )
);

CREATE INDEX IF NOT EXISTS idx_hushh_tech_migration_runs_status
  ON hushh_tech_migration_runs (status, updated_at_ms DESC);

CREATE TABLE IF NOT EXISTS hushh_tech_migration_events (
  event_id TEXT PRIMARY KEY,
  -- Import evidence must survive migration-run cleanup unchanged, so this
  -- ledger deliberately has no foreign key back to the mutable checkpoint.
  run_id TEXT NOT NULL,
  fixture_hash TEXT NOT NULL CHECK (fixture_hash ~ '^[0-9a-f]{64}$'),
  phase TEXT NOT NULL CHECK (phase IN ('start', 'record', 'terminal')),
  outcome TEXT NOT NULL CHECK (
    outcome IN ('started', 'applied', 'skipped', 'failed', 'completed')
  ),
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  event_at_ms BIGINT NOT NULL CHECK (event_at_ms >= 0),
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB
    CHECK (jsonb_typeof(metadata) = 'object')
    CHECK (octet_length(metadata::TEXT) <= 2048),
  CHECK (
    (phase = 'start' AND outcome = 'started' AND sequence = 0)
    OR (phase = 'record' AND outcome IN ('applied', 'skipped') AND sequence > 0)
    OR (phase = 'terminal' AND outcome IN ('failed', 'completed'))
  )
);

CREATE INDEX IF NOT EXISTS idx_hushh_tech_migration_events_run
  ON hushh_tech_migration_events (run_id, event_at_ms, sequence);

CREATE OR REPLACE FUNCTION hushh_tech_migration_events_enforce_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'hushh_tech_migration_events is append-only; % is not allowed', TG_OP
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS hushh_tech_migration_events_enforce_append_only
  ON hushh_tech_migration_events;

CREATE TRIGGER hushh_tech_migration_events_enforce_append_only
  BEFORE UPDATE OR DELETE ON hushh_tech_migration_events
  FOR EACH ROW
  EXECUTE FUNCTION hushh_tech_migration_events_enforce_append_only();

COMMENT ON TABLE hushh_tech_launch_authorizations IS
  'Short-lived Hushh Tech UAT PKCE launch codes. Hashes and metadata only; no bearer or refresh tokens.';
COMMENT ON TABLE hushh_tech_account_links IS
  'Current Firebase UID to legacy Hushh Tech UUID mapping. Legacy UUID is provenance, never identity authority.';
COMMENT ON TABLE hushh_tech_link_events IS
  'Append-only metadata audit for Hushh Tech link attempts, conflicts, activation, recovery, and revocation. UPDATE and DELETE are rejected by a database trigger.';
COMMENT ON TABLE hushh_tech_shadow_records IS
  'Synthetic UAT product metadata imported from checked-in fixtures. Never production Supabase information or PKM plaintext.';
COMMENT ON TABLE hushh_tech_migration_runs IS
  'Checksummed synthetic-fixture import checkpoints supporting interrupted-run recovery and deterministic replay.';
COMMENT ON TABLE hushh_tech_migration_events IS
  'Append-only synthetic-import evidence for run start, transactional record outcomes, failure, and completion. UPDATE and DELETE are rejected by a database trigger.';

COMMIT;
