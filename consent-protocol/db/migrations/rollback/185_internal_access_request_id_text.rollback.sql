BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM internal_access_events
    WHERE length(request_id) > 32
  ) THEN
    RAISE EXCEPTION 'Cannot safely restore internal_access_events.request_id to VARCHAR(32): longer identifiers exist';
  END IF;
END $$;

ALTER TABLE internal_access_events
  ALTER COLUMN request_id TYPE VARCHAR(32);

COMMIT;
