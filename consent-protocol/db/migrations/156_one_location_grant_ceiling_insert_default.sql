-- One Location: guarantee ceiling_expires_at is never silently left NULL on a
-- newly-inserted timed grant, no matter which code path performs the insert.
--
-- 155 taught every INSERT path this codebase's application code is aware of
-- to write ceiling_expires_at = expires_at at creation time. In practice, a
-- grant has still been observed reaching the table with expires_at correctly
-- set but ceiling_expires_at NULL, on the "Safety check-in" auto-approval
-- flow specifically -- one that produces no HTTP access-log line and no
-- application-level log line for its grant creation, so the exact caller
-- could not be pinned down by reading code or watching logs. Rather than
-- keep hunting for one more call site (and risk missing the next one, or the
-- next feature that mints a grant), this closes the gap at the only point
-- that can see every insert regardless of which Python path produced it: the
-- table itself.
--
-- INSERT-only, deliberately. shorten_grant's whole job is moving expires_at
-- on an UPDATE without ever touching the ceiling -- a trigger that also fired
-- on UPDATE would silently overwrite that every time a grant is shortened,
-- reopening the exact bug 155 fixed.
--
-- Only fills in what is missing: a grant with no expires_at (until_stopped)
-- keeps ceiling_expires_at NULL, matching the no-known-ceiling fallback both
-- shorten_grant and the frontend already implement. A row that already names
-- an explicit ceiling is left exactly as given.

BEGIN;

CREATE OR REPLACE FUNCTION one_location_grant_default_ceiling()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.ceiling_expires_at IS NULL AND NEW.expires_at IS NOT NULL THEN
    NEW.ceiling_expires_at := NEW.expires_at;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS one_location_share_grants_default_ceiling ON one_location_share_grants;
CREATE TRIGGER one_location_share_grants_default_ceiling
  BEFORE INSERT ON one_location_share_grants
  FOR EACH ROW
  EXECUTE FUNCTION one_location_grant_default_ceiling();

COMMENT ON FUNCTION one_location_grant_default_ceiling() IS
  'Backstops 155: any INSERT that leaves ceiling_expires_at NULL while expires_at is set gets ceiling_expires_at defaulted to expires_at. Never fires on UPDATE -- shorten_grant must keep moving expires_at without ever touching the ceiling.';

-- One-time catch-up for rows this gap already produced, so today's active
-- grants stop being shorten-only immediately rather than waiting for their
-- next full recreation.
UPDATE one_location_share_grants
SET ceiling_expires_at = expires_at
WHERE status = 'active'
  AND ceiling_expires_at IS NULL
  AND expires_at IS NOT NULL;

COMMIT;
