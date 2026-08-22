-- Reverse 163. Shape back, data kept -- the same trade 160's rollback makes.
--
-- A Trusted Circle survives this as an ORDINARY Circle, holding every member it
-- had. It becomes renameable, deletable and code-mintable by its owner, because
-- the column that marked it is gone. Deleting them here to "clean up" would
-- destroy a roster; the members are all people the owner is connected to
-- anyway, and the owner can remove the Circle themselves if they want to.
--
-- Note what this rollback does NOT have to undo. Trusted Circles were never
-- `is_system`, so 160's uq_one_location_circles_owner_system and its
-- single-slot guarantee were never touched and need no repair -- and no
-- demotion pass is needed before the index is restored, because there is
-- nothing to demote.

BEGIN;

-- The trigger goes back to 160's exact definition: is_system only. It must be
-- restored BEFORE the column is dropped, or the function body still references
-- a column that no longer exists and the next write raises.
CREATE OR REPLACE FUNCTION one_location_circles_block_system_delete()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.is_system THEN
      RAISE EXCEPTION
        'one_location_circles: system Circle % cannot be deleted', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

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

DROP INDEX IF EXISTS uq_one_location_circles_owner_system_kind;

-- The member_limit CHECK is deliberately untouched here, because the forward
-- migration no longer touches it either. An earlier draft of 163 widened it so
-- a Trusted Circle could carry SMALLINT's ceiling; that turned out to be unsafe
-- under replay -- 158 sits ahead of 163 in the manifest and re-narrows the
-- bound on every deploy -- so a Trusted Circle now stores the ordinary default
-- and 158's 2..100 is the only definition this column has ever had after 158.
--
-- The clamp that used to live here is gone with it. Nothing this rollback drops
-- can leave a row outside 2..100, so there is nothing to repair before the
-- column goes.

ALTER TABLE one_location_circles
  DROP CONSTRAINT IF EXISTS one_location_circles_system_kind_values;

ALTER TABLE one_location_circles
  DROP COLUMN IF EXISTS system_kind;

COMMIT;
