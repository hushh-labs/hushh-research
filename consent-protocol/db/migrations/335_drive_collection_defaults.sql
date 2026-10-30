-- Preparation is a private product default. Preserve an owner's saved pause
-- across OAuth generations; only generation-bound work and evidence are reset.
-- Existing accounts are adopted in bounded application batches, not this DDL.
BEGIN;
CREATE OR REPLACE FUNCTION invalidate_drive_collection_sync()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NEW.connector_id='google_drive' AND (
    NEW.connection_generation<>OLD.connection_generation OR NEW.status='revoked'
  ) THEN
    UPDATE drive_collection_sync SET
      connection_generation=NEW.connection_generation, revision=revision+1,
      phase='start',checkpoint_envelope=NULL,lease_id=NULL,lease_expires_at=NULL,
      next_at=clock_timestamp(),attempt_count=0,last_error_code=NULL,
      incomplete_search=FALSE,initial_started_at=NULL,initial_completed_at=NULL,
      semantic_initial_completed_at=NULL,last_synced_at=NULL,last_indexed_at=NULL,
      sync_duration_ms=0,updated_at=clock_timestamp()
    WHERE user_id=NEW.user_id;
  END IF;
  RETURN NEW;
END $$;
COMMIT;
