-- Bounded context preview matches B-selected files to recorded operations by
-- the existing server-keyed file lock. Keep this a read optimization only;
-- neither the index nor its key confers sharing authority.
BEGIN;
CREATE INDEX IF NOT EXISTS drive_share_context_file_lookup
  ON drive_share_permission_operations(file_lock_hmac, kind, operation_id);
COMMIT;
