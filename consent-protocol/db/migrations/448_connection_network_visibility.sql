BEGIN;

-- Existing accounts retain their private graph. A public person reference is
-- an address, never permission to enumerate that person's connections.
ALTER TABLE actor_profiles
  ADD COLUMN IF NOT EXISTS connection_list_shared BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN actor_profiles.connection_list_shared IS
  'Explicit opt-in: direct connections may browse eligible public connections; shared edges may contribute anonymous extended network degrees. No contact details or consent grants are shared.';

COMMIT;
