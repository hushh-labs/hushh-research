BEGIN;

-- Roll back application readers before this migration. Keep the additive
-- side/episode annotations intact: the previous schema can ignore them, while
-- removing them would discard verified historical disconnect evidence.
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

  ALTER TABLE connections
    DROP CONSTRAINT IF EXISTS connections_revocation_actor_pair;

  IF has_legacy_actor_column THEN
    ALTER TABLE connections
      ADD CONSTRAINT connections_revocation_actor_pair
      CHECK (
        revoked_by_user_id IS NULL
        OR revoked_by_user_id IN (user_a_id, user_b_id)
      );
  ELSE
    ALTER TABLE connections
      ADD CONSTRAINT connections_revocation_actor_pair
      CHECK (revoked_by_side IS NULL OR revoked_by_side IN ('a', 'b'));
  END IF;
END;
$$;

COMMIT;
