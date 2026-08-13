-- Reverse 148 by restoring the two-source constraints from migration 058.
--
-- Any nws_nearby rows must go first: they are legal only under the widened
-- constraint, so re-adding the original CHECK with them present would fail.
-- Deleting them is correct rather than lossy — they are an advisor's own
-- shortlist of public records, reproducible by searching again, and there is
-- no narrower table to move them to once this feature is rolled back.

BEGIN;

DELETE FROM marketplace_investor_actions WHERE source_type = 'nws_nearby';

DROP INDEX IF EXISTS idx_marketplace_investor_actions_actor_source;

ALTER TABLE marketplace_investor_actions
  DROP CONSTRAINT IF EXISTS marketplace_investor_actions_target_check;
ALTER TABLE marketplace_investor_actions
  ADD CONSTRAINT marketplace_investor_actions_target_check
    CHECK (
      (source_type = 'public_sec' AND public_profile_id IS NOT NULL AND target_user_id IS NULL)
      OR
      (source_type = 'hushh_user' AND target_user_id IS NOT NULL AND public_profile_id IS NULL)
    );

ALTER TABLE marketplace_investor_actions
  DROP CONSTRAINT IF EXISTS marketplace_investor_actions_source_type_check;
ALTER TABLE marketplace_investor_actions
  ADD CONSTRAINT marketplace_investor_actions_source_type_check
    CHECK (source_type IN ('hushh_user', 'public_sec'));

COMMIT;
