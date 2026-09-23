-- Expand only. Google selection is not consent for unattended processing.
BEGIN;
ALTER TABLE connected_documents
  ADD COLUMN IF NOT EXISTS processing_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS processing_disclosure_version TEXT,
  ADD COLUMN IF NOT EXISTS processing_accepted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS processing_revision BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_checked_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS connected_documents_processing_due_idx
  ON connected_documents(next_attempt_at, user_id)
  WHERE processing_enabled;
COMMENT ON COLUMN connected_documents.processing_revision IS
  'Monotonic consent revision, fenced with generation and job lease. Legacy rows never opt in automatically.';
COMMIT;
