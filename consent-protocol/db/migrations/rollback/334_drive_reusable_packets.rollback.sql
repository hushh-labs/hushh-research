-- Disable continuous processing and packet listings; retain encrypted evidence,
-- historical approved packet versions and purchase bindings for investigation.
BEGIN;
UPDATE drive_collection_sync SET processing_enabled=FALSE,revision=revision+1,
  lease_id=NULL,lease_expires_at=NULL,updated_at=clock_timestamp();
UPDATE drive_packet_listings SET enabled=FALSE,revision=revision+1,updated_at=clock_timestamp();
UPDATE drive_packet_versions SET available=FALSE;
COMMIT;
