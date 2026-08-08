BEGIN;

-- Roll back migration 138.
--
-- Rows written by the new join behavior must go before the constraint can
-- narrow again, otherwise the ALTER fails validation. Revoking rather than
-- deleting keeps the audit trail, so recompute the aggregate afterwards and
-- retire any connection left with no live provenance.
UPDATE connections connection
SET status = 'revoked',
    revoked_at = COALESCE(connection.revoked_at, NOW()),
    updated_at = NOW()
WHERE connection.status = 'active'
  AND EXISTS (
    SELECT 1 FROM connection_origins origin
    WHERE origin.connection_id = connection.id
      AND origin.origin_kind = 'circle_member'
      AND origin.status = 'active'
  )
  AND NOT EXISTS (
    SELECT 1 FROM connection_origins origin
    WHERE origin.connection_id = connection.id
      AND origin.origin_kind <> 'circle_member'
      AND origin.status = 'active'
  );

DELETE FROM connection_origins WHERE origin_kind = 'circle_member';

ALTER TABLE connection_origins
  DROP CONSTRAINT IF EXISTS connection_origins_origin_kind_check;

ALTER TABLE connection_origins
  ADD CONSTRAINT connection_origins_origin_kind_check
  CHECK (origin_kind IN (
    'direct_request',
    'named_circle',
    'legacy_invite',
    'import'
  ));

COMMIT;
