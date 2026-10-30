-- Reverse 270: remove cumulative scoring (events, queue, streak watermark,
-- leaderboard snapshots).
--
-- Symmetric: nothing existing gained a column, no existing constraint
-- changed. Qualification, program settings, and reward-round scheduling
-- (migrations 165 and 269) behave identically whether these tables exist.
--
-- WHAT ROLLING BACK COSTS. Every awarded point, every scoring job, every
-- streak watermark and every published leaderboard snapshot is dropped with
-- the tables. Dump first if that history matters; running this against a
-- database where 270 never ran is a no-op rather than an error.

BEGIN;

-- Leaf tables first: snapshot entries reference snapshots; score events and
-- scoring jobs reference relationships and settings but nothing references
-- them.
DROP TABLE IF EXISTS one_referral_leaderboard_snapshot_entries;
DROP TABLE IF EXISTS one_referral_leaderboard_snapshots;
DROP TABLE IF EXISTS one_referral_streak_state;
DROP TABLE IF EXISTS one_referral_scoring_jobs;
DROP TABLE IF EXISTS one_referral_score_events;

COMMIT;
