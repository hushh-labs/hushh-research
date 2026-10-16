-- UAT-only retirement of the post-demo continuous Drive collection and packet catalogue.
-- The release manifest confines this overlay to the attested UAT database.
-- Preserve encrypted evidence, historical requests, grants and payment records.
BEGIN;

UPDATE drive_collection_sync
SET processing_enabled=FALSE, revision=revision+1,
    lease_id=NULL, lease_expires_at=NULL, updated_at=clock_timestamp()
WHERE processing_enabled OR lease_id IS NOT NULL;

UPDATE connected_documents
SET processing_enabled=FALSE, processing_revision=processing_revision+1,
    lease_id=NULL, lease_expires_at=NULL, updated_at=clock_timestamp()
WHERE source_profile='live' AND (processing_enabled OR lease_id IS NOT NULL);

UPDATE drive_packet_listings
SET enabled=FALSE, revision=revision+1, updated_at=clock_timestamp()
WHERE enabled;

UPDATE drive_packet_versions SET available=FALSE WHERE available;

COMMIT;
