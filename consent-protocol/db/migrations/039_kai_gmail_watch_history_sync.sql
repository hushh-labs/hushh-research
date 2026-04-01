ALTER TABLE IF EXISTS kai_gmail_connections
    ADD COLUMN IF NOT EXISTS watch_status TEXT NOT NULL DEFAULT 'unknown',
    ADD COLUMN IF NOT EXISTS watch_expiration_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_watch_renewed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_notification_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS bootstrap_state TEXT NOT NULL DEFAULT 'idle',
    ADD COLUMN IF NOT EXISTS bootstrap_completed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS status_refreshed_at TIMESTAMPTZ;

ALTER TABLE IF EXISTS kai_gmail_connections
    DROP CONSTRAINT IF EXISTS kai_gmail_connections_watch_status_check;

ALTER TABLE IF EXISTS kai_gmail_connections
    ADD CONSTRAINT kai_gmail_connections_watch_status_check
    CHECK (watch_status IN ('unknown', 'active', 'expiring', 'expired', 'failed', 'not_configured'));

ALTER TABLE IF EXISTS kai_gmail_connections
    DROP CONSTRAINT IF EXISTS kai_gmail_connections_bootstrap_state_check;

ALTER TABLE IF EXISTS kai_gmail_connections
    ADD CONSTRAINT kai_gmail_connections_bootstrap_state_check
    CHECK (bootstrap_state IN ('idle', 'queued', 'running', 'completed', 'failed'));

CREATE INDEX IF NOT EXISTS idx_kai_gmail_connections_watch_expiration
    ON kai_gmail_connections(watch_expiration_at DESC);

ALTER TABLE IF EXISTS kai_gmail_sync_runs
    ADD COLUMN IF NOT EXISTS sync_mode TEXT NOT NULL DEFAULT 'manual',
    ADD COLUMN IF NOT EXISTS start_history_id TEXT,
    ADD COLUMN IF NOT EXISTS end_history_id TEXT,
    ADD COLUMN IF NOT EXISTS window_start_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS window_end_at TIMESTAMPTZ;

ALTER TABLE IF EXISTS kai_gmail_sync_runs
    DROP CONSTRAINT IF EXISTS kai_gmail_sync_runs_sync_mode_check;

ALTER TABLE IF EXISTS kai_gmail_sync_runs
    ADD CONSTRAINT kai_gmail_sync_runs_sync_mode_check
    CHECK (sync_mode IN ('bootstrap', 'incremental', 'manual', 'recovery', 'backfill'));
