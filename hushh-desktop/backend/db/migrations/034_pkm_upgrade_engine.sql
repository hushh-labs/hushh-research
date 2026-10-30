BEGIN;

ALTER TABLE pkm_index
  ADD COLUMN IF NOT EXISTS model_version INTEGER NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS last_upgraded_at TIMESTAMPTZ;

ALTER TABLE pkm_manifests
  ADD COLUMN IF NOT EXISTS domain_contract_version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS readable_summary_version INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS upgraded_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS pkm_upgrade_runs (
  run_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned',
  from_model_version INTEGER NOT NULL DEFAULT 1,
  to_model_version INTEGER NOT NULL DEFAULT 1,
  current_domain TEXT,
  initiated_by TEXT NOT NULL DEFAULT 'unlock_warm',
  resume_count INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_checkpoint_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pkm_upgrade_runs_user
  ON pkm_upgrade_runs(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_pkm_upgrade_runs_status
  ON pkm_upgrade_runs(status, updated_at DESC);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'pkm_upgrade_runs_status_check'
  ) THEN
    ALTER TABLE pkm_upgrade_runs DROP CONSTRAINT pkm_upgrade_runs_status_check;
  END IF;
END $$;

ALTER TABLE pkm_upgrade_runs
  ADD CONSTRAINT pkm_upgrade_runs_status_check
  CHECK (
    status IN (
      'planned',
      'running',
      'awaiting_local_auth_resume',
      'completed',
      'failed',
      'canceled'
    )
  );

CREATE TABLE IF NOT EXISTS pkm_upgrade_steps (
  id BIGSERIAL PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES pkm_upgrade_runs(run_id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  from_domain_contract_version INTEGER NOT NULL DEFAULT 1,
  to_domain_contract_version INTEGER NOT NULL DEFAULT 1,
  from_readable_summary_version INTEGER NOT NULL DEFAULT 0,
  to_readable_summary_version INTEGER NOT NULL DEFAULT 0,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_completed_content_revision INTEGER,
  last_completed_manifest_version INTEGER,
  checkpoint_payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (run_id, domain)
);

CREATE INDEX IF NOT EXISTS idx_pkm_upgrade_steps_run
  ON pkm_upgrade_steps(run_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_pkm_upgrade_steps_status
  ON pkm_upgrade_steps(status, updated_at DESC);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'pkm_upgrade_steps_status_check'
  ) THEN
    ALTER TABLE pkm_upgrade_steps DROP CONSTRAINT pkm_upgrade_steps_status_check;
  END IF;
END $$;

ALTER TABLE pkm_upgrade_steps
  ADD CONSTRAINT pkm_upgrade_steps_status_check
  CHECK (
    status IN (
      'pending',
      'running',
      'completed',
      'conflict_retry',
      'failed'
    )
  );

DROP TRIGGER IF EXISTS trigger_update_pkm_upgrade_runs_timestamp ON pkm_upgrade_runs;
CREATE TRIGGER trigger_update_pkm_upgrade_runs_timestamp
  BEFORE UPDATE ON pkm_upgrade_runs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS trigger_update_pkm_upgrade_steps_timestamp ON pkm_upgrade_steps;
CREATE TRIGGER trigger_update_pkm_upgrade_steps_timestamp
  BEFORE UPDATE ON pkm_upgrade_steps
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMIT;
