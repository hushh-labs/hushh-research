-- One Location: system Circles get a kind, so an owner can have more than one.
--
-- 160 marked the Circles the product provisions and depends on with a single
-- boolean and enforced "at most one live one per owner". That was right while
-- there was one kind. Trusted (#5458) is a second, and the boolean makes the
-- second unrepresentable.
--
-- The obvious move is to re-key uq_one_location_circles_owner_system from
-- (owner_user_id) to (owner_user_id, system_kind). This migration deliberately
-- does NOT do that, for two reasons.
--
-- 1. THE ROLLBACK HAZARD. `_find_system_circle_id` is
--
--        SELECT id FROM one_location_circles
--        WHERE owner_user_id = :owner AND is_system AND status = 'active'
--        LIMIT 1
--
--    with no ORDER BY. An image that predates this work, running against a
--    database that already holds Trusted rows, can pick the Trusted Circle --
--    and `ensure_sms_system_circle` will then rename it "SMS Circle", drop its
--    member_limit to 10, and SOS will resolve its recipients from it. That is
--    an emergency alert, carrying an address, to everyone the owner is
--    connected to. Marking Trusted with `system_kind` while leaving
--    `is_system` FALSE makes that query structurally unable to see it, instead
--    of relying on which revision happens to be deployed.
--
-- 2. THE REPLAY TRAP. Every environment deploys with `--migration-mode
--    replay`, which skips the ledger and re-runs every migration on every
--    deploy. `CREATE UNIQUE INDEX IF NOT EXISTS <name>` matches on NAME ONLY,
--    so recreating an index under an existing name with a different predicate
--    is a silent no-op: the database keeps the old definition and the
--    migration reports success. Not touching 160's index avoids that entirely.
--
-- So `is_system` keeps exactly the meaning it has today -- the SMS Circle, and
-- the single-slot index that protects it -- and `system_kind` becomes the axis
-- that admits a second kind. The delete guard grows to cover both, because
-- "who may delete this row" is still a property of the row.
--
-- This migration creates no Circle and moves no member. Provisioning stays in
-- the service, where a membership write can fan out through the connection
-- graph the way every other Circle join does.

BEGIN;

ALTER TABLE one_location_circles
  ADD COLUMN IF NOT EXISTS system_kind VARCHAR(16);

-- Replay-safe: the guard means a second run finds nothing to do, and it can
-- never overwrite a kind a later migration or an operator set.
UPDATE one_location_circles
SET system_kind = 'sms', updated_at = now()
WHERE is_system
  AND system_kind IS NULL;

-- Drop-then-add, per 158/159: Postgres has no ADD CONSTRAINT IF NOT EXISTS and
-- the deploy lane replays.
ALTER TABLE one_location_circles
  DROP CONSTRAINT IF EXISTS one_location_circles_system_kind_values;
ALTER TABLE one_location_circles
  ADD CONSTRAINT one_location_circles_system_kind_values
    CHECK (system_kind IS NULL OR system_kind IN ('sms', 'trusted'));

-- One live Circle per (owner, kind). Both provisioners are find-or-create
-- hooks that run on bootstrap, from more than one device at once; without this
-- a race writes two and whichever is found first wins.
--
-- Keyed on system_kind rather than is_system, and scoped to active rows so a
-- soft-deleted row never blocks a re-provision -- the same reasoning 160 gives
-- for its own index, which is left in place and still protects the SMS slot.
CREATE UNIQUE INDEX IF NOT EXISTS uq_one_location_circles_owner_system_kind
  ON one_location_circles (owner_user_id, system_kind)
  WHERE system_kind IS NOT NULL AND status = 'active';

-- The delete guard now protects both kinds.
--
-- 160's version keyed on OLD.is_system alone. A Trusted Circle is not
-- is_system -- see the header -- so without this it would be deletable, and
-- deleting it would silently drop everyone out of the grouping the product
-- says holds everyone they are connected to.
CREATE OR REPLACE FUNCTION one_location_circles_block_system_delete()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.is_system OR OLD.system_kind IS NOT NULL THEN
      RAISE EXCEPTION
        'one_location_circles: system Circle % cannot be deleted', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  -- Soft delete. `delete_circle` never issues a DELETE -- it moves status to
  -- 'deleted' -- so guarding only the hard path would guard the path nothing
  -- actually takes.
  IF (OLD.is_system OR OLD.system_kind IS NOT NULL)
     AND OLD.status = 'active'
     AND NEW.status = 'deleted' THEN
    RAISE EXCEPTION
      'one_location_circles: system Circle % cannot be deleted', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Account deletion demotes and then deletes (account_service.py). That escape
-- has to keep working for both kinds, so the guard above reads system_kind --
-- and the demotion has to clear BOTH the flag and the kind, or this guard is
-- what refuses the DELETE it exists to permit. The service clears both; the
-- test that proves it is in tests/services/test_account_service_cleanup_tables.py.

-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO: widen the member_limit CHECK.
--
-- A Trusted Circle mirrors the connection graph and connections are not
-- capped, so 158's 2..100 looks like the wrong bound for it and an earlier
-- draft of this file widened the constraint to allow SMALLINT's ceiling for
-- `system_kind = 'trusted'`.
--
-- That is unsafe under replay, and not for the reason the REPLAY TRAP note
-- above describes. Every environment deploys with `--migration-mode replay`,
-- which runs every file in the manifest on every deploy, in manifest order --
-- and 158 sits at index 135, ahead of this file at 139. 158 ends with a plain
-- DROP CONSTRAINT / ADD CONSTRAINT ... CHECK (member_limit BETWEEN 2 AND 100),
-- with no NOT VALID, so the ADD validates the whole table. Widening the bound
-- here does not stop 158 re-narrowing it on the NEXT deploy, by which time
-- Trusted Circles exist: 158 then raises 23514 and every subsequent UAT and
-- production release fails at the migration step until somebody repairs the
-- database by hand. Reproduced on Postgres 16.
--
-- So the ceiling stays where 158 put it and a Trusted Circle stores the
-- ordinary default instead. Nothing is lost by that: no Trusted write path
-- consults member_limit -- the reconcile is one INSERT ... SELECT with no
-- capacity check, by design, and the accept hook is a plain upsert -- and
-- `_circle_summary` reports `memberLimit: null` for a Trusted Circle from
-- `is_trusted`, never from the stored number. The column is a default for
-- Circles a person curates by hand, and it goes on meaning only that.

COMMENT ON COLUMN one_location_circles.system_kind IS
  'Which product-managed Circle this is: ''sms'' (emergency roster, SOS reads it) or ''trusted'' (a projection of the accepted-connection graph). NULL for every Circle a person named themselves. At most one live Circle per (owner, kind). A trusted Circle deliberately leaves is_system FALSE so that pre-163 code, whose system-Circle lookup is `WHERE is_system ... LIMIT 1` with no ORDER BY, can never mistake it for the SMS Circle.';

COMMIT;
