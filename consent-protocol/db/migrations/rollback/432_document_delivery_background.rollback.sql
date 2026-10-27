-- Receipts and pending ciphertext custody must survive compatible code rollback.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM document_delivery_background_requests) THEN
  RAISE EXCEPTION 'BACKGROUND_COPY_CUSTODY_RETAINED: use compatible application rollback';
 END IF;
END $$;
DROP TABLE IF EXISTS document_delivery_background_activity;
DROP TABLE IF EXISTS document_delivery_background_chunks;
DROP TABLE IF EXISTS document_delivery_background_files;
DROP TABLE IF EXISTS document_delivery_background_requests;
DROP FUNCTION IF EXISTS retain_background_delivery_objects();
