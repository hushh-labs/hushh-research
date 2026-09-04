-- Reverse 165: remove the Hushh One referral program.
--
-- This one IS symmetric, and deliberately so. 165 creates tables that nothing
-- else in the schema depends on -- no existing table gained a column, no
-- existing constraint changed, no existing row was rewritten. Sign-in,
-- onboarding, the agents and the Profile surface all behave identically whether
-- these tables exist or not, which is what makes the feature safe to roll back
-- under load.
--
-- WHAT ROLLING BACK COSTS. Every referral relationship, every credited second
-- and every risk decision is dropped with the tables. There is no way to keep
-- them: they reference a policy model that no longer exists after this file
-- runs. So this is a rollback for "the program was a mistake" or "the program
-- must not be live", not for "we shipped a bug in the evaluator" -- the second
-- one is a code deploy, and the feature flag turns the program off without
-- touching a single row.
--
-- If the data matters, dump the seven tables before running this. The order
-- below is dependency order; running it against a database where 165 never ran
-- is a no-op rather than an error.

BEGIN;

DROP TRIGGER IF EXISTS one_referral_relationships_guard_transition
  ON one_referral_relationships;
DROP FUNCTION IF EXISTS one_referral_relationships_guard_transition();

-- Leaf tables first: each of these references something below it.
DROP TABLE IF EXISTS one_referral_risk_reviews;
DROP TABLE IF EXISTS one_referral_events;
DROP TABLE IF EXISTS one_agent_engagement_sessions;
DROP TABLE IF EXISTS one_referral_relationships;
DROP TABLE IF EXISTS one_referral_attributions;
DROP TABLE IF EXISTS one_referral_codes;
DROP TABLE IF EXISTS one_referral_policies;

-- pgcrypto is intentionally left installed. 020 created it and the rest of the
-- schema still uses gen_random_uuid(); dropping it here would take out every
-- other table's default.

COMMIT;
