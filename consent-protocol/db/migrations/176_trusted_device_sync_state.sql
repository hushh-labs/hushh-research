-- Trusted-device sync-state and seal telemetry.
--
-- Additive columns on trusted_devices that record when a device last pulled the
-- PKM device-sync channel (last_synced_at, last_sync_cursor) and when the native
-- Hermes runtime reported it sealed its local replica after a remote revoke
-- (sealed_at). All three are metadata-only BIGINT epoch/cursor values: no
-- credential, no vault material, no plaintext, no access grant. They drive the
-- settings sync-status display and close the remote-revoke audit loop; the
-- enforcement layer never gates on any of them.
--
-- The trusted-device tri-state (active / revoked / needs_reinit) stays DERIVED:
-- the server persists only the existing active|revoked status CHECK from
-- 121_trusted_devices.sql, and needs_reinit is a native-local condition. This
-- migration therefore does NOT touch the status CHECK constraint.

BEGIN;

ALTER TABLE trusted_devices
  ADD COLUMN IF NOT EXISTS last_synced_at BIGINT,
  ADD COLUMN IF NOT EXISTS last_sync_cursor BIGINT,
  ADD COLUMN IF NOT EXISTS sealed_at BIGINT;

COMMENT ON COLUMN trusted_devices.last_synced_at IS
  'Epoch ms of this device''s last PKM device-sync pull. Metadata only; drives the settings sync-status display. NULL until the device first syncs.';
COMMENT ON COLUMN trusted_devices.last_sync_cursor IS
  'High-water PKM device-sync cursor last served to this device. Metadata only; not an access grant.';
COMMENT ON COLUMN trusted_devices.sealed_at IS
  'Epoch ms the native runtime reported it sealed its local replica after a remote revoke. Advisory device-reported telemetry only; enforcement never gates on it.';

COMMIT;
