-- Migration 269: Hushh One referral gamification foundation.
--
-- PR1 of the gamified-referral-dashboard plan. This migration creates exactly
-- two tables and touches nothing that already exists: no column is added to
-- `one_referral_relationships`, `one_referral_policies`, or any other table
-- from migration 165. That migration's own header said a reward program
-- "gets its own migration that reads these tables" -- this is that migration,
-- and it only reads, via foreign key, the qualification policy it builds on.
--
-- ONE_REFERRAL_PROGRAM_SETTINGS vs ONE_REFERRAL_POLICIES. These are
-- deliberately separate tables. `one_referral_policies` decides whether a
-- referral QUALIFIES (phone verified, onboarding complete). This table
-- decides what a qualified referral is WORTH -- points, milestones, streaks,
-- flash windows, the weekly reward schedule, and the prize catalogue. A
-- qualification-policy change and a points-value change are different
-- decisions made at different times by different people; forcing them into
-- one table would mean a policy fix could accidentally roll prize values, or
-- the other way around. Both tables follow the same versioning discipline as
-- 165: a settings change writes a new version and retires the old one, so a
-- relationship's already-earned points are never recomputed under a rule that
-- did not exist when it earned them.
--
-- FEATURE_ACTIVE IS NOT "DOES A ROW EXIST". `get_active_program_settings()`
-- always finds exactly one active-versioned row once this migration runs --
-- the application needs point values and milestone thresholds to render
-- progress even before real prizes are live. `feature_active` is the separate
-- switch for whether a weekly round may ever finalize and award anything. v1
-- below ships with `feature_active = FALSE` and a `weekly_schedule` whose
-- timezone, cutoff day and cutoff time are NULL on purpose: the real weekly
-- award day/time, the first award cutoff, the exact AirPods model, and any
-- shipping commitment are operational inputs nobody has supplied yet, and
-- inventing them here would plant a fake commitment in a migration file.
-- Turning the program on later is a new settings version, never a code
-- deploy and never an UPDATE of this one.
--
-- ONE_REFERRAL_REWARD_ROUNDS IS A SCHEDULE SLOT, NOT A RESULT. This migration
-- creates the row a weekly cutoff identifies itself by; it does not create
-- rankings, entitlements, or winners -- that is PR5. The row's only job here
-- is to exist exactly once per cutoff, which is why `cutoff_at` carries the
-- unique index rather than a service-level "does a round exist" check: two
-- scheduler invocations racing on the same cutoff must find the same row.

BEGIN;

CREATE TABLE IF NOT EXISTS one_referral_program_settings (
  version                       INTEGER PRIMARY KEY,
  qualification_policy_version INTEGER NOT NULL REFERENCES one_referral_policies(version),
  points                        JSONB NOT NULL,
  milestones                    JSONB NOT NULL,
  streak_rules                  JSONB NOT NULL,
  flash_windows                 JSONB NOT NULL DEFAULT '[]'::JSONB,
  weekly_schedule                JSONB NOT NULL,
  prize_catalogue                JSONB NOT NULL DEFAULT '[]'::JSONB,
  tie_break_rules                JSONB NOT NULL DEFAULT '{}'::JSONB,
  fulfillment_config              JSONB NOT NULL DEFAULT '{}'::JSONB,
  feature_active                 BOOLEAN NOT NULL DEFAULT FALSE,

  created_at                     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  activated_at                   TIMESTAMPTZ,
  retired_at                     TIMESTAMPTZ,

  CONSTRAINT one_referral_program_settings_points_is_object
    CHECK (jsonb_typeof(points) = 'object'),
  CONSTRAINT one_referral_program_settings_milestones_is_array
    CHECK (jsonb_typeof(milestones) = 'array'),
  CONSTRAINT one_referral_program_settings_streak_rules_is_object
    CHECK (jsonb_typeof(streak_rules) = 'object'),
  CONSTRAINT one_referral_program_settings_flash_windows_is_array
    CHECK (jsonb_typeof(flash_windows) = 'array'),
  CONSTRAINT one_referral_program_settings_weekly_schedule_is_object
    CHECK (jsonb_typeof(weekly_schedule) = 'object'),
  CONSTRAINT one_referral_program_settings_prize_catalogue_is_array
    CHECK (jsonb_typeof(prize_catalogue) = 'array'),
  CONSTRAINT one_referral_program_settings_tie_break_rules_is_object
    CHECK (jsonb_typeof(tie_break_rules) = 'object'),
  CONSTRAINT one_referral_program_settings_fulfillment_config_is_object
    CHECK (jsonb_typeof(fulfillment_config) = 'object'),
  CONSTRAINT one_referral_program_settings_retired_after_activated
    CHECK (retired_at IS NULL OR activated_at IS NULL OR retired_at >= activated_at)
);

-- Exactly one settings version may be live, mirroring
-- one_referral_policies_single_active: two live versions would make "which
-- point values apply right now" ambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS one_referral_program_settings_single_active
  ON one_referral_program_settings ((TRUE))
  WHERE activated_at IS NOT NULL AND retired_at IS NULL;

COMMENT ON TABLE one_referral_program_settings IS
  'Versioned configuration for the Hushh One referral GAMIFICATION layer: points, milestones, streaks, flash windows, weekly schedule, prize catalogue, tie-break and fulfillment rules. Separate from one_referral_policies, which governs qualification only. A settings change writes a new version and retires the old one; earned totals are never recomputed under a version that did not exist when they were earned.';
COMMENT ON COLUMN one_referral_program_settings.feature_active IS
  'Whether a weekly round under this settings version may ever finalize and award a prize. A row existing (so the app has point values and milestone thresholds to render) is independent of this flag.';
COMMENT ON COLUMN one_referral_program_settings.weekly_schedule IS
  'Timezone, cutoff day/time, and announcement lead time for weekly rounds. v1 ships with these unset: the real schedule is an operational input, not a value this migration invents.';

-- v1 defaults: the point/milestone/streak SHAPE from the confirmed program
-- design, with feature_active = FALSE and an unset weekly_schedule until
-- operational inputs (real cutoff day/time/timezone, prize catalogue
-- fulfillment readiness, required approvals) are supplied.
INSERT INTO one_referral_program_settings (
  version, qualification_policy_version,
  points, milestones, streak_rules, flash_windows,
  weekly_schedule, prize_catalogue, tie_break_rules, fulfillment_config,
  feature_active, activated_at
) VALUES (
  1, 1,
  '{"qualified_referral_points": 100, "flash_window_total_points": 200, "streak_three_day_bonus_points": 15}'::JSONB,
  '[{"milestone_key": "tee_5", "threshold": 5, "reward": "hushh_tee"}, {"milestone_key": "backpack_15", "threshold": 15, "reward": "hushh_backpack", "retains": ["tee_5"]}]'::JSONB,
  '{"run_length_days": 3, "bonus_points": 15}'::JSONB,
  '[]'::JSONB,
  '{"timezone": null, "cutoff_day_of_week": null, "cutoff_time": null, "announce_lead_hours": 2, "award_slots": 3}'::JSONB,
  '[{"reward_key": "weekly_airpods", "rank_slots": [1, 2, 3]}]'::JSONB,
  '{}'::JSONB,
  '{}'::JSONB,
  FALSE, NOW()
)
ON CONFLICT (version) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Weekly reward rounds (schedule slot, not a result)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS one_referral_reward_rounds (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  settings_version  INTEGER NOT NULL REFERENCES one_referral_program_settings(version),
  cutoff_at         TIMESTAMPTZ NOT NULL,
  timezone          TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'scheduled',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finalized_at      TIMESTAMPTZ,

  CONSTRAINT one_referral_reward_rounds_status_values
    CHECK (status IN ('scheduled', 'reconciling', 'finalized', 'cancelled')),
  CONSTRAINT one_referral_reward_rounds_finalized_has_timestamp
    CHECK (status <> 'finalized' OR finalized_at IS NOT NULL)
);

-- The round's identity is its cutoff instant. "Create or retrieve the round
-- exactly once" (product spec) is a unique-index race, not a service-level
-- check: a delayed scheduler that runs twice for the same cutoff must find
-- the SAME round, never create a second one with a second set of prizes.
CREATE UNIQUE INDEX IF NOT EXISTS one_referral_reward_rounds_one_per_cutoff
  ON one_referral_reward_rounds (cutoff_at);

CREATE INDEX IF NOT EXISTS one_referral_reward_rounds_status_cutoff
  ON one_referral_reward_rounds (status, cutoff_at);

COMMENT ON TABLE one_referral_reward_rounds IS
  'One row per weekly reward distribution. cutoff_at is the round''s stable identity: finalization (a later PR) reads all eligible contributions effective before this instant -- never "since the previous cutoff", because scoring is cumulative and weekly is only the award schedule. Creating a round for a cutoff that already has one is idempotent via the unique index on cutoff_at.';
COMMENT ON COLUMN one_referral_reward_rounds.cutoff_at IS
  'The ORIGINAL scheduled cutoff. A delayed job must use this stored value, never the time it happens to run, or standings could shift between when the round should have closed and when a late job actually executes.';

COMMIT;
