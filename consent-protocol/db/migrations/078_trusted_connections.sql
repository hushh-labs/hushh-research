BEGIN;

-- Generalized, app-wide "trusted connections" graph.
--
-- Directional by design: one edge per (owner_user_id -> trusted_user_id) pair,
-- meaning "owner designates this person as trusted" (like an emergency contact).
-- Written ONLY through the Hushh One agent; read in-process by any agent.
-- Deliberately SEPARATE from one_location_network_connections (SOS) — that graph
-- and its code are untouched. Convergence is future work.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS trusted_connections (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id   TEXT NOT NULL,
  trusted_user_id TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked')),
  source          TEXT NOT NULL DEFAULT 'agent_one'
    CHECK (source IN ('agent_one', 'seed', 'import')),
  resolved_via    TEXT
    CHECK (resolved_via IN ('directory', 'user_id')),
  label           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at      TIMESTAMPTZ,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT trusted_connections_no_self
    CHECK (owner_user_id <> trusted_user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_trusted_connections_edge
  ON trusted_connections (owner_user_id, trusted_user_id);

CREATE INDEX IF NOT EXISTS idx_trusted_connections_owner
  ON trusted_connections (owner_user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_trusted_connections_trusted
  ON trusted_connections (trusted_user_id, status);

COMMENT ON TABLE trusted_connections IS
  'Directional, app-wide trusted-connection graph (owner -> trusted). Written only via Agent One; read in-process by any agent. Separate from one_location_network_connections.';

COMMIT;
