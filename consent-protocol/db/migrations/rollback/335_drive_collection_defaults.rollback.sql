-- Restore generation invalidation before rolling back the application default.
-- Saved rows/evidence remain intact until the next connection invalidation.
BEGIN;
CREATE OR REPLACE FUNCTION invalidate_drive_collection_sync()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NEW.connector_id='google_drive' AND (
    NEW.connection_generation<>OLD.connection_generation OR NEW.status='revoked'
  ) THEN
    DELETE FROM drive_collection_sync WHERE user_id=NEW.user_id;
  END IF;
  RETURN NEW;
END $$;
COMMIT;
