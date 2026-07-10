BEGIN;

-- Unify location SOS/check-in onto the app-wide trusted_connections graph.
--
-- 1. Allow a 'circle_invite' provenance on trusted_connections.source.
-- 2. Copy REAL one_location_network_connections rows (undirected pairs, NOT the
--    dev seed) into trusted_connections as BOTH directional edges, preserving
--    existing mutual SOS reachability.
-- 3. Purge preseeded trusted rows (source='seed').
--
-- The old one_location_network_connections table is retired in a later migration
-- once all code stops referencing it. Idempotent: ON CONFLICT DO NOTHING + IF
-- EXISTS guards.

-- 1. Widen the source CHECK to include circle_invite (and 'connection').
-- NOTE: the release manifest re-applies EVERY migration file on every deploy
-- (db/migrate.py apply_migration_files runs in explicit mode, no skip). Once
-- 086 shipped, the live app writes trusted_connections rows with
-- source='connection'; if this ADD CONSTRAINT omitted 'connection' it would
-- re-narrow the set mid-deploy and fail validation on those rows before 086
-- re-widens it. Keep this superset in sync with 086_connections.sql.
ALTER TABLE trusted_connections
  DROP CONSTRAINT IF EXISTS trusted_connections_source_check;
ALTER TABLE trusted_connections
  ADD CONSTRAINT trusted_connections_source_check
  CHECK (source IN ('agent_one', 'seed', 'import', 'circle_invite', 'connection'));

-- 2a. Copy a -> b for every real active pair.
INSERT INTO trusted_connections (
  owner_user_id, trusted_user_id, status, source, resolved_via,
  created_at, updated_at, metadata
)
SELECT
  nc.user_a_id, nc.user_b_id, 'active', 'circle_invite', 'user_id',
  NOW(), NOW(), '{"source":"migrated_from_network"}'::jsonb
FROM one_location_network_connections nc
WHERE nc.status = 'active'
  AND nc.user_a_id <> nc.user_b_id
  AND COALESCE(nc.metadata->>'source', '') <> 'sos_seed'
ON CONFLICT (owner_user_id, trusted_user_id) DO NOTHING;

-- 2b. Copy b -> a (the reverse direction) for the same real pairs.
INSERT INTO trusted_connections (
  owner_user_id, trusted_user_id, status, source, resolved_via,
  created_at, updated_at, metadata
)
SELECT
  nc.user_b_id, nc.user_a_id, 'active', 'circle_invite', 'user_id',
  NOW(), NOW(), '{"source":"migrated_from_network"}'::jsonb
FROM one_location_network_connections nc
WHERE nc.status = 'active'
  AND nc.user_a_id <> nc.user_b_id
  AND COALESCE(nc.metadata->>'source', '') <> 'sos_seed'
ON CONFLICT (owner_user_id, trusted_user_id) DO NOTHING;

-- 3. Remove preseeded trusted rows so no dev account remains a trusted contact.
DELETE FROM trusted_connections WHERE source = 'seed';

COMMIT;
