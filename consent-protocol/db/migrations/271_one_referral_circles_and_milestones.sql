-- Migration 271: Hushh One referral circle contributions and lifetime
-- milestones.
--
-- PR3 of the gamified-referral-dashboard plan. Four additive tables, none of
-- which touch `one_location_circles` or `one_location_circle_memberships` --
-- the product spec is explicit that contest participation must not alter
-- global circle capacity or introduce additional data access to that
-- feature, so this migration only ever READS circle identity and accepted
-- membership from those tables via foreign key and application-level check,
-- never writes to them.
--
-- WHY A SEPARATE "COMPETITION CIRCLE SELECTION" TABLE. A Location Circle
-- membership has no exclusivity: a person can belong to many at once, and
-- `one_location_circle_memberships` keeps only current state per (circle,
-- user) pair, not an interval history (re-joining overwrites the row). The
-- referral contest needs the opposite shape: exactly ONE active team at a
-- time, with a real interval history, because "delayed processing uses
-- event-time membership, not current membership" is a stated requirement.
-- Rather than retrofitting interval history onto a shared Location table,
-- one_referral_circle_selections is new, referral-owned, and interval-based
-- from day one: selecting a new team closes the previous selection's
-- interval and opens a new one, so "which team was this person on as of
-- timestamp T" is always answerable.
--
-- WHY CONTRIBUTIONS ARE A SEPARATE SNAPSHOT, NOT A JOIN. Recomputing "which
-- team gets credit for this relationship" from current selections at read
-- time would let a later team switch retroactively move history. Instead,
-- the worker that scores a relationship (migration 270's
-- one_referral_scoring_jobs) resolves the referrer's selection interval that
-- covers the relationship's qualified_at the ONE time it processes that job,
-- and writes the result here, once, forever. One row per relationship, ever
-- -- the same "settle it once" shape as one_referral_score_events.
--
-- WHY MILESTONES ARE LIFETIME AND LIVE HERE, NOT IN THE WEEKLY SCHEDULE.
-- "The same threshold does not issue another item every week" -- a milestone
-- key is earned once, ever, independent of settings_version or any
-- reward_round_id. one_referral_fulfillment_records is the foundation for
-- staff review and shipment tracking; it ships no shipping logic and no
-- purchase authority, matching the product spec's explicit prohibition on
-- this change making purchases or contacting couriers.

BEGIN;

-- ---------------------------------------------------------------------------
-- Competition circle selection (interval history)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS one_referral_circle_selections (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     TEXT NOT NULL REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  circle_id   UUID NOT NULL REFERENCES one_location_circles(id) ON DELETE CASCADE,
  selected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at    TIMESTAMPTZ,

  CONSTRAINT one_referral_circle_selections_ended_after_selected
    CHECK (ended_at IS NULL OR ended_at > selected_at)
);

-- Exactly one open-ended selection per user: selecting a new team is an
-- application-level "close the old interval, open a new one" operation, not
-- a toggle on a single mutable row.
CREATE UNIQUE INDEX IF NOT EXISTS one_referral_circle_selections_one_active_per_user
  ON one_referral_circle_selections (user_id)
  WHERE ended_at IS NULL;

-- The worker's "which team covered this timestamp" query is exactly this
-- index: WHERE user_id = :u AND selected_at <= :t AND (ended_at IS NULL OR
-- ended_at > :t).
CREATE INDEX IF NOT EXISTS one_referral_circle_selections_user_interval
  ON one_referral_circle_selections (user_id, selected_at);

COMMENT ON TABLE one_referral_circle_selections IS
  'Interval history of a user''s single active referral-contest team. Selecting a new circle closes the current open interval (ended_at) and opens a new row; never edits a closed interval. Read by the scoring worker at event time, never by current-selection lookups alone.';

-- ---------------------------------------------------------------------------
-- Circle contributions (append-only, event-time snapshot)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS one_referral_circle_contributions (
  id              BIGSERIAL PRIMARY KEY,
  relationship_id UUID NOT NULL REFERENCES one_referral_relationships(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  circle_id       UUID NOT NULL REFERENCES one_location_circles(id) ON DELETE CASCADE,
  contributed_at  TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One contribution per relationship, ever: a relationship with no covering
-- circle selection at qualification time simply gets no row here at all --
-- circle participation is additive to personal scoring, never a
-- precondition for it.
CREATE UNIQUE INDEX IF NOT EXISTS one_referral_circle_contributions_one_per_relationship
  ON one_referral_circle_contributions (relationship_id);

-- Team cumulative score is COUNT(*) over exactly this index: raw qualified
-- referrals, never bonus points (base/flash/streak live in
-- one_referral_score_events and are never summed into a team total).
CREATE INDEX IF NOT EXISTS one_referral_circle_contributions_circle
  ON one_referral_circle_contributions (circle_id);

COMMENT ON TABLE one_referral_circle_contributions IS
  'Append-only, settled-once record of which team gets credit for each qualified relationship. circle_id is resolved from one_referral_circle_selections as of contributed_at (the relationship''s qualified_at) the one time the scoring worker processes that relationship -- a later team switch can never retroactively move this row. Team cumulative score is COUNT(*) GROUP BY circle_id: raw qualified referrals, not points.';

-- ---------------------------------------------------------------------------
-- Lifetime milestone entitlements
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS one_referral_milestone_entitlements (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          TEXT NOT NULL REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  milestone_key    TEXT NOT NULL,
  threshold        INTEGER NOT NULL CHECK (threshold > 0),
  reward           TEXT NOT NULL,
  settings_version INTEGER NOT NULL REFERENCES one_referral_program_settings(version),
  earned_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A milestone key is earned once, ever, per user -- independent of
-- settings_version or any weekly reward_round_id. A later policy change
-- that renumbers or re-prices milestones writes a new settings version; it
-- never reissues or revokes an entitlement already on this table.
CREATE UNIQUE INDEX IF NOT EXISTS one_referral_milestone_entitlements_once_per_user
  ON one_referral_milestone_entitlements (user_id, milestone_key);

COMMENT ON TABLE one_referral_milestone_entitlements IS
  'Lifetime, once-only merchandise entitlements (e.g. tee at 5, backpack at 15). Earning the same threshold again on a later week, under a later settings version, or after a weekly reward round never issues a second row for the same (user_id, milestone_key).';

-- ---------------------------------------------------------------------------
-- Fulfillment foundation (review + shipment tracking, no shipping logic)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS one_referral_fulfillment_records (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entitlement_id  UUID NOT NULL REFERENCES one_referral_milestone_entitlements(id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'pending_review',
  reviewed_by     TEXT,
  reviewed_at     TIMESTAMPTZ,
  shipped_at      TIMESTAMPTZ,
  tracking_reference TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT one_referral_fulfillment_records_status_values
    CHECK (status IN ('pending_review', 'approved', 'queued', 'shipped', 'failed', 'cancelled')),
  CONSTRAINT one_referral_fulfillment_records_decided_is_attributed
    CHECK (
      (status = 'pending_review' AND reviewed_by IS NULL AND reviewed_at IS NULL)
      OR (status <> 'pending_review' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
    ),
  CONSTRAINT one_referral_fulfillment_records_shipped_has_timestamp
    CHECK (status <> 'shipped' OR shipped_at IS NOT NULL)
);

-- One fulfillment record per entitlement: a milestone is earned once, so it
-- is reviewed and fulfilled once.
CREATE UNIQUE INDEX IF NOT EXISTS one_referral_fulfillment_records_one_per_entitlement
  ON one_referral_fulfillment_records (entitlement_id);

CREATE INDEX IF NOT EXISTS one_referral_fulfillment_records_pending_queue
  ON one_referral_fulfillment_records (created_at)
  WHERE status = 'pending_review';

COMMENT ON TABLE one_referral_fulfillment_records IS
  'Staff review and shipment-tracking foundation for milestone entitlements. This table records state only -- no purchase, courier, or shipping-address capability is implemented by this migration or implied by this table existing.';

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'install_account_deletion_write_guards') THEN
    PERFORM public.install_account_deletion_write_guards();
  END IF;
END $$;

COMMIT;
