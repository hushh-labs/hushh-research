-- Private requests may be erased without losing A's exact Google-removal receipt.
BEGIN;
CREATE TABLE IF NOT EXISTS drive_share_management_contexts (
  request_id UUID PRIMARY KEY,
  user_id TEXT NOT NULL,
  revocation_revision BIGINT NOT NULL DEFAULT 0 CHECK (revocation_revision>=0),
  private_request_erased_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(request_id,user_id)
);
INSERT INTO drive_share_management_contexts(request_id,user_id,revocation_revision,created_at)
  SELECT request_id,user_id,revocation_revision,created_at FROM drive_share_requests
  ON CONFLICT (request_id) DO NOTHING;
CREATE OR REPLACE FUNCTION ensure_drive_share_management_context()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  INSERT INTO drive_share_management_contexts(request_id,user_id,revocation_revision,created_at)
    VALUES (NEW.request_id,NEW.user_id,NEW.revocation_revision,NEW.created_at)
    ON CONFLICT (request_id) DO NOTHING;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS drive_request_management_context ON drive_share_requests;
CREATE TRIGGER drive_request_management_context AFTER INSERT ON drive_share_requests
  FOR EACH ROW EXECUTE FUNCTION ensure_drive_share_management_context();
DO $$
DECLARE existing RECORD;
BEGIN
  FOR existing IN SELECT conname FROM pg_constraint
    WHERE conrelid='drive_share_permission_operations'::regclass AND contype='f'
      AND confrelid IN ('drive_share_requests'::regclass,'drive_share_reviews'::regclass)
  LOOP
    EXECUTE format('ALTER TABLE drive_share_permission_operations DROP CONSTRAINT %I',existing.conname);
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='drive_share_permission_operations'::regclass
    AND conname='drive_operations_management_context_fk') THEN
    ALTER TABLE drive_share_permission_operations ADD CONSTRAINT drive_operations_management_context_fk
      FOREIGN KEY(request_id,user_id) REFERENCES drive_share_management_contexts(request_id,user_id);
  END IF;
END $$;
-- Erasing an owner must not turn an uncertain Google write into permission to
-- repeat it. Keep only a keyed file fingerprint, with no account or operation.
ALTER TABLE drive_share_file_claims ALTER COLUMN operation_id DROP NOT NULL;
ALTER TABLE drive_share_file_claims ADD COLUMN IF NOT EXISTS erased_at TIMESTAMPTZ;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='drive_share_file_claims'::regclass
    AND conname='drive_file_claim_or_erased_fence') THEN
    ALTER TABLE drive_share_file_claims ADD CONSTRAINT drive_file_claim_or_erased_fence
      CHECK ((operation_id IS NULL)=(erased_at IS NOT NULL));
  END IF;
END $$;
ALTER TABLE drive_share_management_contexts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON drive_share_management_contexts FROM PUBLIC;
DO $$
DECLARE role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON drive_share_management_contexts FROM %I',role_name);
    END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON drive_share_management_contexts TO service_role;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_proc WHERE proname='install_account_deletion_write_guards') THEN
    PERFORM public.install_account_deletion_write_guards();
  END IF;
END $$;
COMMENT ON TABLE drive_share_management_contexts IS
  'Owner-only removal context. No recipient app identity or private request payload. Never confers grant authority.';
COMMIT;
