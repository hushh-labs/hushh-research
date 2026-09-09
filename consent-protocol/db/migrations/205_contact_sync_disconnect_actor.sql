BEGIN;

-- Domain authority for a fresh explicit sync to undo the requester's own
-- removal. Unknown historical actors remain suppressed until verified by the
-- bounded, dry-run-first backfill. No grants or Circle memberships change.
ALTER TABLE connections
  ADD COLUMN IF NOT EXISTS revoked_by_side TEXT,
  ADD COLUMN IF NOT EXISTS revoked_by_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'connections'::regclass AND conname = 'connections_revocation_actor_pair'
  ) THEN
    ALTER TABLE connections ADD CONSTRAINT connections_revocation_actor_pair
      CHECK (revoked_by_side IS NULL OR revoked_by_side IN ('a', 'b'));
  END IF;
END;
$$;

COMMENT ON COLUMN connections.revoked_by_side IS
  'Canonical participant side (a/b) of an explicit disconnect. Derives identity from immutable user_a_id/user_b_id without duplicating a mutable account reference.';
COMMENT ON COLUMN connections.revoked_by_at IS
  'Exact revoked_at episode that the actor belongs to. Equality is required so older writers cannot leave stale reconnection authority.';

-- Preserve migration 201 deletion guards on the immutable participant columns.
SELECT install_account_deletion_write_guards();

COMMIT;
