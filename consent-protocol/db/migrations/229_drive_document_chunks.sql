-- Expand only. Publication and prior-version removal are a single transaction.
-- Runtime rollback keeps these encrypted rows; no destructive down migration.
BEGIN;
CREATE INDEX IF NOT EXISTS connected_documents_expired_jobs_idx
  ON connected_documents(lease_expires_at)
  WHERE status IN ('fetching','parsing','indexing');
CREATE TABLE IF NOT EXISTS document_chunks (
  document_id UUID NOT NULL,
  user_id TEXT NOT NULL,
  index_version TEXT NOT NULL CHECK (index_version ~ '^[0-9a-f]{64}$'),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0 AND ordinal < 128),
  content_envelope JSONB NOT NULL CHECK (jsonb_typeof(content_envelope) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, user_id, index_version, ordinal),
  FOREIGN KEY (document_id, user_id)
    REFERENCES connected_documents(document_id, user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS document_chunks_owner_idx ON document_chunks(user_id, document_id);
COMMENT ON TABLE document_chunks IS
  'Local document processing domain. Text, source ranges and embeddings encrypted together with owner/document/generation/version/ordinal AAD. Never PKM, public search or agent history.';
ALTER TABLE document_chunks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON document_chunks FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON document_chunks FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON document_chunks FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    REVOKE ALL ON document_chunks FROM service_role;
    GRANT SELECT, INSERT, UPDATE, DELETE ON document_chunks TO service_role;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'install_account_deletion_write_guards') THEN
    PERFORM public.install_account_deletion_write_guards();
  END IF;
END $$;
COMMIT;
