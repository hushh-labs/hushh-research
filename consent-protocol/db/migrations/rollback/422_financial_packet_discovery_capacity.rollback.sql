-- Retain discovered originals. Application rollback is independent of this capacity guard.
BEGIN;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM drive_owner_search_jobs WHERE matched>10000 OR unshareable_count>10000)
 OR EXISTS(SELECT 1 FROM drive_owner_search_results WHERE position>10000)
 OR EXISTS(SELECT 1 FROM drive_packet_heads WHERE preview_document_count>10000) THEN
  RAISE EXCEPTION 'Retained financial previews exceed legacy capacity; do not delete originals to force rollback';
 END IF;
END $$;
-- Compatible guards remain installed; restoring the old application does not
-- require shrinking storage. No authority or owner preference is altered.
COMMIT;
