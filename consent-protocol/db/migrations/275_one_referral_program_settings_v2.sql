-- Migration 275: Hushh One referral gamification settings v2.
--
-- v1 (migration 270) shipped with placeholder milestones (tee_5, backpack_15)
-- and a deliberately unset weekly_schedule -- the migration's own header said
-- the real cutoff day/time/timezone, the exact reward catalogue, and any
-- shipping commitment were "operational inputs nobody has supplied yet".
-- They have now been supplied: a four-rung lifetime milestone ladder (10,
-- 100, 500, 10,000 qualified referrals) with the exact rewards the product
-- surface advertises, and a weekly challenge cutoff of Sunday 23:59
-- Asia/Kolkata.
--
-- This follows the exact versioning discipline migration 270 documented: a
-- settings change writes a new version and retires the old one, so a
-- relationship's already-earned points, milestones and streak credit are
-- never recomputed under a rule that did not exist when they were earned.
-- `points` and `streak_rules` are carried over unchanged from v1 -- nothing
-- about the point values or the three-day streak bonus is changing here,
-- only the milestone ladder and the weekly schedule.
--
-- `feature_active` stays FALSE, matching v1. That flag only gates
-- `finalize_reward_round()` (the separate weekly rank-1/2/3 AirPods prize in
-- `prize_catalogue`, migration 274) -- it has no effect on milestone
-- entitlements or points, which the scoring worker always processes
-- regardless of this flag (see `one_referral_scoring_service.py` and
-- `one_referral_rewards_service.py`). Turning on real weekly-prize
-- finalization is a separate decision this migration does not make.
--
-- weekly_schedule.cutoff_day_of_week uses ISO 8601 weekday numbering
-- (1 = Monday .. 7 = Sunday) since nothing in the codebase reads this field
-- yet to compute a next-occurrence instant -- the dashboard's read path
-- (added alongside this migration) is the first consumer and defines the
-- convention here.

BEGIN;

UPDATE one_referral_program_settings
   SET retired_at = NOW()
 WHERE version = 1
   AND activated_at IS NOT NULL
   AND retired_at IS NULL;

INSERT INTO one_referral_program_settings (
  version, qualification_policy_version,
  points, milestones, streak_rules, flash_windows,
  weekly_schedule, prize_catalogue, tie_break_rules, fulfillment_config,
  feature_active, activated_at
) VALUES (
  2, 1,
  '{"qualified_referral_points": 100, "flash_window_total_points": 200, "streak_three_day_bonus_points": 15}'::JSONB,
  '[
     {"milestone_key": "voucher_10", "threshold": 10, "reward": "₹250 Amazon voucher"},
     {"milestone_key": "earbuds_100", "threshold": 100, "reward": "Wireless earbuds, worth ₹10,000"},
     {"milestone_key": "airpods_500", "threshold": 500, "reward": "Apple AirPods, worth ₹30,000"},
     {"milestone_key": "iphone_10000", "threshold": 10000, "reward": "iPhone"}
   ]'::JSONB,
  '{"run_length_days": 3, "bonus_points": 15}'::JSONB,
  '[]'::JSONB,
  '{"timezone": "Asia/Kolkata", "cutoff_day_of_week": 7, "cutoff_time": "23:59:00", "announce_lead_hours": 2, "award_slots": 3}'::JSONB,
  '[{"reward_key": "weekly_airpods", "rank_slots": [1, 2, 3]}]'::JSONB,
  '{}'::JSONB,
  '{}'::JSONB,
  FALSE, NOW()
)
ON CONFLICT (version) DO NOTHING;

COMMIT;
