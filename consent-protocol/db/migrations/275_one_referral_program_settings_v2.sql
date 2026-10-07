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
--
-- GUARDED, SERIALIZED, IDEMPOTENT-ONLY-ON-EXACT-MATCH. A shared database can
-- see this file replayed: a retried deploy, an operator re-running the
-- release lane, two deploys racing. The block below never assumes it is
-- starting from a clean v1-only state:
--
--   * It locks both candidate rows (`FOR UPDATE`) before reading either, so
--     two concurrent replays serialize on this table instead of both reading
--     a pre-transition snapshot and racing to write.
--   * If version 2 already exists, that is ONLY an idempotent success when
--     its stored configuration matches this migration's intended values
--     exactly (points, milestones, streak_rules, weekly_schedule,
--     prize_catalogue, feature_active, qualification_policy_version) AND it
--     is the currently active row (activated_at set, retired_at null). A
--     version 2 that exists but is retired, never activated, or configured
--     differently is an unexpected state this migration refuses to paper
--     over -- it raises and leaves version 1 exactly as it found it, rather
--     than guessing which one should win.
--   * Only when version 2 does not exist yet does it touch version 1 at
--     all, and only after confirming version 1 is itself the expected
--     starting point (activated, not retired). Finding version 1 missing or
--     already retired with no version 2 present means the database is in a
--     state this migration was not written to transition FROM, so it raises
--     instead of inventing a recovery.
--   * Before commit, it re-reads the table and asserts exactly one row is
--     currently active -- the same invariant the partial unique index
--     `one_referral_program_settings_single_active` enforces, checked here
--     explicitly so a logic error in the block above fails loudly inside
--     this transaction rather than silently leaving zero or two active
--     versions.

BEGIN;

DO $migration_275$
DECLARE
  v1_row one_referral_program_settings%ROWTYPE;
  v2_row one_referral_program_settings%ROWTYPE;
  expected_points JSONB := '{"qualified_referral_points": 100, "flash_window_total_points": 200, "streak_three_day_bonus_points": 15}'::JSONB;
  expected_milestones JSONB := '[
     {"milestone_key": "voucher_10", "threshold": 10, "reward": "₹250 Amazon voucher"},
     {"milestone_key": "earbuds_100", "threshold": 100, "reward": "Wireless earbuds, worth ₹10,000"},
     {"milestone_key": "airpods_500", "threshold": 500, "reward": "Apple AirPods, worth ₹30,000"},
     {"milestone_key": "iphone_10000", "threshold": 10000, "reward": "iPhone"}
   ]'::JSONB;
  expected_streak_rules JSONB := '{"run_length_days": 3, "bonus_points": 15}'::JSONB;
  expected_weekly_schedule JSONB := '{"timezone": "Asia/Kolkata", "cutoff_day_of_week": 7, "cutoff_time": "23:59:00", "announce_lead_hours": 2, "award_slots": 3}'::JSONB;
  expected_prize_catalogue JSONB := '[{"reward_key": "weekly_airpods", "rank_slots": [1, 2, 3]}]'::JSONB;
  active_count INTEGER;
BEGIN
  -- Serialize: lock both candidate rows before reading either, so a second
  -- concurrent replay of this migration blocks here rather than racing this
  -- one on the read.
  PERFORM 1 FROM one_referral_program_settings WHERE version IN (1, 2) FOR UPDATE;

  SELECT * INTO v2_row FROM one_referral_program_settings WHERE version = 2;

  IF FOUND THEN
    -- Version 2 already exists. This is an idempotent success ONLY if it is
    -- the active row and its configuration matches exactly -- never because
    -- a row with this version number merely exists.
    IF v2_row.activated_at IS NULL OR v2_row.retired_at IS NOT NULL THEN
      RAISE EXCEPTION 'migration 275: version 2 exists but is not the active settings version (activated_at=%, retired_at=%); refusing to guess intent; version 1 left untouched',
        v2_row.activated_at, v2_row.retired_at;
    END IF;
    IF v2_row.qualification_policy_version IS DISTINCT FROM 1
       OR v2_row.points IS DISTINCT FROM expected_points
       OR v2_row.milestones IS DISTINCT FROM expected_milestones
       OR v2_row.streak_rules IS DISTINCT FROM expected_streak_rules
       OR v2_row.weekly_schedule IS DISTINCT FROM expected_weekly_schedule
       OR v2_row.prize_catalogue IS DISTINCT FROM expected_prize_catalogue
       OR v2_row.feature_active IS DISTINCT FROM FALSE
    THEN
      RAISE EXCEPTION 'migration 275: version 2 exists and is active, but its configuration does not match this migration''s intended values; refusing to silently diverge; version 1 left untouched';
    END IF;

    RAISE NOTICE 'migration 275: version 2 already active with matching configuration; idempotent no-op';
  ELSE
    -- Version 2 does not exist yet. Confirm version 1 is the expected,
    -- single starting point before changing anything.
    SELECT * INTO v1_row FROM one_referral_program_settings WHERE version = 1;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'migration 275: version 1 does not exist; this migration was not written to run against this starting state';
    END IF;
    IF v1_row.activated_at IS NULL OR v1_row.retired_at IS NOT NULL THEN
      RAISE EXCEPTION 'migration 275: version 1 is not the current active settings version (activated_at=%, retired_at=%) and version 2 does not exist; unexpected starting state, refusing to proceed',
        v1_row.activated_at, v1_row.retired_at;
    END IF;

    UPDATE one_referral_program_settings
       SET retired_at = NOW()
     WHERE version = 1;

    INSERT INTO one_referral_program_settings (
      version, qualification_policy_version,
      points, milestones, streak_rules, flash_windows,
      weekly_schedule, prize_catalogue, tie_break_rules, fulfillment_config,
      feature_active, activated_at
    ) VALUES (
      2, 1,
      expected_points, expected_milestones, expected_streak_rules, '[]'::JSONB,
      expected_weekly_schedule, expected_prize_catalogue, '{}'::JSONB, '{}'::JSONB,
      FALSE, NOW()
    );
  END IF;

  -- Final invariant, checked explicitly rather than trusted: exactly one
  -- settings version is active once this block completes, matching what
  -- the partial unique index already enforces structurally.
  SELECT COUNT(*) INTO active_count
    FROM one_referral_program_settings
   WHERE activated_at IS NOT NULL AND retired_at IS NULL;
  IF active_count <> 1 THEN
    RAISE EXCEPTION 'migration 275: invariant violated; expected exactly one active settings version after this migration, found %',
      active_count;
  END IF;
END
$migration_275$;

COMMIT;
