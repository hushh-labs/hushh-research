-- 908: orphan address on deletion tombstones.
--
-- WHERE an unreclaimed pod lives (project/region/target) so a billing host stays
-- reclaimable after the registry row is gone.
--
-- This column was briefly added by editing 900 in place, which tripped the
-- migration authority on the next dev deploy: 900 was already APPLIED, and an
-- applied migration's checksum is immutable (MigrationAuthorityError,
-- db/migrate.py). The lesson is the release lane's rule holding in the parked
-- lane too -- schema changes ride NEW migrations, never edits to applied ones.
ALTER TABLE personal_agent_deletion_tombstones
    ADD COLUMN IF NOT EXISTS metadata JSONB;
