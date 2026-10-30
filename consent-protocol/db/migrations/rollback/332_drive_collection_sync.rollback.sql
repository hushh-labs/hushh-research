-- Retain encrypted evidence and consent history; disable execution before reverting code.
BEGIN;
UPDATE drive_collection_sync SET processing_enabled=FALSE,revision=revision+1,
 lease_id=NULL,lease_expires_at=NULL,updated_at=clock_timestamp();
UPDATE connected_documents SET processing_enabled=FALSE,processing_revision=processing_revision+1,
 lease_id=NULL,lease_expires_at=NULL WHERE source_profile='live';
COMMIT;
