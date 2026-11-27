-- Older services only understand standing approval. Withdraw a timed rule
-- before dropping its deadline and invalidate its outstanding rule version.
LOCK TABLE one_location_auto_approve_preferences IN ACCESS EXCLUSIVE MODE;
UPDATE one_location_auto_approve_preferences
SET enabled = FALSE, enabled_at = NULL, expires_at = NULL, scope_kind = NULL,
    circle_id = NULL, circle_ids = NULL, rule_version = rule_version + 1,
    updated_at = clock_timestamp()
WHERE scope_kind = 'timed';

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

ALTER TABLE one_location_auto_approve_preferences DROP COLUMN expires_at;
