BEGIN;

-- Two-way connection graph (friend requests + mutual edges).
-- connection_requests: the directional handshake (requester -> addressee).
-- connections: the accepted MUTUAL edge, canonicalized so user_a_id < user_b_id.
-- On accept, the service also mirrors two directional trusted_connections edges
-- (source='connection') so existing location/SOS readers keep working unchanged.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS connection_requests (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_user_id  TEXT NOT NULL,
  addressee_user_id  TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'rejected', 'cancelled')),
  message            TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at       TIMESTAMPTZ,
  metadata           JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT connection_requests_no_self
    CHECK (requester_user_id <> addressee_user_id)
);

-- At most one PENDING request per ordered (requester, addressee) pair.
CREATE UNIQUE INDEX IF NOT EXISTS ux_connection_requests_pending
  ON connection_requests (requester_user_id, addressee_user_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_connection_requests_addressee
  ON connection_requests (addressee_user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_connection_requests_requester
  ON connection_requests (requester_user_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS connections (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_a_id    TEXT NOT NULL,
  user_b_id    TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked')),
  source       TEXT NOT NULL DEFAULT 'request'
    CHECK (source IN ('request', 'circle_invite', 'import')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at   TIMESTAMPTZ,
  CONSTRAINT connections_canonical_order CHECK (user_a_id < user_b_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_connections_pair
  ON connections (user_a_id, user_b_id);

CREATE INDEX IF NOT EXISTS idx_connections_user_a
  ON connections (user_a_id, status);
CREATE INDEX IF NOT EXISTS idx_connections_user_b
  ON connections (user_b_id, status);

COMMENT ON TABLE connection_requests IS
  'Two-way connection handshake (requester -> addressee). Accepted requests create a connections row + mirrored trusted_connections edges.';
COMMENT ON TABLE connections IS
  'Accepted mutual connections, canonicalized user_a_id < user_b_id.';

-- Allow accepted connections to mirror trusted_connections edges (source='connection').
ALTER TABLE trusted_connections
  DROP CONSTRAINT IF EXISTS trusted_connections_source_check;
ALTER TABLE trusted_connections
  ADD CONSTRAINT trusted_connections_source_check
  CHECK (source IN ('agent_one', 'seed', 'import', 'circle_invite', 'connection'));

COMMIT;
