BEGIN;

-- Migration 138: a Circle invitation is a connection between two people.
--
-- Joining a Circle used to write a `named_circle` origin between the joiner
-- and EVERY existing member — a 20-person Circle produced 19 connections from
-- one join, connecting people who had never chosen each other. It also made
-- those connections disappear again the moment someone left, because
-- `named_circle` origins are revoked with the membership.
--
-- Redeeming an invitation is the same consent shape as a connection request:
-- one person offers, one person accepts, and the pair is connected. This kind
-- records that pair. It is deliberately NOT `named_circle`, so it survives
-- leaving the Circle exactly as an accepted connection request does, and it is
-- deliberately NOT `direct_request`, so the Circle lifecycle can still tell
-- "we met through a Circle" apart from "we exchanged a request" — the
-- distinction that keeps a Circle removal from silently preserving a live
-- location share the Circle authorized.
--
-- No backfill. Connections created by the old mesh behavior stay exactly as
-- they are: people may already be sharing location with them, and revoking
-- them would be a silent disconnection. This changes what future joins create.
ALTER TABLE connection_origins
  DROP CONSTRAINT IF EXISTS connection_origins_origin_kind_check;

ALTER TABLE connection_origins
  ADD CONSTRAINT connection_origins_origin_kind_check
  CHECK (origin_kind IN (
    'direct_request',
    'named_circle',
    'circle_member',
    'legacy_invite',
    'import'
  ));

-- `circle_member` is pair provenance, not Circle-scoped provenance: one row per
-- connection regardless of how many Circles the pair later share. The existing
-- shape constraint already requires source_circle_id IS NULL and
-- origin_key = origin_kind for every kind except 'named_circle', which is
-- exactly right here, so it needs no change.

COMMENT ON COLUMN connection_origins.origin_kind IS
  'Why this connection exists. `named_circle` is Circle-scoped and revoked with the membership; `circle_member` records the invitation two people accepted and outlives the Circle, like `direct_request`.';

COMMIT;
