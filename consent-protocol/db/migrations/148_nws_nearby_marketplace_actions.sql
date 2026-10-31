-- Admit NWS Nearby Intelligence records into the existing RIA deck-action table.
--
-- An NWS record is the same kind of object migration 058 was written for: a
-- public discovery lead, not a Hushh user and not a consent subject. It differs
-- in one respect only — it has no row in this database to point at. The people
-- come from an external public-record service and are identified by an opaque
-- person_id, so neither public_profile_id nor target_user_id can be satisfied.
--
-- Extending the two CHECK constraints is deliberate in preference to a new
-- table. marketplace_investor_actions already carries the unique
-- (actor_user_id, target_key) index that makes shortlisting idempotent, and
-- account_service.py already deletes from it by actor_user_id in three places.
-- A separate table would silently miss all three and leave an advisor's
-- shortlist behind after an account deletion request.
--
-- The public record itself lives in target_snapshot, which exists for exactly
-- this purpose, and target_key is namespaced as 'nws:<person_id>' so it can
-- never collide with a public_sec or hushh_user key.

BEGIN;

ALTER TABLE marketplace_investor_actions
  DROP CONSTRAINT IF EXISTS marketplace_investor_actions_source_type_check;
ALTER TABLE marketplace_investor_actions
  ADD CONSTRAINT marketplace_investor_actions_source_type_check
    CHECK (source_type IN ('hushh_user', 'public_sec', 'nws_nearby'));

ALTER TABLE marketplace_investor_actions
  DROP CONSTRAINT IF EXISTS marketplace_investor_actions_target_check;
ALTER TABLE marketplace_investor_actions
  ADD CONSTRAINT marketplace_investor_actions_target_check
    CHECK (
      (source_type = 'public_sec' AND public_profile_id IS NOT NULL AND target_user_id IS NULL)
      OR
      (source_type = 'hushh_user' AND target_user_id IS NOT NULL AND public_profile_id IS NULL)
      OR
      -- An external public-record lead resolves to neither local table. Both
      -- foreign keys stay NULL and target_key carries the upstream identity.
      (source_type = 'nws_nearby' AND public_profile_id IS NULL AND target_user_id IS NULL)
    );

-- Reading an advisor's own shortlist is the only query this surface adds, and
-- it is always scoped to one actor and one source. The existing ria_profile_id
-- index does not serve it: a shortlist is read by the acting user, and an
-- advisor with no ria_profiles row would miss that index entirely.
CREATE INDEX IF NOT EXISTS idx_marketplace_investor_actions_actor_source
  ON marketplace_investor_actions(actor_user_id, source_type, updated_at DESC);

COMMIT;
