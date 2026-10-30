-- Reverse 272: remove opt-in referral display handles.
--
-- Symmetric: nothing existing gained a column. Running this against a
-- database where 272 never ran is a no-op.
--
-- WHAT ROLLING BACK COSTS. Every chosen handle is dropped. Any leaderboard
-- code that depends on this table must be rolled back or disabled first, or
-- it will find no handle for anyone and must fail closed to anonymous
-- display rather than falling back to a real name.

BEGIN;

DROP TABLE IF EXISTS one_referral_display_handles;

COMMIT;
