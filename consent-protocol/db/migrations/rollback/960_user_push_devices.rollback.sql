-- Disable the private-agent lane and export device rows before rollback.
-- The original latest-per-platform registry remains valid and unchanged.
BEGIN;
DROP TABLE IF EXISTS user_push_devices;
COMMIT;
