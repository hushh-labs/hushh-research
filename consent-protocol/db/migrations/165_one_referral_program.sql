-- Migration 165: Hushh One qualified referral program.
--
-- NAMING. `one_location_referrals` already exists (migration 061) and means
-- something entirely different -- one person referring another person to a
-- location share. Nothing here extends it. Everything this migration creates
-- carries the `one_referral_` prefix and is about growth attribution: who
-- invited whom into Hushh One, and whether that invitation ever turned into a
-- real, engaged member.
--
-- WHY THE SCHEMA IS SHAPED LIKE THIS. A referral program is only worth having
-- if its count means something. The whole design here exists to make the count
-- hard to inflate:
--
--   * The referred user is unique across the whole relationship table, so one
--     person can be referred exactly once, ever, by exactly one referrer. This
--     is a database constraint rather than service logic because the race that
--     breaks it -- two attribution callbacks landing at once -- is precisely
--     the one a service-level check loses.
--   * Credited engagement time lives on the server's own session rows and is
--     never written from a client-supplied total. The client reports that it
--     is alive; the server decides how many seconds that was worth.
--   * Every event carries an idempotency key with a unique index behind it, so
--     a replayed heartbeat is a constraint violation and not extra credit.
--   * The relationship's status transitions are policed by a trigger, so a
--     terminal state cannot quietly return to an active one through a stray
--     UPDATE -- including one issued by a future version of our own code.
--
-- POLICY VERSIONING. The qualification bar (15 active minutes today, possibly
-- 20 later) is configuration, not a constant. Each relationship stores the
-- policy version it entered under and is evaluated against that version for
-- life. Someone who started under a 15-minute rule finishes under it; raising
-- the bar never retroactively disqualifies a person who was already halfway
-- through earning it.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT CREATE. There is no rewards table,
-- no balance, no points, no payout ledger. A qualified referral is currently a
-- count and an audit trail. When a reward program is specified it gets its own
-- migration that reads these tables; inventing the money model now would mean
-- guessing at a financial contract nobody has written.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Policy
-- ---------------------------------------------------------------------------
-- One row per version of the program's rules. Rows are append-only in spirit:
-- a policy change writes a NEW version and retires the old one, so relationships
-- pinned to the old version can still be evaluated exactly as they began.

CREATE TABLE IF NOT EXISTS one_referral_policies (
  version                        INTEGER PRIMARY KEY,
  program_enabled                BOOLEAN NOT NULL DEFAULT TRUE,
  new_users_only                 BOOLEAN NOT NULL DEFAULT TRUE,
  attribution_window_days        INTEGER NOT NULL,
  qualification_window_days      INTEGER NOT NULL,
  required_active_seconds        INTEGER NOT NULL,
  minimum_meaningful_events      INTEGER NOT NULL,
  eligible_agent_keys            TEXT[]  NOT NULL DEFAULT ARRAY[]::TEXT[],

  -- Engagement accounting knobs. These live beside the qualification bar
  -- because changing one without the other silently changes what "15 minutes"
  -- costs a user: doubling the heartbeat interval while leaving the per-beat
  -- credit alone would halve the real time required.
  heartbeat_interval_seconds     INTEGER NOT NULL DEFAULT 30,
  max_credit_per_heartbeat_secs  INTEGER NOT NULL DEFAULT 30,
  recent_interaction_window_secs INTEGER NOT NULL DEFAULT 60,
  max_reporting_gap_seconds      INTEGER NOT NULL DEFAULT 90,

  created_at                     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  activated_at                   TIMESTAMPTZ,
  retired_at                     TIMESTAMPTZ,

  CONSTRAINT one_referral_policies_windows_positive
    CHECK (attribution_window_days > 0 AND qualification_window_days > 0),
  CONSTRAINT one_referral_policies_thresholds_positive
    CHECK (required_active_seconds > 0 AND minimum_meaningful_events > 0),
  CONSTRAINT one_referral_policies_heartbeat_sane
    CHECK (
      heartbeat_interval_seconds > 0
      AND max_credit_per_heartbeat_secs > 0
      -- Crediting more per beat than the beat interval would hand out time the
      -- user never spent; crediting a beat that arrives after the allowed gap
      -- would credit a session that had already gone silent.
      AND max_credit_per_heartbeat_secs <= heartbeat_interval_seconds
      AND max_reporting_gap_seconds >= heartbeat_interval_seconds
      AND recent_interaction_window_secs > 0
    ),
  CONSTRAINT one_referral_policies_retired_after_activated
    CHECK (retired_at IS NULL OR activated_at IS NULL OR retired_at >= activated_at)
);

-- Exactly one policy may be live at a time. Two live policies would make
-- "which bar applies to a brand-new referral" ambiguous, and the ambiguity
-- would only surface as an inconsistent qualification months later.
CREATE UNIQUE INDEX IF NOT EXISTS one_referral_policies_single_active
  ON one_referral_policies ((TRUE))
  WHERE activated_at IS NOT NULL AND retired_at IS NULL;

COMMENT ON TABLE one_referral_policies IS
  'Versioned rules for the Hushh One referral program. A relationship is evaluated for life against the version it entered under; policy changes write a new version rather than editing a live one.';
COMMENT ON COLUMN one_referral_policies.required_active_seconds IS
  'Server-credited active seconds inside eligible agents required to qualify. v1 = 900 (15 minutes). Changing this means writing a new policy version, never an UPDATE in place.';

-- v1 defaults. Seeded here rather than by application code so that an empty
-- database and a migrated one behave identically on first boot.
INSERT INTO one_referral_policies (
  version, program_enabled, new_users_only,
  attribution_window_days, qualification_window_days,
  required_active_seconds, minimum_meaningful_events,
  eligible_agent_keys, activated_at
) VALUES (
  1, TRUE, TRUE,
  30, 7,
  900, 3,
  ARRAY['one_location', 'hushh_research', 'hushh_research_pkm']::TEXT[],
  NOW()
)
ON CONFLICT (version) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Referral codes (the public slug)
-- ---------------------------------------------------------------------------
-- The slug is a public attribution code and never an authentication credential.
-- Nothing downstream may treat possession of a slug as proof of identity, which
-- is why this table stores no secret and the slug is deliberately guessable-
-- resistant rather than secret.

CREATE TABLE IF NOT EXISTS one_referral_codes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id   TEXT NOT NULL REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  slug            TEXT NOT NULL,
  normalized_slug TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active',
  policy_version  INTEGER NOT NULL REFERENCES one_referral_policies(version),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  disabled_at     TIMESTAMPTZ,

  CONSTRAINT one_referral_codes_status_values
    CHECK (status IN ('active', 'disabled')),
  CONSTRAINT one_referral_codes_disabled_has_timestamp
    CHECK ((status = 'disabled') = (disabled_at IS NOT NULL)),
  -- The normalized form is what uniqueness and lookup are both defined on, so
  -- it must actually be normalized. Enforcing the shape here means a service
  -- bug cannot write `Ankit-7K4M` into the column that a case-insensitive
  -- lookup will later miss.
  CONSTRAINT one_referral_codes_normalized_shape
    CHECK (normalized_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(normalized_slug) BETWEEN 3 AND 64)
);

-- Case-insensitive uniqueness across the whole program, live or retired. A
-- retired slug keeps its row: links already shared must resolve to a disabled
-- state rather than silently becoming somebody else's slug.
CREATE UNIQUE INDEX IF NOT EXISTS one_referral_codes_normalized_slug_key
  ON one_referral_codes (normalized_slug);

-- One active slug per owner.
CREATE UNIQUE INDEX IF NOT EXISTS one_referral_codes_one_active_per_owner
  ON one_referral_codes (owner_user_id)
  WHERE status = 'active';

COMMENT ON TABLE one_referral_codes IS
  'Public referral slugs. An attribution code, never an authentication credential: resolving a slug proves nothing about who is holding it.';
COMMENT ON COLUMN one_referral_codes.normalized_slug IS
  'Lowercase hyphenated form; the only column uniqueness and lookup are defined on. Shape is constrained so a service bug cannot store an unnormalized value that lookups would then miss.';

-- ---------------------------------------------------------------------------
-- Attributions (link opened, identity not yet known)
-- ---------------------------------------------------------------------------
-- Created server-side the moment a referral link is opened, BEFORE sign-in.
-- This is what survives the authentication redirect: the client is handed an
-- opaque id, never the slug or anything about the referrer.

CREATE TABLE IF NOT EXISTS one_referral_attributions (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referral_code_id            UUID NOT NULL REFERENCES one_referral_codes(id) ON DELETE CASCADE,
  referrer_user_id            TEXT NOT NULL REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  anonymous_session_id        TEXT,
  -- A salted hash, never a raw device or network identifier. Fraud detection
  -- needs to know "same installation again", not which installation.
  installation_reference_hash TEXT,
  source                      TEXT,
  campaign                    TEXT,
  landing_route               TEXT,
  policy_version              INTEGER NOT NULL REFERENCES one_referral_policies(version),
  first_seen_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at                  TIMESTAMPTZ NOT NULL,
  bound_user_id               TEXT REFERENCES actor_profiles(user_id) ON DELETE SET NULL,
  bound_at                    TIMESTAMPTZ,
  status                      TEXT NOT NULL DEFAULT 'pending',

  CONSTRAINT one_referral_attributions_status_values
    CHECK (status IN ('pending', 'bound', 'expired', 'discarded')),
  CONSTRAINT one_referral_attributions_bound_pair
    CHECK ((bound_user_id IS NULL) = (bound_at IS NULL)),
  CONSTRAINT one_referral_attributions_bound_status_agrees
    CHECK (status <> 'bound' OR bound_user_id IS NOT NULL),
  -- Self-attribution is rejected at the earliest point it can be detected
  -- rather than left for the qualification evaluator to catch later.
  CONSTRAINT one_referral_attributions_not_self
    CHECK (bound_user_id IS NULL OR bound_user_id <> referrer_user_id),
  CONSTRAINT one_referral_attributions_expiry_after_first_seen
    CHECK (expires_at > first_seen_at)
);

CREATE INDEX IF NOT EXISTS one_referral_attributions_pending_lookup
  ON one_referral_attributions (referral_code_id, first_seen_at DESC)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS one_referral_attributions_bound_user
  ON one_referral_attributions (bound_user_id)
  WHERE bound_user_id IS NOT NULL;

-- Sweeping expired pending rows is a routine job; without this it is a seq scan
-- over every attribution the program has ever created.
CREATE INDEX IF NOT EXISTS one_referral_attributions_expiry_sweep
  ON one_referral_attributions (expires_at)
  WHERE status = 'pending';

COMMENT ON TABLE one_referral_attributions IS
  'A referral link opening, recorded server-side before the visitor has an identity. Bound to a canonical user only after authentication completes.';
COMMENT ON COLUMN one_referral_attributions.installation_reference_hash IS
  'Salted hash of an installation signal, for abuse velocity only. Never a raw device identifier, and never returned to any client.';

-- ---------------------------------------------------------------------------
-- Relationships (the referral itself)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS one_referral_relationships (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attribution_id        UUID NOT NULL UNIQUE REFERENCES one_referral_attributions(id) ON DELETE RESTRICT,
  referrer_user_id      TEXT NOT NULL REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  referred_user_id      TEXT NOT NULL REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  policy_version        INTEGER NOT NULL REFERENCES one_referral_policies(version),
  status                TEXT NOT NULL DEFAULT 'attributed',

  signed_up_at          TIMESTAMPTZ,
  phone_verified_at     TIMESTAMPTZ,
  onboarded_at          TIMESTAMPTZ,
  engagement_started_at TIMESTAMPTZ,
  qualified_at          TIMESTAMPTZ,
  expired_at            TIMESTAMPTZ,
  rejected_at           TIMESTAMPTZ,
  revoked_at            TIMESTAMPTZ,

  -- Internal only. Never rendered to a referrer or a referred user: telling
  -- someone which signal flagged them is telling them what to change next time.
  internal_reason_code  TEXT,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT one_referral_relationships_status_values
    CHECK (status IN (
      'attributed', 'signed_up', 'phone_verified', 'onboarded', 'engaging',
      'under_review', 'qualified', 'ineligible', 'rejected', 'expired', 'revoked'
    )),
  CONSTRAINT one_referral_relationships_not_self
    CHECK (referrer_user_id <> referred_user_id),
  CONSTRAINT one_referral_relationships_qualified_has_timestamp
    CHECK (status <> 'qualified' OR qualified_at IS NOT NULL),
  CONSTRAINT one_referral_relationships_revoked_has_timestamp
    CHECK (status <> 'revoked' OR revoked_at IS NOT NULL)
);

-- The invariant the whole program rests on: a person can be referred once.
-- A unique index rather than a service check, because the failure it prevents
-- is a concurrent one.
CREATE UNIQUE INDEX IF NOT EXISTS one_referral_relationships_one_per_referred
  ON one_referral_relationships (referred_user_id);

-- The referrer's own Referrals tab reads exactly this: their qualified count.
CREATE INDEX IF NOT EXISTS one_referral_relationships_referrer_status
  ON one_referral_relationships (referrer_user_id, status);

-- The qualification worker sweeps relationships that are still in flight.
CREATE INDEX IF NOT EXISTS one_referral_relationships_in_flight
  ON one_referral_relationships (status, engagement_started_at)
  WHERE status IN ('onboarded', 'engaging', 'under_review');

COMMENT ON TABLE one_referral_relationships IS
  'One referrer to one referred user. Unique on referred_user_id: a person may be referred exactly once, by exactly one person, ever.';
COMMENT ON COLUMN one_referral_relationships.internal_reason_code IS
  'Internal risk/decision code. Never exposed to any user-facing surface -- a referred user learning which signal flagged them learns how to defeat it.';

-- ---------------------------------------------------------------------------
-- Transition guard
-- ---------------------------------------------------------------------------
-- The state machine is enforced in the database, not only in the evaluator.
-- A terminal state returning to an active one is the single most expensive bug
-- this feature can have -- it is how a rejected referral becomes a qualified
-- one -- and it is exactly the kind of thing an ad-hoc admin UPDATE or a future
-- refactor does by accident.

CREATE OR REPLACE FUNCTION one_referral_relationships_guard_transition()
RETURNS TRIGGER AS $$
DECLARE
  allowed TEXT[];
BEGIN
  IF NEW.status = OLD.status THEN
    NEW.updated_at := NOW();
    RETURN NEW;
  END IF;

  allowed := CASE OLD.status
    WHEN 'attributed'     THEN ARRAY['signed_up', 'ineligible', 'expired', 'rejected']
    WHEN 'signed_up'      THEN ARRAY['phone_verified', 'ineligible', 'expired', 'rejected']
    WHEN 'phone_verified' THEN ARRAY['onboarded', 'ineligible', 'expired', 'rejected']
    WHEN 'onboarded'      THEN ARRAY['engaging', 'ineligible', 'expired', 'rejected']
    WHEN 'engaging'       THEN ARRAY['qualified', 'under_review', 'expired', 'ineligible', 'rejected']
    WHEN 'under_review'   THEN ARRAY['qualified', 'rejected', 'expired', 'ineligible']
    WHEN 'qualified'      THEN ARRAY['revoked']
    -- Terminal. Nothing leaves these without a deliberate, audited data repair
    -- that drops this trigger first, which is precisely the friction intended.
    WHEN 'ineligible'     THEN ARRAY[]::TEXT[]
    WHEN 'rejected'       THEN ARRAY[]::TEXT[]
    WHEN 'expired'        THEN ARRAY[]::TEXT[]
    WHEN 'revoked'        THEN ARRAY[]::TEXT[]
    ELSE ARRAY[]::TEXT[]
  END;

  IF NOT (NEW.status = ANY(allowed)) THEN
    RAISE EXCEPTION
      'one_referral_relationships: illegal transition % -> % for relationship %',
      OLD.status, NEW.status, OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS one_referral_relationships_guard_transition
  ON one_referral_relationships;

CREATE TRIGGER one_referral_relationships_guard_transition
  BEFORE UPDATE ON one_referral_relationships
  FOR EACH ROW
  EXECUTE FUNCTION one_referral_relationships_guard_transition();

-- ---------------------------------------------------------------------------
-- Engagement sessions
-- ---------------------------------------------------------------------------
-- Credited time lives here and is written only by the server. The client owns
-- `client_session_id` (useful for support and for collapsing duplicate reports
-- from one tab); the server owns everything that counts.

CREATE TABLE IF NOT EXISTS one_agent_engagement_sessions (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                TEXT NOT NULL REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  agent_key              TEXT NOT NULL,
  client_session_id      TEXT,
  server_session_id      UUID NOT NULL DEFAULT gen_random_uuid(),
  started_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_heartbeat_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at               TIMESTAMPTZ,
  credited_active_seconds INTEGER NOT NULL DEFAULT 0,
  meaningful_event_count  INTEGER NOT NULL DEFAULT 0,
  status                 TEXT NOT NULL DEFAULT 'open',

  CONSTRAINT one_agent_engagement_sessions_status_values
    CHECK (status IN ('open', 'closed', 'abandoned')),
  -- Credited time can never be negative, and can never exceed the wall-clock
  -- span of the session itself. The second half is what catches an out-of-order
  -- or replayed heartbeat that arithmetic alone would happily credit.
  CONSTRAINT one_agent_engagement_sessions_credit_non_negative
    CHECK (credited_active_seconds >= 0),
  CONSTRAINT one_agent_engagement_sessions_credit_within_span
    CHECK (
      credited_active_seconds
        <= CEIL(EXTRACT(EPOCH FROM (COALESCE(ended_at, last_heartbeat_at) - started_at)))::INTEGER + 1
    ),
  CONSTRAINT one_agent_engagement_sessions_events_non_negative
    CHECK (meaningful_event_count >= 0),
  CONSTRAINT one_agent_engagement_sessions_closed_has_end
    CHECK ((status = 'open') = (ended_at IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS one_agent_engagement_sessions_server_session_key
  ON one_agent_engagement_sessions (server_session_id);

-- Aggregating a user's credited time across sessions is the hot path of the
-- qualification evaluator; it runs on every heartbeat batch.
CREATE INDEX IF NOT EXISTS one_agent_engagement_sessions_user_window
  ON one_agent_engagement_sessions (user_id, started_at DESC);

-- Overlap collapse reads a user's open sessions; without this it reads them all.
CREATE INDEX IF NOT EXISTS one_agent_engagement_sessions_open_per_user
  ON one_agent_engagement_sessions (user_id, agent_key)
  WHERE status = 'open';

COMMENT ON TABLE one_agent_engagement_sessions IS
  'Server-owned engagement sessions. credited_active_seconds is calculated by the server from heartbeats and is never written from a client-supplied duration.';
COMMENT ON CONSTRAINT one_agent_engagement_sessions_credit_within_span
  ON one_agent_engagement_sessions IS
  'Credited time cannot exceed the session wall-clock span. Catches replayed and out-of-order heartbeats that plain addition would credit.';

-- ---------------------------------------------------------------------------
-- Event ledger
-- ---------------------------------------------------------------------------
-- Append-only. The unique idempotency key is the replay defence: a heartbeat or
-- meaningful event delivered twice is a constraint violation the writer swallows,
-- not a second credit.

CREATE TABLE IF NOT EXISTS one_referral_events (
  id               BIGSERIAL PRIMARY KEY,
  relationship_id  UUID REFERENCES one_referral_relationships(id) ON DELETE CASCADE,
  user_id          TEXT NOT NULL REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  event_type       TEXT NOT NULL,
  event_version    INTEGER NOT NULL DEFAULT 1,
  agent_key        TEXT,
  server_timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  client_sequence  BIGINT,
  idempotency_key  TEXT NOT NULL,
  metadata         JSONB NOT NULL DEFAULT '{}'::JSONB,

  CONSTRAINT one_referral_events_client_sequence_non_negative
    CHECK (client_sequence IS NULL OR client_sequence >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS one_referral_events_idempotency_key
  ON one_referral_events (idempotency_key);

CREATE INDEX IF NOT EXISTS one_referral_events_relationship_time
  ON one_referral_events (relationship_id, server_timestamp DESC)
  WHERE relationship_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS one_referral_events_user_type_time
  ON one_referral_events (user_id, event_type, server_timestamp DESC);

COMMENT ON TABLE one_referral_events IS
  'Append-only referral and engagement event ledger. The unique idempotency key is the replay defence: a duplicate delivery violates the constraint rather than earning a second credit.';

-- ---------------------------------------------------------------------------
-- Risk reviews
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS one_referral_risk_reviews (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  relationship_id UUID NOT NULL REFERENCES one_referral_relationships(id) ON DELETE CASCADE,
  risk_level      TEXT NOT NULL,
  reason_codes    TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  decision        TEXT NOT NULL DEFAULT 'pending',
  decided_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at      TIMESTAMPTZ,

  CONSTRAINT one_referral_risk_reviews_risk_values
    CHECK (risk_level IN ('low', 'medium', 'high')),
  CONSTRAINT one_referral_risk_reviews_decision_values
    CHECK (decision IN ('pending', 'approved', 'rejected')),
  -- A decided review must record who decided it and when. An unattributed
  -- approval is indistinguishable from an automated one, which is the whole
  -- thing an audit trail exists to prevent.
  CONSTRAINT one_referral_risk_reviews_decided_is_attributed
    CHECK (
      (decision = 'pending' AND decided_by IS NULL AND decided_at IS NULL)
      OR (decision <> 'pending' AND decided_by IS NOT NULL AND decided_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS one_referral_risk_reviews_pending_queue
  ON one_referral_risk_reviews (created_at)
  WHERE decision = 'pending';

CREATE UNIQUE INDEX IF NOT EXISTS one_referral_risk_reviews_one_open_per_relationship
  ON one_referral_risk_reviews (relationship_id)
  WHERE decision = 'pending';

COMMENT ON TABLE one_referral_risk_reviews IS
  'Human review queue and audit trail for referrals held at under_review. Reason codes are internal and never surface to a user.';

COMMIT;
