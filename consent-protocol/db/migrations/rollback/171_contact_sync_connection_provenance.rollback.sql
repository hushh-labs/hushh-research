-- Rollback 171: preserve independent relationships without widening consent.

BEGIN;

-- A rollback changes both the authority ledger and its relationship
-- projections. It must never classify one live snapshot and clean up another.
-- `NOWAIT` is an enforced traffic-drain gate: if any contact/connection/Circle
-- writer is in flight, the transaction aborts without changing data and the
-- operator retries after draining writes. EXCLUSIVE still permits ordinary
-- read-only traffic while blocking SELECT FOR UPDATE and every mutation.
LOCK TABLE
  actor_identity_cache,
  actor_profiles,
  connections,
  connection_origins,
  trusted_connections,
  one_location_circles,
  one_location_circle_memberships
IN EXCLUSIVE MODE NOWAIT;

-- Do not translate contact-only authority into the legacy `import` kind.
-- Older runtimes do not know that such an import must stay outside standing
-- Location auto-approval, so doing that would turn a software rollback into a
-- consent expansion. Capture affected pairs before removing the new origin.
CREATE TEMP TABLE contact_sync_rollback_connections ON COMMIT DROP AS
SELECT
  connection.id AS connection_id,
  connection.user_a_id,
  connection.user_b_id,
  NOT EXISTS (
    SELECT 1
    FROM connection_origins independent_origin
    WHERE independent_origin.connection_id = connection.id
      AND independent_origin.status = 'active'
      AND independent_origin.origin_kind <> 'contact_sync'
  ) AS contact_only
FROM connections connection
WHERE EXISTS (
  SELECT 1
  FROM connection_origins contact_origin
  WHERE contact_origin.connection_id = connection.id
    AND contact_origin.status = 'active'
    AND contact_origin.origin_kind = 'contact_sync'
);

CREATE UNIQUE INDEX contact_sync_rollback_connections_id
  ON contact_sync_rollback_connections (connection_id);

-- A contact-only pair has no authority the old runtime can represent safely.
-- Keep the revoked canonical row as the suppression tombstone, and revoke its
-- mirrored projections in the same transaction. Independent active origins
-- are handled below and keep their relationship alive.
UPDATE trusted_connections trusted
SET
  status = 'revoked',
  revoked_at = NOW(),
  updated_at = NOW()
FROM contact_sync_rollback_connections affected
WHERE affected.contact_only
  AND trusted.status = 'active'
  AND (
    (
      trusted.owner_user_id = affected.user_a_id
      AND trusted.trusted_user_id = affected.user_b_id
    )
    OR (
      trusted.owner_user_id = affected.user_b_id
      AND trusted.trusted_user_id = affected.user_a_id
    )
  );

UPDATE one_location_circle_memberships membership
SET
  status = 'removed',
  ended_at = NOW(),
  updated_at = NOW(),
  metadata = COALESCE(membership.metadata, '{}'::jsonb)
    || jsonb_build_object('endedBy', 'contact_sync_rollback')
FROM one_location_circles circle,
     contact_sync_rollback_connections affected
WHERE affected.contact_only
  AND circle.id = membership.circle_id
  AND circle.status = 'active'
  AND circle.system_kind = 'trusted'
  AND membership.status = 'active'
  AND membership.role = 'member'
  AND (
    (
      circle.owner_user_id = affected.user_a_id
      AND membership.user_id = affected.user_b_id
    )
    OR (
      circle.owner_user_id = affected.user_b_id
      AND membership.user_id = affected.user_a_id
    )
  );

UPDATE connections connection
SET
  status = 'revoked',
  revoked_at = NOW(),
  updated_at = NOW()
FROM contact_sync_rollback_connections affected
WHERE affected.contact_only
  AND connection.id = affected.connection_id;

DELETE FROM connection_origins WHERE origin_kind = 'contact_sync';

UPDATE connections connection
SET
  status = 'active',
  source = CASE
    WHEN EXISTS (
      SELECT 1
      FROM connection_origins origin
      WHERE origin.connection_id = connection.id
        AND origin.status = 'active'
        AND origin.origin_kind = 'direct_request'
    ) THEN 'request'
    WHEN EXISTS (
      SELECT 1
      FROM connection_origins origin
      WHERE origin.connection_id = connection.id
        AND origin.status = 'active'
        AND origin.origin_kind IN ('circle_member', 'legacy_invite')
    ) THEN 'circle_invite'
    WHEN EXISTS (
      SELECT 1
      FROM connection_origins origin
      WHERE origin.connection_id = connection.id
        AND origin.status = 'active'
        AND origin.origin_kind = 'import'
    ) THEN 'import'
    ELSE 'named_circle'
  END,
  revoked_at = NULL,
  updated_at = NOW()
FROM contact_sync_rollback_connections affected
WHERE NOT affected.contact_only
  AND connection.id = affected.connection_id;

DROP INDEX IF EXISTS idx_connection_origins_active_contact_source;

ALTER TABLE connection_origins
  DROP CONSTRAINT IF EXISTS connection_origins_origin_kind_check;
ALTER TABLE connection_origins
  ADD CONSTRAINT connection_origins_origin_kind_check
  CHECK (origin_kind IN (
    'direct_request', 'named_circle', 'circle_member', 'legacy_invite', 'import'
  ));

ALTER TABLE connection_origins
  DROP CONSTRAINT IF EXISTS connection_origins_kind_shape;
ALTER TABLE connection_origins
  ADD CONSTRAINT connection_origins_kind_shape CHECK (
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
  );

DROP TABLE IF EXISTS contact_sync_lookup_budgets;
ALTER TABLE actor_profiles DROP COLUMN IF EXISTS contact_sync_consent_contract_version;
ALTER TABLE actor_profiles DROP COLUMN IF EXISTS contact_sync_consent_rule_version;
ALTER TABLE actor_profiles DROP COLUMN IF EXISTS contact_sync_consent_enabled_at;
ALTER TABLE actor_profiles ALTER COLUMN contact_discoverable SET DEFAULT TRUE;

COMMIT;
