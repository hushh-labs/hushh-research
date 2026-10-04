BEGIN;

-- Legacy audiences cannot be reconstructed after recipient account erasure.
-- NULL is deliberately unknown; new sends persist the non-sender audience.
ALTER TABLE circle_chat_messages ADD COLUMN IF NOT EXISTS original_recipient_count SMALLINT
  CHECK (original_recipient_count BETWEEN 0 AND 99);
ALTER TABLE one_location_circles ADD COLUMN IF NOT EXISTS photo_url TEXT
  CHECK (photo_url IS NULL OR length(photo_url) <= 410000);

CREATE OR REPLACE FUNCTION circle_photo_erased() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'deleted' THEN NEW.photo_url := NULL; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS circle_photo_erased ON one_location_circles;
CREATE TRIGGER circle_photo_erased BEFORE UPDATE OF status ON one_location_circles
  FOR EACH ROW EXECUTE FUNCTION circle_photo_erased();

COMMIT;
