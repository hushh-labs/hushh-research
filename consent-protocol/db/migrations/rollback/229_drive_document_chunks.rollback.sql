-- Code rollback only: disable DRIVE_DOCUMENT_INDEXING first. Old code ignores
-- the additive chunk table. Preserve encrypted records and cascade deletion.
-- Dropping the table would destroy private information and is not a rollback.
BEGIN;
SELECT 1;
COMMIT;
