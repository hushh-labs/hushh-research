BEGIN;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM drive_rest_call_leases WHERE expires_at>clock_timestamp())
 OR EXISTS(SELECT 1 FROM drive_rest_owner_admission WHERE sharing_cooldown_until>clock_timestamp())
 OR EXISTS(SELECT 1 FROM drive_bulk_share_effects WHERE attempts>5 OR sharing_quota_attempts>0 OR first_sharing_quota_at IS NOT NULL) THEN
  RAISE EXCEPTION 'DRIVE_RECOVERY_STATE_RETAINED: pause mutators and use compatible code rollback';
 END IF;
END $$;
DROP TABLE drive_rest_call_leases;
DROP TABLE drive_rest_owner_admission;
ALTER TABLE drive_bulk_share_effects DROP COLUMN sharing_quota_attempts,DROP COLUMN first_sharing_quota_at,DROP COLUMN ordinary_failure_attempts;
ALTER TABLE drive_bulk_share_effects DROP CONSTRAINT drive_bulk_share_effects_attempts_check;
ALTER TABLE drive_bulk_share_effects ADD CONSTRAINT drive_bulk_share_effects_attempts_check CHECK(attempts BETWEEN 0 AND 5);
COMMIT;
