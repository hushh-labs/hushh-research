BEGIN;

-- Roll back migration 126.
--
-- Restore only the newest request in each original direction that migration
-- 126/runtime Circle materialization explicitly superseded. Existing pending
-- requests win, and connections with another active origin stay connected.
WITH circle_only_connections AS (
  SELECT
    connection.id,
    connection.user_a_id,
    connection.user_b_id
  FROM connections connection
  WHERE EXISTS (
    SELECT 1
    FROM connection_origins origin
    WHERE origin.connection_id = connection.id
      AND origin.origin_kind = 'named_circle'
  )
    AND NOT EXISTS (
      SELECT 1
      FROM connection_origins origin
      WHERE origin.connection_id = connection.id
        AND origin.status = 'active'
        AND origin.origin_kind <> 'named_circle'
    )
),
ranked_superseded_requests AS (
  SELECT
    request.id,
    request.requester_user_id,
    request.addressee_user_id,
    ROW_NUMBER() OVER (
      PARTITION BY request.requester_user_id, request.addressee_user_id
      ORDER BY request.created_at DESC, request.id DESC
    ) AS request_rank
  FROM connection_requests request
  JOIN circle_only_connections connection
    ON request.metadata->>'supersededByConnectionId' = connection.id::text
   AND (
     (
       request.requester_user_id = connection.user_a_id
       AND request.addressee_user_id = connection.user_b_id
     )
     OR (
       request.requester_user_id = connection.user_b_id
       AND request.addressee_user_id = connection.user_a_id
     )
   )
  WHERE request.status = 'cancelled'
)
UPDATE connection_requests request
SET status = 'pending',
    responded_at = NULL,
    updated_at = NOW(),
    metadata = request.metadata - 'supersededByConnectionId'
FROM ranked_superseded_requests candidate
WHERE request.id = candidate.id
  AND candidate.request_rank = 1
  AND NOT EXISTS (
    SELECT 1
    FROM connection_requests pending
    WHERE pending.status = 'pending'
      AND pending.requester_user_id = candidate.requester_user_id
      AND pending.addressee_user_id = candidate.addressee_user_id
      AND pending.id <> candidate.id
  );

-- Connections backed only by named Circles did not exist before migration 126.
-- Revoke them before dropping their sole source so rollback cannot leave a
-- phantom active edge.
UPDATE connections connection
SET status = 'revoked',
    revoked_at = COALESCE(connection.revoked_at, NOW()),
    updated_at = NOW(),
    source = 'request'
WHERE EXISTS (
  SELECT 1
  FROM connection_origins origin
  WHERE origin.connection_id = connection.id
    AND origin.origin_kind = 'named_circle'
)
  AND NOT EXISTS (
    SELECT 1
    FROM connection_origins origin
    WHERE origin.connection_id = connection.id
      AND origin.status = 'active'
      AND origin.origin_kind <> 'named_circle'
  );

DROP TABLE IF EXISTS connection_origins;

ALTER TABLE connections
  DROP CONSTRAINT IF EXISTS connections_source_check;
ALTER TABLE connections
  ADD CONSTRAINT connections_source_check
  CHECK (source IN ('request', 'circle_invite', 'import'));

COMMENT ON TABLE one_location_circles IS
  'Named, metadata-only One Location groups. Membership grants no location access by itself.';
COMMENT ON TABLE one_location_circle_memberships IS
  'Owner/member relationship metadata for named Circles; explicit live-location grants remain authoritative.';

COMMIT;
