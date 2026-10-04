-- Migration 270: Hushh One referral cumulative scoring.
--
-- PR2 of the gamified-referral-dashboard plan. Reads migration 269's settings
-- (point values, flash windows, streak rules) and migration 165's qualified
-- relationships; writes nothing back into either. Five additive tables:
--
--   * one_referral_score_events    -- append-only points ledger
--   * one_referral_scoring_jobs    -- durable worker queue (one per relationship)
--   * one_referral_streak_state    -- per-referrer streak-award watermark
--   * one_referral_leaderboard_snapshots         -- snapshot headers
--   * one_referral_leaderboard_snapshot_entries  -- ranked rows per snapshot
--
-- WHY A SEPARATE LEDGER FROM one_referral_events. 165's own header says a
-- reward program "gets its own migration that reads these tables" -- this is
-- that migration. one_referral_events already carries a qualification/
-- engagement event stream; a second kind of event (a point award) with its
-- own idempotency domain belongs in its own table so a replayed attribution
-- event and a replayed scoring event can never collide on the same key.
--
-- WHY REVERSALS ARE ROWS, NOT UPDATES. A compensating entry references the
-- event it reverses and is itself a normal, append-only row. Nothing in this
-- schema ever UPDATEs a settled points row -- the one operation strong enough
-- to accidentally silently change history is the one this design refuses to
-- expose.
--
-- WHY THE QUEUE IS KEYED ON relationship_id, NOT (relationship_id, kind).
-- Exactly one scoring job exists per relationship, ever: the worker that
-- claims it decides base vs flash vs streak-adjacent work from the
-- relationship and settings it reads when it runs, not from the job row.
-- Two concurrent qualification paths racing to enqueue work for the same
-- relationship must produce one job, not two -- the same shape as
-- one_referral_codes' single-winner-on-conflict pattern.
--
-- WHY A SNAPSHOT IS TWO TABLES. A leaderboard snapshot is one consistent,
-- point-in-time ranking of every scored referrer, not a per-user row with no
-- shared identity. The header carries the one timestamp every entry shares;
-- splitting entries into their own table lets a "top 10" or "my rank" read
-- page through one snapshot's rows without ever mixing two snapshots'.

BEGIN;

-- ---------------------------------------------------------------------------
-- Score events (append-only points ledger)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS one_referral_score_events (
  id                BIGSERIAL PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  relationship_id   UUID REFERENCES one_referral_relationships(id) ON DELETE CASCADE,
  event_type        TEXT NOT NULL,
  points            INTEGER NOT NULL,
  settings_version  INTEGER NOT NULL REFERENCES one_referral_program_settings(version),
  idempotency_key   TEXT NOT NULL,
  reverses_event_id BIGINT REFERENCES one_referral_score_events(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT one_referral_score_events_type_values
    CHECK (event_type IN ('base_qualification', 'flash_qualification', 'streak_bonus', 'reversal')),
  CONSTRAINT one_referral_score_events_points_nonzero
    CHECK (points <> 0),
  -- Every non-reversal award is positive; a reversal is always negative and
  -- always references what it reverses. There is no way to write a silent
  -- point deduction that isn't visibly a reversal of a specific prior event.
  CONSTRAINT one_referral_score_events_reversal_shape
    CHECK (
      (event_type = 'reversal' AND points < 0 AND reverses_event_id IS NOT NULL)
      OR (event_type <> 'reversal' AND points > 0 AND reverses_event_id IS NULL)
    ),
  -- base/flash carry the qualifying relationship; a streak bonus is earned by
  -- a run of days, not one relationship, so it is the one event_type allowed
  -- a NULL relationship_id (reversals of it still reference the event, not a
  -- relationship, via reverses_event_id).
  CONSTRAINT one_referral_score_events_relationship_required_for_qualification
    CHECK (event_type NOT IN ('base_qualification', 'flash_qualification') OR relationship_id IS NOT NULL)
);

-- The replay defence, same shape as one_referral_events_idempotency_key: a
-- duplicate delivery is a constraint violation the writer swallows, not a
-- second award.
CREATE UNIQUE INDEX IF NOT EXISTS one_referral_score_events_idempotency_key
  ON one_referral_score_events (idempotency_key);

-- Cumulative score for one user is SUM(points) over exactly this index.
CREATE INDEX IF NOT EXISTS one_referral_score_events_user_time
  ON one_referral_score_events (user_id, created_at);

CREATE INDEX IF NOT EXISTS one_referral_score_events_relationship
  ON one_referral_score_events (relationship_id)
  WHERE relationship_id IS NOT NULL;

COMMENT ON TABLE one_referral_score_events IS
  'Append-only points ledger for the referral gamification layer. Cumulative score is SUM(points) per user_id; a reversal is a negative row referencing the event it reverses, never an UPDATE of a settled one.';
COMMENT ON COLUMN one_referral_score_events.idempotency_key IS
  'base/flash: score:{relationship_id}. streak_bonus: streak:{user_id}:{third_day_date}. reversal: reversal:{reverses_event_id}. Unique, so a replayed worker run or a re-processed job cannot double-credit.';

-- ---------------------------------------------------------------------------
-- Durable scoring work queue
-- ---------------------------------------------------------------------------
-- Shaped after drive_owner_search_jobs (migration 251): lease + retry_count +
-- a due-work partial index. Inserted in the SAME transaction as the
-- relationship's qualification UPDATE and the one_referral_events row it
-- writes -- see hushh_mcp/services/one_referral_service.py -- so a crash
-- between "relationship marked qualified" and "job enqueued" cannot happen.

CREATE TABLE IF NOT EXISTS one_referral_scoring_jobs (
  job_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  relationship_id UUID NOT NULL REFERENCES one_referral_relationships(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'queued',
  lease_id        UUID,
  lease_expires_at TIMESTAMPTZ,
  retry_count     INTEGER NOT NULL DEFAULT 0 CHECK (retry_count BETWEEN 0 AND 5),
  error_code      TEXT,
  next_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  inspected_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT one_referral_scoring_jobs_status_values
    CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  CONSTRAINT one_referral_scoring_jobs_lease_pair
    CHECK ((lease_id IS NULL) = (lease_expires_at IS NULL))
);

-- One scoring job per relationship, ever. A second enqueue attempt for the
-- same relationship (retry, concurrent write path) is a constraint violation
-- the caller treats as "already enqueued", not a duplicate job.
CREATE UNIQUE INDEX IF NOT EXISTS one_referral_scoring_jobs_one_per_relationship
  ON one_referral_scoring_jobs (relationship_id);

CREATE INDEX IF NOT EXISTS one_referral_scoring_jobs_due
  ON one_referral_scoring_jobs (next_at, inspected_at)
  WHERE status IN ('queued', 'running');

COMMENT ON TABLE one_referral_scoring_jobs IS
  'Durable work queue: one row per relationship that reached qualified. A retryable worker claims due rows with a bounded lease and computes base/flash/streak points from the relationship and active settings it reads when it runs -- the job row carries no scoring decision of its own.';

-- ---------------------------------------------------------------------------
-- Streak watermark
-- ---------------------------------------------------------------------------
-- Streak awards are recomputed from the referrer's full set of distinct
-- qualifying calendar days every time a job runs (see
-- hushh_mcp/operons/referral_scoring/points.py::compute_streak_awards), which
-- makes the computation itself order-independent and replay-safe. This table
-- is only the watermark that stops that recomputation from re-awarding a run
-- already paid.

CREATE TABLE IF NOT EXISTS one_referral_streak_state (
  user_id                  TEXT PRIMARY KEY REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  last_awarded_through_date DATE,
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE one_referral_streak_state IS
  'One row per referrer: the last calendar date (in the program timezone) through which a three-day-streak bonus has already been paid. Not the streak count itself -- that is recomputed from one_referral_relationships.qualified_at every time, so delayed or out-of-order events can never corrupt it.';

-- ---------------------------------------------------------------------------
-- Leaderboard snapshots
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS one_referral_leaderboard_snapshots (
  snapshot_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  settings_version INTEGER NOT NULL REFERENCES one_referral_program_settings(version),
  entry_count      INTEGER NOT NULL DEFAULT 0 CHECK (entry_count >= 0),
  generated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS one_referral_leaderboard_snapshots_latest
  ON one_referral_leaderboard_snapshots (generated_at DESC);

CREATE TABLE IF NOT EXISTS one_referral_leaderboard_snapshot_entries (
  snapshot_id       UUID NOT NULL REFERENCES one_referral_leaderboard_snapshots(snapshot_id) ON DELETE CASCADE,
  user_id           TEXT NOT NULL REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  cumulative_points INTEGER NOT NULL CHECK (cumulative_points >= 0),
  rank              INTEGER NOT NULL CHECK (rank >= 1),

  PRIMARY KEY (snapshot_id, user_id)
);

-- The dashboard's "top N" and pagination reads are exactly this index.
CREATE UNIQUE INDEX IF NOT EXISTS one_referral_leaderboard_snapshot_entries_rank
  ON one_referral_leaderboard_snapshot_entries (snapshot_id, rank);

COMMENT ON TABLE one_referral_leaderboard_snapshots IS
  'One header row per published cumulative-ranking snapshot. The dashboard reads the latest snapshot (generated_at DESC) rather than a live aggregate query, with the snapshot timestamp shown as a freshness indicator -- see product spec section 4B.';
COMMENT ON TABLE one_referral_leaderboard_snapshot_entries IS
  'Ranked rows for one snapshot. Never mixes two snapshots: every read is scoped to one snapshot_id.';

-- ---------------------------------------------------------------------------
-- Account-deletion write guard
-- ---------------------------------------------------------------------------
-- install_account_deletion_write_guards() (migration 201) rescans the live
-- public schema for identity-shaped columns and installs its reject-on-
-- tombstoned-account trigger on every eligible table -- but only on tables
-- that already exist at the moment it runs. one_referral_score_events,
-- one_referral_scoring_jobs, one_referral_streak_state, and
-- one_referral_leaderboard_snapshot_entries each carry a user_id column and
-- do not exist until this migration creates them, so this call is what
-- actually brings them under the guard; waiting for some future migration to
-- happen to call it would leave them unguarded in the meantime.

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'install_account_deletion_write_guards') THEN
    PERFORM public.install_account_deletion_write_guards();
  END IF;
END $$;

COMMIT;
