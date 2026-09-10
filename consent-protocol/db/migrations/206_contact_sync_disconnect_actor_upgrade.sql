BEGIN;

-- Migration 205 briefly stored the disconnecting actor as a mutable user ID.
-- It was later corrected to the immutable participant side, but replay-mode
-- environments can already contain the earlier column and its exact-episode
-- annotations. Preserve those verified historical removals during the
-- expand-only upgrade; unknown, stale, and non-participant values stay NULL
-- and therefore fail closed for automatic reconnection.
ALTER TABLE connections
  ADD COLUMN IF NOT EXISTS revoked_by_side TEXT,
  ADD COLUMN IF NOT EXISTS revoked_by_at TIMESTAMPTZ;

DO $$
DECLARE
  has_legacy_actor_column BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'connections'
      AND column_name = 'revoked_by_user_id'
  )
  INTO has_legacy_actor_column;

  IF has_legacy_actor_column THEN
    EXECUTE $upgrade$
      UPDATE connections
      SET revoked_by_side = CASE
        WHEN user_a_id = revoked_by_user_id THEN 'a'
        WHEN user_b_id = revoked_by_user_id THEN 'b'
      END
      WHERE revoked_by_side IS NULL
        AND revoked_by_at = revoked_at
        AND revoked_by_user_id IN (user_a_id, user_b_id)
    $upgrade$;
  END IF;

  -- 205 may have installed the old constraint under this same name. Replace
  -- it on every replay so upgraded databases enforce the current invariant.
  ALTER TABLE connections
    DROP CONSTRAINT IF EXISTS connections_revocation_actor_pair;
  ALTER TABLE connections
    ADD CONSTRAINT connections_revocation_actor_pair
    CHECK (revoked_by_side IS NULL OR revoked_by_side IN ('a', 'b'));
END;
$$;

COMMENT ON COLUMN connections.revoked_by_side IS
  'Canonical participant side (a/b) of an explicit disconnect. Historical user-ID annotations are upgraded only when they match an immutable participant and the current revocation episode.';

COMMIT;
