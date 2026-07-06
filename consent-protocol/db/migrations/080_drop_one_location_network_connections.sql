BEGIN;

-- Retire the legacy One Location SOS graph.
--
-- All reads/writes now go through the app-wide trusted_connections graph
-- (real pairs were copied over in migration 079).  No application code
-- references one_location_network_connections anymore, so the table is safe
-- to drop.  Idempotent: IF EXISTS guard.
DROP TABLE IF EXISTS one_location_network_connections;

COMMIT;
