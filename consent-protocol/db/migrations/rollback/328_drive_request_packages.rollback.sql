-- Keep encrypted package snapshots in checkpoints for retained approvals.
-- Refuse destructive evidence removal while an approved package is retained.
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM drive_share_requests r
    JOIN drive_owner_search_jobs j ON j.user_id=r.user_id AND j.client_request_id=r.request_id
    WHERE r.owner_allowed_at IS NOT NULL AND j.evaluation_status='ready') THEN
    RAISE EXCEPTION 'Cannot remove evidence for an owner-approved document package';
  END IF;
END $$;
DROP INDEX IF EXISTS drive_request_package_due;
DROP INDEX IF EXISTS drive_request_package_unread;
ALTER TABLE drive_share_requests DROP COLUMN IF EXISTS agent_package_required;
ALTER TABLE drive_owner_search_results DROP COLUMN IF EXISTS evaluation_envelope,
  DROP COLUMN IF EXISTS evaluated_at;
ALTER TABLE drive_owner_search_jobs DROP COLUMN IF EXISTS evaluation_status,
  DROP COLUMN IF EXISTS evaluation_next_at, DROP COLUMN IF EXISTS evaluation_attempts,
  DROP COLUMN IF EXISTS evaluation_error_code;
COMMIT;
