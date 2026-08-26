-- Rollback for 176_trusted_device_sync_state.sql.
--
-- Drops the additive sync-state / seal telemetry columns from trusted_devices.
-- Safe under replay; the columns are metadata-only and carry no credential or
-- vault material, so dropping them loses only display/audit telemetry.

BEGIN;

ALTER TABLE trusted_devices
  DROP COLUMN IF EXISTS last_synced_at,
  DROP COLUMN IF EXISTS last_sync_cursor,
  DROP COLUMN IF EXISTS sealed_at;

COMMIT;
