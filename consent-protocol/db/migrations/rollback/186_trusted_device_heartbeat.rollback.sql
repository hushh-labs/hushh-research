-- Rollback for migration 186: trusted-device liveness heartbeat.
--
-- Additive, advisory telemetry columns. Dropping them removes the ability to
-- report live agent reachability; it does not affect trust, enrollment, sync,
-- or revocation, none of which read these columns.

ALTER TABLE trusted_devices
  DROP COLUMN IF EXISTS last_heartbeat_at,
  DROP COLUMN IF EXISTS heartbeat;
