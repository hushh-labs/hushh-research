BEGIN;

-- The old schema cannot represent a multi-Circle scope. Fail closed: turn
-- auto-approve off for anyone currently scoped to 'circles' rather than
-- silently widening or narrowing their standing consent to something they
-- did not choose. bumping rule_version so any in-flight automatic approval
-- re-checks under lock and finds it disabled.
UPDATE one_location_auto_approve_preferences
SET enabled = FALSE,
    scope_kind = NULL,
    circle_id = NULL,
    circle_ids = NULL,
    enabled_at = NULL,
    rule_version = rule_version + 1,
    updated_at = NOW()
WHERE scope_kind = 'circles';

ALTER TABLE one_location_auto_approve_preferences
  DROP CONSTRAINT IF EXISTS one_location_auto_approve_scope_check;

ALTER TABLE one_location_auto_approve_preferences
  ADD CONSTRAINT one_location_auto_approve_scope_check CHECK (
    (
      NOT enabled
      AND scope_kind IS NULL
      AND circle_id IS NULL
      AND enabled_at IS NULL
    )
    OR
    (
      enabled
      AND enabled_at IS NOT NULL
      AND (
        (scope_kind = 'all_contacts' AND circle_id IS NULL)
        OR
        (scope_kind = 'circle' AND circle_id IS NOT NULL)
      )
    )
  ) NOT VALID;

ALTER TABLE one_location_auto_approve_preferences
  VALIDATE CONSTRAINT one_location_auto_approve_scope_check;

ALTER TABLE one_location_auto_approve_preferences
  DROP COLUMN IF EXISTS circle_ids;

COMMIT;
