-- A first Calendar connection can include read-only guest profile lookup.
-- Historical grants remain false and are never silently upgraded.
BEGIN;
ALTER TABLE google_service_grants
  ADD COLUMN IF NOT EXISTS guest_photo_access BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE google_calendar_additional_accounts
  ADD COLUMN IF NOT EXISTS guest_photo_access BOOLEAN NOT NULL DEFAULT FALSE;
COMMENT ON COLUMN google_service_grants.guest_photo_access IS
  'True only when a Calendar OAuth attempt requested Contacts read and Google returned that scope.';
COMMENT ON COLUMN google_calendar_additional_accounts.guest_photo_access IS
  'True only when this Calendar account OAuth attempt requested Contacts read and Google returned that scope.';
COMMIT;
