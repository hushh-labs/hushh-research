-- One Location: raise the invite-code use ceiling to match 100-member Circles.
--
-- 134 bound `max_uses` to the old 20-member cap: column default 20 and inline
-- CHECK (max_uses BETWEEN 1 AND 20). 158 raised `one_location_circles.member_limit`
-- to 100 but never touched this table, so `create_code`'s
-- `max_uses = member_limit - 1` now computes 99 for any circle sitting at the
-- new default -- and the INSERT fails that stale CHECK on every call. That
-- IntegrityError is exactly what `_safe_db_failure` turns into "Circle service
-- is temporarily unavailable", so every invite-code creation has been failing
-- since 158 shipped. This migration is the other half of 158.

BEGIN;

-- 134 declared the bound inline, so Postgres auto-named it
-- `one_location_circle_invite_codes_max_uses_check`. Dropping by that name
-- covers every environment migrated from 134 forward; the DO block behind it
-- catches any environment where the constraint carries a different name (a
-- hand-repaired database, or a restore that re-derived it), so the old
-- 20-use ceiling cannot survive this migration in one environment and not
-- another. Scoped to CHECK constraints whose definition actually mentions
-- max_uses, so the sibling `use_count BETWEEN 0 AND max_uses` check (which
-- also references the column but is not a fixed bound) is never a candidate.
ALTER TABLE one_location_circle_invite_codes
  DROP CONSTRAINT IF EXISTS one_location_circle_invite_codes_max_uses_check;

DO $$
DECLARE
  stale_constraint TEXT;
BEGIN
  FOR stale_constraint IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE rel.relname = 'one_location_circle_invite_codes'
      AND nsp.nspname = current_schema()
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%max_uses%'
      AND pg_get_constraintdef(con.oid) NOT ILIKE '%use_count%'
      AND con.conname <> 'one_location_circle_invite_codes_max_uses_bounds'
  LOOP
    EXECUTE format(
      'ALTER TABLE one_location_circle_invite_codes DROP CONSTRAINT %I',
      stale_constraint
    );
  END LOOP;
END
$$;

ALTER TABLE one_location_circle_invite_codes
  ADD CONSTRAINT one_location_circle_invite_codes_max_uses_bounds
    CHECK (max_uses BETWEEN 1 AND 100);

ALTER TABLE one_location_circle_invite_codes
  ALTER COLUMN max_uses SET DEFAULT 100;

COMMENT ON COLUMN one_location_circle_invite_codes.max_uses IS
  'How many times this code may be redeemed, stamped at INSERT from the owning Circle''s member_limit - 1. Defaults to 100 (raised from 20 in migration 159, matching the member_limit ceiling raised in 158) and is bounded 1..100 by one_location_circle_invite_codes_max_uses_bounds.';

COMMIT;
