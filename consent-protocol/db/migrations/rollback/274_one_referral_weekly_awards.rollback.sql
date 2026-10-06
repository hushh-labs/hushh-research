-- Reverse 273: remove finalized weekly awards.
--
-- Symmetric: nothing existing gained a column. Running this against a
-- database where 273 never ran is a no-op.
--
-- WHAT ROLLING BACK COSTS. Every finalized weekly award record is dropped.
-- Dump first if that history matters -- this is the audit trail of who won
-- which round and when it was reviewed/fulfilled.

BEGIN;

DROP TABLE IF EXISTS one_referral_weekly_awards;

COMMIT;
