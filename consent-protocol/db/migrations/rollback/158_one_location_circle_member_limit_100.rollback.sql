-- Reverse 158: return the per-Circle ceiling to 20.
--
-- The forward migration is not symmetric, and pretending otherwise is what
-- would corrupt data here. By the time anyone rolls this back, circles may
-- legitimately hold more than 20 members -- and a Circle whose roster already
-- exceeds a ceiling we have just re-imposed is a state the product has no way
-- to represent or repair.
--
-- So this reverses the CAPABILITY without rewriting history:
--
--   * The default returns to 20, so every Circle created after the rollback
--     is bounded exactly as it was before 158.
--   * `member_limit` drops back to 20 only for circles that can actually live
--     inside it -- those whose active roster is 20 or fewer. A circle that
--     grew past 20 while the higher ceiling was live keeps its 100, because
--     the alternative is a row that violates its own invariant.
--   * The 2..20 bound is re-added NOT VALID. A CHECK marked NOT VALID still
--     governs every INSERT and UPDATE from this point on -- it only declines
--     to re-scan rows that already exist. That is precisely the distinction
--     needed: new writes are bounded at 20 again, and the handful of circles
--     that outgrew it are left alone rather than blocking the rollback.
--
-- Dropping those larger circles back to 20 would be the only way to restore
-- the original constraint as VALID, and it would mean silently deciding which
-- 80 of someone's 100 members stop mattering. Not a migration's call.

BEGIN;

ALTER TABLE one_location_circles
  DROP CONSTRAINT IF EXISTS one_location_circles_member_limit_bounds;

ALTER TABLE one_location_circles
  ALTER COLUMN member_limit SET DEFAULT 20;

UPDATE one_location_circles AS c
SET member_limit = 20,
    updated_at = now()
WHERE c.member_limit = 100
  AND (
    SELECT count(*)
    FROM one_location_circle_memberships m
    WHERE m.circle_id = c.id
      AND m.status = 'active'
  ) <= 20;

ALTER TABLE one_location_circles
  ADD CONSTRAINT one_location_circles_member_limit_check
    CHECK (member_limit BETWEEN 2 AND 20) NOT VALID;

COMMENT ON COLUMN one_location_circles.member_limit IS
  'Maximum active members this Circle may hold, including the owner.';

COMMIT;
