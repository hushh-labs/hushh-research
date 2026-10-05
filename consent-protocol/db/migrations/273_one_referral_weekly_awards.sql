-- Migration 273: Hushh One weekly reward awards.
--
-- PR5 of the gamified-referral-dashboard plan. One additive table, reading
-- migration 269's reward rounds and migration 270's score ledger; writes
-- nothing back into either.
--
-- WHY UNIQUENESS IS (reward_round_id, award_slot), NEVER (user_id,
-- reward_type). The product spec is explicit and repeated: a previous
-- winner can win again in a later round, with no cooldown, no exclusion,
-- and no requirement to have earned anything new that week -- weekly is the
-- award SCHEDULE, cumulative standing is the only scoring window. A unique
-- constraint on the user would make that impossible to express; the
-- constraint this table actually needs is "this round's rank-1 slot is
-- filled exactly once", which still lets the same user fill rank-1 in round
-- 7 after already filling it in round 3.
--
-- WHY FINALIZING TWICE MUST CREATE ZERO EXTRA PRIZES. A delayed scheduler
-- retry, a redeployed worker, or an operator re-running finalization for the
-- same round must all land on the SAME three rows. ON CONFLICT
-- (reward_round_id, award_slot) DO NOTHING is what makes that true at the
-- database layer rather than something application logic has to get right
-- every time.
--
-- WHY THIS TABLE DOES NOT RECOMPUTE SCORES. cumulative_points_at_cutoff is a
-- frozen snapshot value, written once at finalization. It proves what the
-- standing was at the moment of the award without needing to replay
-- one_referral_score_events later, and winning here never writes to that
-- ledger -- a prize is never itself a point award.

BEGIN;

CREATE TABLE IF NOT EXISTS one_referral_weekly_awards (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reward_round_id             UUID NOT NULL REFERENCES one_referral_reward_rounds(id) ON DELETE CASCADE,
  award_slot                  INTEGER NOT NULL CHECK (award_slot BETWEEN 1 AND 3),
  user_id                     TEXT NOT NULL REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  cumulative_points_at_cutoff INTEGER NOT NULL CHECK (cumulative_points_at_cutoff >= 0),
  status                      TEXT NOT NULL DEFAULT 'pending_review',
  reviewed_by                 TEXT,
  reviewed_at                 TIMESTAMPTZ,
  fulfilled_at                TIMESTAMPTZ,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT one_referral_weekly_awards_status_values
    CHECK (status IN ('pending_review', 'approved', 'fulfilled', 'cancelled')),
  CONSTRAINT one_referral_weekly_awards_decided_is_attributed
    CHECK (
      (status = 'pending_review' AND reviewed_by IS NULL AND reviewed_at IS NULL)
      OR (status <> 'pending_review' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
    ),
  CONSTRAINT one_referral_weekly_awards_fulfilled_has_timestamp
    CHECK (status <> 'fulfilled' OR fulfilled_at IS NOT NULL)
);

-- The load-bearing constraint: one winner per round per slot, ever. Never a
-- lifetime constraint on (user_id, anything) -- see header.
CREATE UNIQUE INDEX IF NOT EXISTS one_referral_weekly_awards_one_per_round_slot
  ON one_referral_weekly_awards (reward_round_id, award_slot);

CREATE INDEX IF NOT EXISTS one_referral_weekly_awards_user
  ON one_referral_weekly_awards (user_id);

CREATE INDEX IF NOT EXISTS one_referral_weekly_awards_pending_queue
  ON one_referral_weekly_awards (created_at)
  WHERE status = 'pending_review';

COMMENT ON TABLE one_referral_weekly_awards IS
  'Finalized weekly rank-1/2/3 awards. Unique on (reward_round_id, award_slot) only -- deliberately NOT on user_id, so the same person winning multiple rounds is a supported, expected shape, not a conflict. cumulative_points_at_cutoff is a frozen snapshot value; finalizing never writes to one_referral_score_events.';
COMMENT ON COLUMN one_referral_weekly_awards.award_slot IS
  'Rank at finalization: 1, 2, or 3. Maps to the product spec''s weekly:{reward_round_id}:rank_{award_slot} reward key.';

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'install_account_deletion_write_guards') THEN
    PERFORM public.install_account_deletion_write_guards();
  END IF;
END $$;

COMMIT;
