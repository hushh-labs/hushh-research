-- Bounded retries for consented, tool-less suggestion preparation; no new authority.
BEGIN;
ALTER TABLE drive_share_requests
  ADD COLUMN IF NOT EXISTS preparation_attempts INTEGER NOT NULL DEFAULT 0
    CHECK (preparation_attempts BETWEEN 0 AND 3),
  ADD COLUMN IF NOT EXISTS preparation_next_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  ADD COLUMN IF NOT EXISTS preparation_inspected_at TIMESTAMPTZ NOT NULL DEFAULT 'epoch',
  ADD COLUMN IF NOT EXISTS preparation_error_code TEXT
    CHECK (preparation_error_code ~ '^[a-z_]{1,80}$');
ALTER TABLE drive_share_permission_operations
  ADD COLUMN IF NOT EXISTS worker_inspected_at TIMESTAMPTZ NOT NULL DEFAULT 'epoch';
COMMIT;
