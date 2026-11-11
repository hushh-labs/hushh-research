BEGIN;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM drive_share_file_claims WHERE bulk_share_id IS NOT NULL OR removal_id IS NOT NULL) THEN
  RAISE EXCEPTION 'DRIVE_FILE_CLAIMS_RETAINED: pause mutators and reconcile first';
 END IF;
END $$;
DROP TRIGGER drive_bulk_file_claim_delete ON drive_bulk_share_effects;
DROP TRIGGER drive_bulk_file_claim_settle ON drive_bulk_share_effects;
DROP TRIGGER drive_removal_file_claim_delete ON drive_request_bulk_removals;
DROP TRIGGER drive_removal_file_claim_settle ON drive_request_bulk_removals;
DROP FUNCTION drive_bulk_file_claim_lifecycle();
DROP FUNCTION drive_removal_file_claim_lifecycle();
ALTER TABLE drive_share_file_claims DROP CONSTRAINT drive_file_claim_or_erased_fence;
ALTER TABLE drive_share_file_claims DROP COLUMN bulk_share_id,DROP COLUMN bulk_position,DROP COLUMN bulk_recipient_user_id,DROP COLUMN removal_id;
ALTER TABLE drive_share_file_claims ADD CONSTRAINT drive_file_claim_or_erased_fence CHECK((operation_id IS NULL)=(erased_at IS NOT NULL));
COMMIT;
