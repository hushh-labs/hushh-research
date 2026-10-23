-- Behavioral rollback: preserve sealed entries and owner placements.
-- Keep the connection invalidation trigger and deletion guards active.
BEGIN;
UPDATE drive_group_index_state SET processing_enabled=FALSE, disclosure_version=NULL,
  revision=revision+1, lease_id=NULL, lease_expires_at=NULL,
  updated_at=clock_timestamp();
COMMIT;
