-- Explicit owner publication of scalar financial summaries; no file access.
BEGIN;
ALTER TABLE drive_packet_heads
 ADD COLUMN IF NOT EXISTS public_summary_enabled BOOLEAN NOT NULL DEFAULT FALSE,
 ADD COLUMN IF NOT EXISTS public_summary_revision BIGINT NOT NULL DEFAULT 0,
 ADD COLUMN IF NOT EXISTS public_summary_version BIGINT,
 ADD COLUMN IF NOT EXISTS public_summary_generation BIGINT,
 ADD COLUMN IF NOT EXISTS public_summary_disclosure TEXT,
 ADD COLUMN IF NOT EXISTS public_summary_accepted_at TIMESTAMPTZ,
 ADD COLUMN IF NOT EXISTS preview_document_count INTEGER,
 ADD COLUMN IF NOT EXISTS preview_complete BOOLEAN NOT NULL DEFAULT FALSE,
 ADD COLUMN IF NOT EXISTS preview_updated_at TIMESTAMPTZ;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='drive_packet_heads'::regclass AND conname='drive_packet_public_summary_policy') THEN
 ALTER TABLE drive_packet_heads ADD CONSTRAINT drive_packet_public_summary_policy CHECK (
 public_summary_revision>=0 AND (public_summary_version IS NULL OR public_summary_version>=0)
 AND (preview_document_count IS NULL OR preview_document_count BETWEEN 0 AND 10000)
 AND (NOT public_summary_enabled OR (packet_kind='provider_discovery' AND category='financial'
 AND public_summary_version IS NOT NULL AND public_summary_generation IS NOT NULL
 AND public_summary_disclosure IS NOT NULL AND public_summary_generation=connection_generation
 AND public_summary_disclosure='drive-packet-public-summary-v1' AND public_summary_accepted_at IS NOT NULL)));
 END IF;
END $$;
CREATE INDEX IF NOT EXISTS drive_packet_public_summary_owner ON drive_packet_heads(user_id,packet_id)
 WHERE public_summary_enabled AND packet_kind='provider_discovery' AND category='financial';
COMMENT ON COLUMN drive_packet_heads.public_summary_enabled IS 'Owner explicitly published scalar summary only to authenticated people viewers. Default false; independent from connection-only file commerce. Version and connection generation bound; no grants.';
COMMENT ON COLUMN drive_packet_heads.preview_document_count IS 'Nullable discovery count projected atomically with encrypted owner preview; no names, source identifiers, links or content.';
COMMIT;
