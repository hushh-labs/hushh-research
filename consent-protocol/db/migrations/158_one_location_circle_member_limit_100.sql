-- One Location: raise the per-Circle member ceiling from 20 to 100.
--
-- 134 wrote the cap twice -- as the column default and as an inline
-- `CHECK (member_limit BETWEEN 2 AND 20)` -- so raising it needs both, plus a
-- decision about the circles that already exist.
--
-- Those circles carry a stored `member_limit` of 20. Nothing in the product
-- ever lets a person choose that number: `CIRCLE_DEFAULT_MEMBER_LIMIT` is
-- stamped on at INSERT and never edited afterwards, so a stored 20 is not a
-- preference anyone expressed -- it is the old default, frozen onto the row.
-- Leaving it would mean shipping "circles hold 100" while every circle that
-- exists today still stops at 20, which is the same bug reported one release
-- later. So rows still sitting at exactly the old default are lifted with it.
--
-- Rows holding any OTHER value are left untouched. There is no UI that
-- produces one today, but a hand-set ceiling is the one case where the number
-- does carry intent, and a blanket UPDATE would erase it.
--
-- Widening a CHECK can never invalidate a row that already satisfies it
-- (2..20 is wholly inside 2..100), so this needs no NOT VALID escape and no
-- table scan beyond the one the UPDATE already pays for.

BEGIN;

-- 134 declared the bound inline, so Postgres auto-named it
-- `one_location_circles_member_limit_check`. Dropping by that name covers
-- every environment migrated from 134 forward; the DO block behind it catches
-- any environment where the constraint was created under a different name
-- (a hand-repaired database, or a restore that re-derived it), so the old
-- 20-ceiling cannot survive this migration in one environment and not
-- another. Both are scoped to CHECK constraints whose definition actually
-- mentions member_limit -- the name-not-blank and kind/status checks on this
-- table are never candidates.
ALTER TABLE one_location_circles
  DROP CONSTRAINT IF EXISTS one_location_circles_member_limit_check;

DO $$
DECLARE
  stale_constraint TEXT;
BEGIN
  FOR stale_constraint IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE rel.relname = 'one_location_circles'
      AND nsp.nspname = current_schema()
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%member_limit%'
      AND con.conname <> 'one_location_circles_member_limit_bounds'
  LOOP
    EXECUTE format(
      'ALTER TABLE one_location_circles DROP CONSTRAINT %I',
      stale_constraint
    );
  END LOOP;
END
$$;

-- Same name, dropped and re-added together: the DO block above deliberately
-- leaves a constraint already carrying this name untouched, so a replay
-- against an environment where this migration already ran would otherwise
-- collide with the ADD below.
ALTER TABLE one_location_circles
  DROP CONSTRAINT IF EXISTS one_location_circles_member_limit_bounds;

ALTER TABLE one_location_circles
  ADD CONSTRAINT one_location_circles_member_limit_bounds
    CHECK (member_limit BETWEEN 2 AND 100);

ALTER TABLE one_location_circles
  ALTER COLUMN member_limit SET DEFAULT 100;

-- Only the frozen old default, never a deliberately different ceiling.
UPDATE one_location_circles
SET member_limit = 100,
    updated_at = now()
WHERE member_limit = 20;

COMMENT ON COLUMN one_location_circles.member_limit IS
  'Maximum active members this Circle may hold, including the owner. Defaults to 100 (raised from 20 in migration 158) and is stamped at INSERT from CIRCLE_DEFAULT_MEMBER_LIMIT; no product surface edits it. Bounded 2..100 by one_location_circles_member_limit_bounds.';

COMMIT;
