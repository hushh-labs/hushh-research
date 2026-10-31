-- Durable semantic work survives request/browser/process termination.
BEGIN;
ALTER TABLE pkm_answer_requests ADD COLUMN IF NOT EXISTS resolution_lease_until TIMESTAMPTZ;
ALTER TABLE pkm_answer_requests ADD COLUMN IF NOT EXISTS resolution_attempts INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_pkm_answer_resolution_work ON pkm_answer_requests (created_at)
  WHERE status = 'pending_resolution';
COMMIT;
