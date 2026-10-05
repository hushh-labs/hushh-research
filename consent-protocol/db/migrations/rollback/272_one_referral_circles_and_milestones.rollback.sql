-- Reverse 271: remove circle contributions, competition circle selection
-- history, lifetime milestone entitlements, and fulfillment records.
--
-- Symmetric: nothing existing gained a column, and one_location_circles /
-- one_location_circle_memberships are never touched by 271 or this rollback.
--
-- WHAT ROLLING BACK COSTS. Every recorded team contribution, every selected
-- team's history, every earned milestone entitlement, and every fulfillment
-- review record is dropped with the tables. Dump first if that history
-- matters; running this against a database where 271 never ran is a no-op.

BEGIN;

-- Leaf table first: references one_referral_milestone_entitlements.
DROP TABLE IF EXISTS one_referral_fulfillment_records;
DROP TABLE IF EXISTS one_referral_milestone_entitlements;
DROP TABLE IF EXISTS one_referral_circle_contributions;
DROP TABLE IF EXISTS one_referral_circle_selections;

COMMIT;
