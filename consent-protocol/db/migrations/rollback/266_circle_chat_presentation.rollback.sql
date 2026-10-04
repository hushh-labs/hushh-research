BEGIN;
DROP TRIGGER IF EXISTS circle_photo_erased ON one_location_circles;
DROP FUNCTION IF EXISTS circle_photo_erased();
ALTER TABLE one_location_circles DROP COLUMN IF EXISTS photo_url;
ALTER TABLE circle_chat_messages DROP COLUMN IF EXISTS original_recipient_count;
COMMIT;
