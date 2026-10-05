-- Reverse 269: remove the referral gamification foundation (settings + reward
-- round schedule slots).
--
-- Symmetric, like 165's own rollback: nothing existing gained a column, no
-- existing constraint changed. Sign-in, onboarding, qualification, and the
-- Referrals tab all behave identically whether these two tables exist or not.
--
-- WHAT ROLLING BACK COSTS. Every configured settings version and every
-- scheduled/finalized reward round is dropped with the tables. Dump both
-- tables first if that history matters; running this against a database where
-- 269 never ran is a no-op rather than an error.

BEGIN;

-- Leaf table first: references one_referral_program_settings.
DROP TABLE IF EXISTS one_referral_reward_rounds;
DROP TABLE IF EXISTS one_referral_program_settings;

COMMIT;
