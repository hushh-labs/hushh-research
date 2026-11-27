-- Timed rules use a scope discriminator older runtimes refuse to authorize.
ALTER TABLE one_location_auto_approve_preferences
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

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
        OR (
          scope_kind = 'timed' AND expires_at IS NOT NULL AND expires_at > enabled_at
          AND (
            circle_ids IS NULL
            OR (circle_id IS NULL AND cardinality(circle_ids) > 0)
          )
        )
      )
    )
  ) NOT VALID;

ALTER TABLE one_location_auto_approve_preferences
  VALIDATE CONSTRAINT one_location_auto_approve_scope_check;
