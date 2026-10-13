-- Audit trail for the scheduled public investor deck replenisher.
--
-- The replenisher only writes public/official-source discovery inventory into
-- investor_profiles. This table records run-level health without storing
-- private investor contact data or creating fake Hushh users.

CREATE TABLE IF NOT EXISTS marketplace_investor_replenisher_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  target_total INTEGER NOT NULL DEFAULT 100,
  target_showcase INTEGER NOT NULL DEFAULT 50,
  candidate_count INTEGER NOT NULL DEFAULT 0,
  inserted_count INTEGER NOT NULL DEFAULT 0,
  updated_count INTEGER NOT NULL DEFAULT 0,
  suppressed_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  source_errors JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT marketplace_investor_replenisher_runs_status_check
    CHECK (status IN ('started', 'succeeded', 'failed')),
  CONSTRAINT marketplace_investor_replenisher_runs_counts_check
    CHECK (
      target_total >= 0
      AND target_showcase >= 0
      AND candidate_count >= 0
      AND inserted_count >= 0
      AND updated_count >= 0
      AND suppressed_count >= 0
      AND error_count >= 0
    )
);

CREATE INDEX IF NOT EXISTS idx_marketplace_investor_replenisher_runs_started
  ON marketplace_investor_replenisher_runs(started_at DESC);
