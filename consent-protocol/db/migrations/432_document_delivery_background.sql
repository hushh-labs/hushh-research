-- Additive, explicitly consented server-readable copies of the same Drive sale.
-- No checkout, permission, financial denominator or historical-request rewrite.
BEGIN;
ALTER TABLE document_delivery_cleanup ADD COLUMN IF NOT EXISTS held_by_background BOOLEAN NOT NULL DEFAULT FALSE;
CREATE TABLE IF NOT EXISTS document_delivery_background_requests (
 request_id UUID PRIMARY KEY REFERENCES drive_share_requests(request_id) ON DELETE CASCADE,
 version SMALLINT NOT NULL DEFAULT 2 CHECK(version=2),
 connection_generation BIGINT NOT NULL,
 consent_version TEXT NOT NULL CHECK(consent_version='one-server-copy-v2'),
 accepted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 revoked_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS document_delivery_background_files (
 file_ref UUID PRIMARY KEY,
 request_id UUID NOT NULL REFERENCES document_delivery_background_requests(request_id) ON DELETE CASCADE,
 share_id UUID NOT NULL,
 position INTEGER NOT NULL,
 connection_generation BIGINT NOT NULL,
 source_digest TEXT NOT NULL,
 source_envelope JSONB NOT NULL,
 key_envelope JSONB NOT NULL,
 state TEXT NOT NULL DEFAULT 'preparing' CHECK(state IN ('preparing','ready','unavailable','revoked')),
 reason TEXT,
 result_envelope JSONB,
 export_envelope JSONB,
 next_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 lease_id UUID,
 lease_expires_at TIMESTAMPTZ,
 failures SMALLINT NOT NULL DEFAULT 0,
 verification_attempts SMALLINT NOT NULL DEFAULT 0 CHECK(verification_attempts BETWEEN 0 AND 3),
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(request_id,share_id,position)
);
CREATE INDEX IF NOT EXISTS document_delivery_background_due ON document_delivery_background_files(next_at)
 WHERE state='preparing';
CREATE TABLE IF NOT EXISTS document_delivery_background_chunks (
 file_ref UUID NOT NULL REFERENCES document_delivery_background_files(file_ref) ON DELETE CASCADE,
 ordinal INTEGER NOT NULL CHECK(ordinal>=0),
 request_id UUID NOT NULL,
 object_key TEXT NOT NULL UNIQUE,
 bucket_identity TEXT NOT NULL,
 object_generation TEXT,
 descriptor JSONB NOT NULL,
 PRIMARY KEY(file_ref,ordinal)
);
CREATE TABLE IF NOT EXISTS document_delivery_background_activity (
 event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 request_id UUID NOT NULL REFERENCES document_delivery_background_requests(request_id) ON DELETE CASCADE,
 file_ref UUID,
 actor_user_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('preview_requested','download_requested','stream_completed','copy_ready','revoked')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE OR REPLACE FUNCTION retain_background_delivery_objects() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$ BEGIN
 UPDATE document_delivery_cleanup SET status='pending',held_by_background=FALSE,next_attempt_at=clock_timestamp()
 WHERE object_key IN (SELECT object_key FROM document_delivery_background_chunks WHERE file_ref=OLD.file_ref)
 AND status<>'removed';
 RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS background_delivery_cleanup ON document_delivery_background_files;
CREATE TRIGGER background_delivery_cleanup BEFORE DELETE ON document_delivery_background_files
 FOR EACH ROW EXECUTE FUNCTION retain_background_delivery_objects();
DO $$ DECLARE t text; r text; BEGIN
 FOREACH t IN ARRAY ARRAY['document_delivery_background_requests','document_delivery_background_files',
 'document_delivery_background_chunks','document_delivery_background_activity'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON %I FROM PUBLIC',t);
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
   IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN EXECUTE format('REVOKE ALL ON %I FROM %I',t,r); END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
   EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %I TO service_role',t);
  END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_proc WHERE proname='install_account_deletion_write_guards') THEN
  PERFORM public.install_account_deletion_write_guards();
 END IF;
END $$;
COMMIT;
