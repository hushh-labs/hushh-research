-- One Location: system-managed Circles, and the first of them.
--
-- SMS emergency contacts have lived in `one_location_sms_contacts` since 116:
-- a flat owner -> contact set, separate from the Circles graph entirely. That
-- split is what issue #5426 closes -- emergency contacts become a real Circle,
-- visible and manageable on the Circles surface like any other.
--
-- A real Circle brings one thing a flat set never had: it can be deleted. And
-- this one must not be. SOS resolves its recipients from it, so deleting it is
-- indistinguishable from silently switching emergency alerts off -- the failure
-- would surface at the worst possible moment, and only then. `is_system` marks
-- the Circles that carry that kind of dependency.
--
-- The guard is a trigger rather than only a service check, because "who may
-- delete this row" is a property of the row, not of whichever code path reached
-- it. A future admin script, a data repair, or a second service would otherwise
-- each have to remember.
--
-- Note what this migration deliberately does NOT do: it creates no Circle and
-- moves no member. Provisioning the SMS Circle and migrating the existing
-- contacts into it is done per-owner at bootstrap
-- (`ensure_sms_system_circle`), because the membership write has to fan out
-- through the connection graph the same way every other Circle join does, and
-- that lives in the service layer.

BEGIN;

ALTER TABLE one_location_circles
  ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN one_location_circles.is_system IS
  'True for Circles the product provisions and depends on (currently the SMS/Emergency Circle). Members can be added and removed normally; the Circle itself cannot be deleted -- enforced by one_location_circles_block_system_delete. Provisioned per owner by ensure_sms_system_circle, never by a person.';

-- At most one live system Circle per owner. `ensure_sms_system_circle` is a
-- find-or-create that may run on every login, from more than one device at
-- once; without this a race writes two and SOS starts reading whichever it
-- happens to find first.
--
-- Scoped to active rows so a rollback that soft-deletes one does not then block
-- a later re-provision.
CREATE UNIQUE INDEX IF NOT EXISTS uq_one_location_circles_owner_system
  ON one_location_circles (owner_user_id)
  WHERE is_system AND status = 'active';

CREATE OR REPLACE FUNCTION one_location_circles_block_system_delete()
RETURNS TRIGGER AS $$
BEGIN
  -- Hard delete.
  IF TG_OP = 'DELETE' THEN
    IF OLD.is_system THEN
      RAISE EXCEPTION
        'one_location_circles: system Circle % cannot be deleted', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  -- Soft delete. `delete_circle` never issues a DELETE -- it moves status to
  -- 'deleted' and stamps deleted_at -- so guarding only the hard path would
  -- guard the path nothing actually takes.
  IF OLD.is_system
     AND OLD.status = 'active'
     AND NEW.status = 'deleted' THEN
    RAISE EXCEPTION
      'one_location_circles: system Circle % cannot be deleted', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS one_location_circles_block_system_delete
  ON one_location_circles;

CREATE TRIGGER one_location_circles_block_system_delete
  BEFORE DELETE OR UPDATE ON one_location_circles
  FOR EACH ROW
  EXECUTE FUNCTION one_location_circles_block_system_delete();

COMMIT;
