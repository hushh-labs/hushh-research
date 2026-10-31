-- Reverse 159: return the invite-code use ceiling to 20.
--
-- Mirrors 158's rollback rather than 134's original shape: by the time anyone
-- reverses this, live codes may already carry a `max_uses` up to 99 from
-- Circles at the 100-member default, and a hard 1..20 CHECK would make those
-- rows violate their own invariant. So this reverses the CAPABILITY without
-- rewriting rows that already exist:
--
--   * The default returns to 20, so every code created after the rollback is
--     bounded exactly as it was before 159.
--   * The 1..20 bound is re-added NOT VALID -- it still governs every future
--     INSERT and UPDATE from this point on, and only declines to re-scan rows
--     that already exist. Codes already sitting above 20 are left alone
--     rather than truncated, which would silently shrink how many people a
--     circle owner already told could redeem their code.

BEGIN;

ALTER TABLE one_location_circle_invite_codes
  DROP CONSTRAINT IF EXISTS one_location_circle_invite_codes_max_uses_bounds;

ALTER TABLE one_location_circle_invite_codes
  ALTER COLUMN max_uses SET DEFAULT 20;

ALTER TABLE one_location_circle_invite_codes
  ADD CONSTRAINT one_location_circle_invite_codes_max_uses_check
    CHECK (max_uses BETWEEN 1 AND 20) NOT VALID;

COMMENT ON COLUMN one_location_circle_invite_codes.max_uses IS
  'How many times this code may be redeemed.';

COMMIT;
