BEGIN;

-- Migration 126: provenance-aware connection origins for named Circles.
--
-- A canonical connection can be justified by more than one independent source:
-- a direct request, a legacy invite, an import, and one or more named Circles.
-- `connections` remains the fast aggregate projection consumed by existing
-- readers; this ledger is the durable provenance used to activate/revoke it.
ALTER TABLE connections
  DROP CONSTRAINT IF EXISTS connections_source_check;
ALTER TABLE connections
  ADD CONSTRAINT connections_source_check
  CHECK (source IN ('request', 'circle_invite', 'import', 'named_circle'));

CREATE TABLE IF NOT EXISTS connection_origins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id UUID NOT NULL
    REFERENCES connections(id) ON DELETE CASCADE,
  origin_kind TEXT NOT NULL
    CHECK (origin_kind IN (
      'direct_request',
      'named_circle',
      'legacy_invite',
      'import'
    )),
  -- Stable, non-null identity makes every origin idempotent even when its
  -- optional source columns are NULL. Named Circle keys are circle-specific.
  origin_key TEXT NOT NULL,
  -- Hard Circle deletion must revoke/recompute and explicitly remove this
  -- provenance first; RESTRICT prevents a phantom active aggregate connection.
  source_circle_id UUID
    REFERENCES one_location_circles(id) ON DELETE RESTRICT,
  source_ref TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT connection_origins_kind_shape CHECK (
    (
      origin_kind = 'named_circle'
      AND source_circle_id IS NOT NULL
      AND origin_key = 'named_circle:' || source_circle_id::text
    )
    OR (
      origin_kind <> 'named_circle'
      AND source_circle_id IS NULL
      AND origin_key = origin_kind
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_connection_origins_key
  ON connection_origins (connection_id, origin_key);

CREATE INDEX IF NOT EXISTS idx_connection_origins_active_connection
  ON connection_origins (connection_id, origin_kind)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_connection_origins_active_circle
  ON connection_origins (source_circle_id, connection_id)
  WHERE status = 'active' AND source_circle_id IS NOT NULL;

-- Every pre-existing canonical row receives one matching origin. Revoked rows
-- are retained as revoked provenance so rollback and audit behavior stay
-- deterministic.
INSERT INTO connection_origins (
  connection_id,
  origin_kind,
  origin_key,
  source_ref,
  status,
  created_at,
  updated_at,
  revoked_at,
  metadata
)
SELECT
  connection.id,
  CASE connection.source
    WHEN 'request' THEN 'direct_request'
    WHEN 'circle_invite' THEN 'legacy_invite'
    WHEN 'import' THEN 'import'
    ELSE 'direct_request'
  END,
  CASE connection.source
    WHEN 'request' THEN 'direct_request'
    WHEN 'circle_invite' THEN 'legacy_invite'
    WHEN 'import' THEN 'import'
    ELSE 'direct_request'
  END,
  NULL,
  connection.status,
  connection.created_at,
  connection.updated_at,
  connection.revoked_at,
  jsonb_build_object('backfilledFrom', connection.source)
FROM connections connection
WHERE connection.source IN ('request', 'circle_invite', 'import')
ON CONFLICT (connection_id, origin_key) DO NOTHING;

-- Migration 125 can already be live with active memberships. Materialize every
-- existing active co-member pair now (at most 190 pairs per 20-member Circle)
-- so deployment does not make the new behavior apply only to future joins.
WITH active_circle_pairs AS (
  SELECT DISTINCT
    first_member.user_id AS user_a_id,
    second_member.user_id AS user_b_id
  FROM one_location_circles circle
  JOIN one_location_circle_memberships first_member
    ON first_member.circle_id = circle.id
   AND first_member.status = 'active'
  JOIN one_location_circle_memberships second_member
    ON second_member.circle_id = circle.id
   AND second_member.status = 'active'
   AND first_member.user_id < second_member.user_id
  WHERE circle.status = 'active'
)
INSERT INTO connections (
  user_a_id,
  user_b_id,
  status,
  source,
  created_at,
  updated_at,
  revoked_at
)
SELECT
  pair.user_a_id,
  pair.user_b_id,
  'active',
  'named_circle',
  NOW(),
  NOW(),
  NULL
FROM active_circle_pairs pair
ON CONFLICT (user_a_id, user_b_id) DO UPDATE SET
  status = 'active',
  updated_at = NOW(),
  revoked_at = NULL;

INSERT INTO connection_origins (
  connection_id,
  origin_kind,
  origin_key,
  source_circle_id,
  status,
  created_at,
  updated_at,
  revoked_at,
  metadata
)
SELECT
  connection.id,
  'named_circle',
  'named_circle:' || circle.id::text,
  circle.id,
  'active',
  NOW(),
  NOW(),
  NULL,
  jsonb_build_object('backfilledFrom', 'one_location_circle_memberships')
FROM one_location_circles circle
JOIN one_location_circle_memberships first_member
  ON first_member.circle_id = circle.id
 AND first_member.status = 'active'
JOIN one_location_circle_memberships second_member
  ON second_member.circle_id = circle.id
 AND second_member.status = 'active'
 AND first_member.user_id < second_member.user_id
JOIN connections connection
  ON connection.user_a_id = first_member.user_id
 AND connection.user_b_id = second_member.user_id
WHERE circle.status = 'active'
ON CONFLICT (connection_id, origin_key) DO UPDATE SET
  status = 'active',
  updated_at = NOW(),
  revoked_at = NULL;

-- Recompute the compatibility projection with the same source priority used by
-- the runtime helper. A direct/imported source wins the scalar projection while
-- every source remains independently represented in connection_origins.
UPDATE connections connection
SET status = 'active',
    source = CASE
      WHEN EXISTS (
        SELECT 1 FROM connection_origins origin
        WHERE origin.connection_id = connection.id
          AND origin.status = 'active'
          AND origin.origin_kind = 'direct_request'
      ) THEN 'request'
      WHEN EXISTS (
        SELECT 1 FROM connection_origins origin
        WHERE origin.connection_id = connection.id
          AND origin.status = 'active'
          AND origin.origin_kind = 'legacy_invite'
      ) THEN 'circle_invite'
      WHEN EXISTS (
        SELECT 1 FROM connection_origins origin
        WHERE origin.connection_id = connection.id
          AND origin.status = 'active'
          AND origin.origin_kind = 'import'
      ) THEN 'import'
      ELSE 'named_circle'
    END,
    revoked_at = NULL,
    updated_at = NOW()
WHERE EXISTS (
  SELECT 1
  FROM connection_origins origin
  WHERE origin.connection_id = connection.id
    AND origin.status = 'active'
);

-- Connected pairs must not retain an actionable request after migration.
UPDATE connection_requests request
SET status = 'cancelled',
    responded_at = COALESCE(request.responded_at, NOW()),
    updated_at = NOW(),
    metadata = request.metadata || jsonb_build_object(
      'supersededByConnectionId',
      connection.id::text
    )
FROM connections connection
WHERE request.status = 'pending'
  AND connection.status = 'active'
  AND (
    (
      request.requester_user_id = connection.user_a_id
      AND request.addressee_user_id = connection.user_b_id
    )
    OR (
      request.requester_user_id = connection.user_b_id
      AND request.addressee_user_id = connection.user_a_id
    )
  );

COMMENT ON TABLE connection_origins IS
  'Durable source ledger for canonical mutual connections. A connection stays active while any origin is active.';
COMMENT ON COLUMN connection_origins.origin_key IS
  'Idempotency key scoped to one canonical connection; named_circle keys include the Circle UUID.';
COMMENT ON COLUMN connection_origins.source_circle_id IS
  'Named Circle provenance only. It does not create a trusted_connection, location grant, SMS selection, or ciphertext envelope.';
COMMENT ON TABLE one_location_circles IS
  'Named One Location groups. Active co-members receive a canonical connection origin, but no location access, trusted edge, SMS selection, or ciphertext by membership alone.';
COMMENT ON TABLE one_location_circle_memberships IS
  'Owner/member relationship state for named Circles. Connection provenance follows active membership; explicit live-location grants remain authoritative.';

COMMIT;
