BEGIN;
-- Do not erase recorded Google consent while an authorized account still uses it.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM google_service_grants WHERE status = 'connected' AND guest_photo_access)
     OR EXISTS (SELECT 1 FROM google_calendar_additional_accounts WHERE status = 'connected' AND guest_photo_access) THEN
    RAISE EXCEPTION 'Preserve active Calendar guest photo grants before schema rollback';
  END IF;
END $$;
ALTER TABLE google_calendar_additional_accounts DROP COLUMN IF EXISTS guest_photo_access;
ALTER TABLE google_service_grants DROP COLUMN IF EXISTS guest_photo_access;
COMMIT;
