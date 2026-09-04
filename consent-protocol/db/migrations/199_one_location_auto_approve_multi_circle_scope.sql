BEGIN;

-- #6468: auto-approve could target "all contacts" or exactly one Circle.
-- Requested: pick any combination of Circles, not just one. `circle_id`
-- (singular) is left alone -- existing single-Circle preferences keep
-- working unmigrated -- and a new `circle_ids` array carries the multi-Circle
-- case under its own scope_kind, mutually exclusive with the other two.
ALTER TABLE one_location_auto_approve_preferences
  ADD COLUMN IF NOT EXISTS circle_ids UUID[];

ALTER TABLE one_location_auto_approve_preferences
  DROP CONSTRAINT IF EXISTS one_location_auto_approve_scope_check;

ALTER TABLE one_location_auto_approve_preferences
  ADD CONSTRAINT one_location_auto_approve_scope_check CHECK (
    (
      NOT enabled
      AND scope_kind IS NULL
      AND circle_id IS NULL
      AND circle_ids IS NULL
      AND enabled_at IS NULL
    )
    OR
    (
      enabled
      AND enabled_at IS NOT NULL
      AND (
        (scope_kind = 'all_contacts' AND circle_id IS NULL AND circle_ids IS NULL)
        OR
        (scope_kind = 'circle' AND circle_id IS NOT NULL AND circle_ids IS NULL)
        OR
        (
          scope_kind = 'circles'
          AND circle_id IS NULL
          AND circle_ids IS NOT NULL
          AND cardinality(circle_ids) > 0
        )
      )
    )
  ) NOT VALID;

ALTER TABLE one_location_auto_approve_preferences
  VALIDATE CONSTRAINT one_location_auto_approve_scope_check;

COMMENT ON COLUMN one_location_auto_approve_preferences.circle_ids IS
  'Owned Circles auto-approve applies to when scope_kind = ''circles''. Mutually exclusive with circle_id.';

COMMIT;
