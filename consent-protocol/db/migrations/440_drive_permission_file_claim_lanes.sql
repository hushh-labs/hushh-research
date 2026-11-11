-- Extend the existing global file mutation fence; no second lock authority.
-- Preserve the historical CHECK name so migration234 skips it during full replay.
BEGIN;
ALTER TABLE drive_share_file_claims
 ADD COLUMN IF NOT EXISTS bulk_share_id UUID,
 ADD COLUMN IF NOT EXISTS bulk_position INTEGER,
 ADD COLUMN IF NOT EXISTS bulk_recipient_user_id TEXT,
 ADD COLUMN IF NOT EXISTS removal_id UUID;
ALTER TABLE drive_share_file_claims DROP CONSTRAINT IF EXISTS drive_file_claim_or_erased_fence;
ALTER TABLE drive_share_file_claims ADD CONSTRAINT drive_file_claim_or_erased_fence CHECK (
 (erased_at IS NOT NULL AND num_nonnulls(operation_id,bulk_share_id,bulk_position,bulk_recipient_user_id,removal_id)=0)
 OR (erased_at IS NULL AND num_nonnulls(operation_id,bulk_share_id,removal_id)=1
 AND (bulk_share_id IS NULL)=(bulk_position IS NULL)
 AND (bulk_share_id IS NULL)=(bulk_recipient_user_id IS NULL)));
ALTER TABLE drive_share_file_claims DROP CONSTRAINT IF EXISTS drive_file_claim_bulk_effect_fk;
ALTER TABLE drive_share_file_claims ADD CONSTRAINT drive_file_claim_bulk_effect_fk
 FOREIGN KEY(bulk_share_id,bulk_position,bulk_recipient_user_id)
 REFERENCES drive_bulk_share_effects(share_id,position,recipient_user_id) MATCH FULL;
ALTER TABLE drive_share_file_claims DROP CONSTRAINT IF EXISTS drive_file_claim_removal_fk;
ALTER TABLE drive_share_file_claims ADD CONSTRAINT drive_file_claim_removal_fk
 FOREIGN KEY(removal_id) REFERENCES drive_request_bulk_removals(removal_id);
CREATE UNIQUE INDEX IF NOT EXISTS drive_file_claim_bulk_effect_once ON drive_share_file_claims(bulk_share_id,bulk_position,bulk_recipient_user_id) WHERE bulk_share_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS drive_file_claim_removal_once ON drive_share_file_claims(removal_id) WHERE removal_id IS NOT NULL;
CREATE OR REPLACE FUNCTION drive_bulk_file_claim_lifecycle() RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.state IN ('dispatching','unknown') OR (OLD.state='failed' AND OLD.safe_error_code='permission_outcome_unknown') THEN
   IF NOT EXISTS(SELECT 1 FROM drive_share_file_claims WHERE bulk_share_id=OLD.share_id AND bulk_position=OLD.position AND bulk_recipient_user_id=OLD.recipient_user_id) THEN
    RAISE EXCEPTION 'DRIVE_UNCERTAIN_CLAIM_ADOPTION_REQUIRED';
   END IF;
   UPDATE drive_share_file_claims SET bulk_share_id=NULL,bulk_position=NULL,bulk_recipient_user_id=NULL,erased_at=clock_timestamp()
   WHERE bulk_share_id=OLD.share_id AND bulk_position=OLD.position AND bulk_recipient_user_id=OLD.recipient_user_id;
  ELSE
   DELETE FROM drive_share_file_claims WHERE bulk_share_id=OLD.share_id AND bulk_position=OLD.position AND bulk_recipient_user_id=OLD.recipient_user_id;
  END IF;
  RETURN OLD;
 END IF;
 IF NEW.state='dispatching' AND NOT EXISTS(SELECT 1 FROM drive_share_file_claims WHERE bulk_share_id=NEW.share_id AND bulk_position=NEW.position AND bulk_recipient_user_id=NEW.recipient_user_id AND erased_at IS NULL) THEN
  RAISE EXCEPTION 'DRIVE_FILE_CLAIM_REQUIRED';
 END IF;
 IF (NEW.state='queued' AND NEW.lease_id IS NULL) OR
 (NEW.state NOT IN ('queued','dispatching','unknown') AND NOT(NEW.state='failed' AND COALESCE(NEW.safe_error_code,'')='permission_outcome_unknown')) THEN
  DELETE FROM drive_share_file_claims WHERE bulk_share_id=NEW.share_id AND bulk_position=NEW.position AND bulk_recipient_user_id=NEW.recipient_user_id;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS drive_bulk_file_claim_delete ON drive_bulk_share_effects;
CREATE TRIGGER drive_bulk_file_claim_delete BEFORE DELETE ON drive_bulk_share_effects FOR EACH ROW EXECUTE FUNCTION drive_bulk_file_claim_lifecycle();
DROP TRIGGER IF EXISTS drive_bulk_file_claim_settle ON drive_bulk_share_effects;
CREATE TRIGGER drive_bulk_file_claim_settle AFTER UPDATE OF state,lease_id,safe_error_code ON drive_bulk_share_effects FOR EACH ROW EXECUTE FUNCTION drive_bulk_file_claim_lifecycle();
CREATE OR REPLACE FUNCTION drive_removal_file_claim_lifecycle() RETURNS TRIGGER LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.state IN ('dispatching','unknown') THEN
   IF NOT EXISTS(SELECT 1 FROM drive_share_file_claims WHERE removal_id=OLD.removal_id) THEN
    RAISE EXCEPTION 'DRIVE_UNCERTAIN_CLAIM_ADOPTION_REQUIRED';
   END IF;
   UPDATE drive_share_file_claims SET removal_id=NULL,erased_at=clock_timestamp() WHERE removal_id=OLD.removal_id;
  ELSE DELETE FROM drive_share_file_claims WHERE removal_id=OLD.removal_id;
  END IF;
  RETURN OLD;
 END IF;
 IF NEW.state='dispatching' AND NOT EXISTS(SELECT 1 FROM drive_share_file_claims WHERE removal_id=NEW.removal_id AND erased_at IS NULL) THEN
  RAISE EXCEPTION 'DRIVE_FILE_CLAIM_REQUIRED';
 END IF;
 IF (NEW.state='queued' AND NEW.lease_id IS NULL) OR NEW.state NOT IN ('queued','dispatching','unknown') THEN
  DELETE FROM drive_share_file_claims WHERE removal_id=NEW.removal_id;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS drive_removal_file_claim_delete ON drive_request_bulk_removals;
CREATE TRIGGER drive_removal_file_claim_delete BEFORE DELETE ON drive_request_bulk_removals FOR EACH ROW EXECUTE FUNCTION drive_removal_file_claim_lifecycle();
DROP TRIGGER IF EXISTS drive_removal_file_claim_settle ON drive_request_bulk_removals;
CREATE TRIGGER drive_removal_file_claim_settle AFTER UPDATE OF state,lease_id ON drive_request_bulk_removals FOR EACH ROW EXECUTE FUNCTION drive_removal_file_claim_lifecycle();
COMMENT ON TABLE drive_share_file_claims IS 'Global keyed file mutation exclusion. Uncertain individual, bulk and removal writes retain claims beyond lease expiry; erased unknown writes retain anonymous fences.';
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_proc WHERE proname='install_account_deletion_write_guards') THEN PERFORM public.install_account_deletion_write_guards(); END IF;
END $$;
COMMIT;
