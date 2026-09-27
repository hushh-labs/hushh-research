-- Replay guards. Every deploy re-applies this file. ADD COLUMN IF NOT EXISTS,
-- DROP/ADD CONSTRAINT and CREATE INDEX IF NOT EXISTS all lock the table
-- (ACCESS EXCLUSIVE, or SHARE for the index) before they discover there is
-- nothing to do, and the constraint re-add also re-scans every row. Each
-- statement below is skipped only when the catalog proves its effect is
-- already in place; otherwise the original statement runs unchanged.

DO $$
BEGIN
  IF (
    SELECT count(*)
    FROM pg_attribute
    WHERE attrelid = to_regclass('kai_gmail_connections')
      AND attname IN (
        'watch_status',
        'watch_expiration_at',
        'last_watch_renewed_at',
        'last_notification_at',
        'bootstrap_state',
        'bootstrap_completed_at',
        'status_refreshed_at'
      )
      AND attnum > 0
      AND NOT attisdropped
  ) < 7 THEN
    ALTER TABLE IF EXISTS kai_gmail_connections
        ADD COLUMN IF NOT EXISTS watch_status TEXT NOT NULL DEFAULT 'unknown',
        ADD COLUMN IF NOT EXISTS watch_expiration_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS last_watch_renewed_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS last_notification_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS bootstrap_state TEXT NOT NULL DEFAULT 'idle',
        ADD COLUMN IF NOT EXISTS bootstrap_completed_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS status_refreshed_at TIMESTAMPTZ;
  END IF;
END
$$;

-- pg_get_constraintdef() also prints NOT VALID and NO INHERIT, so an exact
-- match means the constraint is the one the ADD below would create, validated.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = to_regclass('kai_gmail_connections')
      AND conname = 'kai_gmail_connections_watch_status_check'
      AND contype = 'c'
      AND pg_get_constraintdef(oid) =
        'CHECK ((watch_status = ANY (ARRAY[''unknown''::text, ''active''::text, '
        '''expiring''::text, ''expired''::text, ''failed''::text, '
        '''not_configured''::text])))'
  ) THEN
    ALTER TABLE IF EXISTS kai_gmail_connections
        DROP CONSTRAINT IF EXISTS kai_gmail_connections_watch_status_check;

    ALTER TABLE IF EXISTS kai_gmail_connections
        ADD CONSTRAINT kai_gmail_connections_watch_status_check
        CHECK (watch_status IN ('unknown', 'active', 'expiring', 'expired', 'failed', 'not_configured'));
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = to_regclass('kai_gmail_connections')
      AND conname = 'kai_gmail_connections_bootstrap_state_check'
      AND contype = 'c'
      AND pg_get_constraintdef(oid) =
        'CHECK ((bootstrap_state = ANY (ARRAY[''idle''::text, ''queued''::text, '
        '''running''::text, ''completed''::text, ''failed''::text])))'
  ) THEN
    ALTER TABLE IF EXISTS kai_gmail_connections
        DROP CONSTRAINT IF EXISTS kai_gmail_connections_bootstrap_state_check;

    ALTER TABLE IF EXISTS kai_gmail_connections
        ADD CONSTRAINT kai_gmail_connections_bootstrap_state_check
        CHECK (bootstrap_state IN ('idle', 'queued', 'running', 'completed', 'failed'));
  END IF;
END
$$;

-- CREATE INDEX IF NOT EXISTS skips on any relation of that name in the
-- table's schema, so that is exactly what this checks.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_class AS idx
    JOIN pg_class AS tbl
      ON tbl.relnamespace = idx.relnamespace
    WHERE tbl.oid = to_regclass('kai_gmail_connections')
      AND idx.relname = 'idx_kai_gmail_connections_watch_expiration'
  ) THEN
    CREATE INDEX IF NOT EXISTS idx_kai_gmail_connections_watch_expiration
        ON kai_gmail_connections(watch_expiration_at DESC);
  END IF;
END
$$;

DO $$
BEGIN
  IF (
    SELECT count(*)
    FROM pg_attribute
    WHERE attrelid = to_regclass('kai_gmail_sync_runs')
      AND attname IN (
        'sync_mode',
        'start_history_id',
        'end_history_id',
        'window_start_at',
        'window_end_at'
      )
      AND attnum > 0
      AND NOT attisdropped
  ) < 5 THEN
    ALTER TABLE IF EXISTS kai_gmail_sync_runs
        ADD COLUMN IF NOT EXISTS sync_mode TEXT NOT NULL DEFAULT 'manual',
        ADD COLUMN IF NOT EXISTS start_history_id TEXT,
        ADD COLUMN IF NOT EXISTS end_history_id TEXT,
        ADD COLUMN IF NOT EXISTS window_start_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS window_end_at TIMESTAMPTZ;
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = to_regclass('kai_gmail_sync_runs')
      AND conname = 'kai_gmail_sync_runs_sync_mode_check'
      AND contype = 'c'
      AND pg_get_constraintdef(oid) =
        'CHECK ((sync_mode = ANY (ARRAY[''bootstrap''::text, ''incremental''::text, '
        '''manual''::text, ''recovery''::text, ''backfill''::text])))'
  ) THEN
    ALTER TABLE IF EXISTS kai_gmail_sync_runs
        DROP CONSTRAINT IF EXISTS kai_gmail_sync_runs_sync_mode_check;

    ALTER TABLE IF EXISTS kai_gmail_sync_runs
        ADD CONSTRAINT kai_gmail_sync_runs_sync_mode_check
        CHECK (sync_mode IN ('bootstrap', 'incremental', 'manual', 'recovery', 'backfill'));
  END IF;
END
$$;
