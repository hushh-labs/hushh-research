-- Migration 186: trusted-device liveness heartbeat.
--
-- The devices surface could not answer "is this agent reachable right now?".
-- last_synced_at (migration 176) only advances when the device PULLS the sync
-- channel, so an agent that is running but idle looks two days stale. There was
-- no liveness signal at all.
--
-- These columns hold a heartbeat the running device posts. They are telemetry
-- only: metadata about the agent's runtime, never vault or PKM content, and
-- enforcement never gates on them. Trust remains decided by status +
-- is_trusted_device_active, exactly as before.

ALTER TABLE trusted_devices
  ADD COLUMN IF NOT EXISTS last_heartbeat_at BIGINT,
  ADD COLUMN IF NOT EXISTS heartbeat JSONB;

COMMENT ON COLUMN trusted_devices.last_heartbeat_at IS
  'Epoch ms of the last liveness heartbeat posted by the running device. Advisory telemetry; a fresh value means the agent was running, not that it is trusted. Enforcement never gates on this column.';

COMMENT ON COLUMN trusted_devices.heartbeat IS
  'Latest runtime snapshot reported by the device: machine identifier, configured model, busy flag, active session count, next cron run. Metadata only; never vault keys, PKM content, filesystem paths, or credentials.';
