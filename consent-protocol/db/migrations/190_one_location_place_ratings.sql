BEGIN;

-- Rate the place you just left.
--
-- Nearby Check-In has always ended flat: you check out and the sheet offers to
-- save the place. Nothing asks how the visit went, so the one moment this
-- product knows something Google does not -- that a phone-verified person was
-- physically inside 500 m of a named venue -- produces no durable signal at
-- all.
--
-- ## What this deliberately breaks, and the line it draws instead
--
-- `docs/reference/iam/consent-scope-catalog.md` states that plaintext
-- coordinates, exact distance, provider place ids, place labels, roster
-- contents, email, phone and stable public user ids are forbidden in
-- nearby-presence persistence. That is why `check_in()` validates a place id
-- and then drops it, why the anchor is an AES-256-GCM envelope, and why
-- `checkout()` NULLs all seven anchor columns. Before this migration there is
-- no record anywhere that a check-in ever happened.
--
-- A rating cannot exist without a durable person-to-venue link. So rather than
-- pretend otherwise, this draws the line explicitly and amends the catalog in
-- the same change:
--
--   one_location_nearby_visits          encrypted, 7 days, purged.
--                                       Not queryable by place; only a keyed
--                                       token allows equality checks.
--   one_location_place_ratings          PLAINTEXT place id, permanent.
--                                       Created only when the owner accepts a
--                                       named, versioned consent.
--   one_location_place_rating_aggregates  anonymous counts only.
--
-- The link becomes durable and plaintext at exactly one moment: acceptance of
-- `one-location-place-rating-v1`. Everything before that stays encrypted and
-- expires.
--
-- ## What is NOT here, on purpose
--
-- No review text column, no author name, no author id in any read projection,
-- no visited-at in any public payload. A rating is private to its author; the
-- only thing other people ever see is an anonymous average, and only once
-- enough people have rated that the average is not a re-identification of one
-- of them. The note the author writes lives in their own vault, client-side
-- encrypted, and never reaches this database.

-- ------------------------------------------------------------------
-- 1. The reviewable-visit ledger
-- ------------------------------------------------------------------
--
-- Why a second table rather than a column on one_location_nearby_presences:
-- that table's whole invariant is one mutable row per owner with every anchor
-- column NULLed the moment status leaves 'active'
-- (chk_one_location_nearby_presence_anchor_lifecycle, migration 126), and
-- `purge_terminal` DELETEs terminal rows at 12 hours. A place id there would
-- either have to be NULLed too -- solving nothing -- or violate the invariant
-- that migration's own header states.
--
-- The place is an authenticated-encryption envelope, the same strength as the
-- presence anchor, with its own AAD prefix so the two ciphertext families can
-- never be swapped by a coding error. `place_token` is a server-keyed HMAC so
-- the service can answer "is this the same venue" and "how many distinct
-- places today" without decrypting anything. It is NOT an anonymiser: anyone
-- holding the key and a list of places can invert it. It exists to keep
-- equality cheap, not to hide the venue from us.
CREATE TABLE IF NOT EXISTS one_location_nearby_visits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id TEXT NOT NULL REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  place_ciphertext TEXT NOT NULL,
  place_iv TEXT NOT NULL,
  place_tag TEXT NOT NULL,
  place_algorithm TEXT NOT NULL,
  place_key_id TEXT NOT NULL,
  place_token TEXT NOT NULL CHECK (char_length(place_token) BETWEEN 16 AND 128),
  checked_in_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  rated_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_one_location_nearby_visits_expiry CHECK (expires_at > checked_in_at)
);

COMMENT ON TABLE one_location_nearby_visits IS
  'Short-lived encrypted ledger of completed Nearby Check-In visits, so a person can rate the place they just left. Place held only as an AES-256-GCM envelope plus a server-keyed equality token; purged at expires_at. Also carries the check-in continuity anchor that survives checkout.';

COMMENT ON COLUMN one_location_nearby_visits.place_token IS
  'Keyed HMAC over the provider place id. Enables equality and distinct-place counting without decryption. Not an anonymiser.';

CREATE INDEX IF NOT EXISTS idx_one_location_nearby_visits_owner
  ON one_location_nearby_visits (owner_user_id, checked_in_at DESC);

CREATE INDEX IF NOT EXISTS idx_one_location_nearby_visits_retention
  ON one_location_nearby_visits (expires_at);

-- Re-checking into the same venue while the first visit is still open must not
-- open a second reviewable row, or one afternoon at one cafe becomes three
-- prompts.
CREATE UNIQUE INDEX IF NOT EXISTS uq_one_location_nearby_visits_open
  ON one_location_nearby_visits (owner_user_id, place_token)
  WHERE ended_at IS NULL;

-- ------------------------------------------------------------------
-- 2. The rating
-- ------------------------------------------------------------------
--
-- Keyed on (author, place), not on (author, visit). If one account can file N
-- ratings for one place then the average is gameable by one person and a rate
-- limit only slows it down. A revisit updates the same row and bumps
-- `revision` / `visit_count`, so "Places you've been" is a set of places
-- rather than a log of trips.
--
-- Uniqueness is expressed as an INDEX rather than a table constraint for two
-- reasons: Postgres has no ADD CONSTRAINT IF NOT EXISTS and these migrations
-- replay on every deploy; and a future move to per-visit ratings then becomes
-- an index swap instead of a schema rewrite.
--
-- `consent_version` is stored per row rather than as a boolean because it is
-- load-bearing at read time: when the version bumps, rows carrying the old one
-- stop contributing to the public average WITHOUT being mutated, until their
-- author accepts the new text. Same idea as the presence service's
-- consent-version check, but non-destructive -- a rating is not disposable the
-- way a 60-minute presence is.
CREATE TABLE IF NOT EXISTS one_location_place_ratings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  author_user_id TEXT NOT NULL REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  place_id TEXT NOT NULL CHECK (char_length(place_id) BETWEEN 1 AND 300),
  place_label TEXT NOT NULL CHECK (char_length(place_label) BETWEEN 1 AND 300),
  place_category TEXT CHECK (place_category IS NULL OR char_length(place_category) <= 80),
  rating SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  aggregatable BOOLEAN NOT NULL DEFAULT TRUE,
  consent_version TEXT NOT NULL CHECK (char_length(consent_version) BETWEEN 1 AND 80),
  consent_accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source_visit_id UUID,
  visited_at TIMESTAMPTZ,
  visit_count INTEGER NOT NULL DEFAULT 1 CHECK (visit_count > 0),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE one_location_place_ratings IS
  'One 1-5 star rating per person per place, private to its author. The only durable person-to-venue link in One Location; created solely on accepting a named versioned publish consent. Carries no review text, no author display name, and no author identity in any read projection.';

COMMENT ON COLUMN one_location_place_ratings.aggregatable IS
  'False for a place whose category must never carry a public average (health, worship, legal, funeral, shelter). Decided server-side at write time and re-checked on read.';

COMMENT ON COLUMN one_location_place_ratings.source_visit_id IS
  'Deliberately not a foreign key: visits are purged at 7 days and the rating outlives them.';

CREATE UNIQUE INDEX IF NOT EXISTS uq_one_location_place_ratings_author_place
  ON one_location_place_ratings (author_user_id, place_id);

CREATE INDEX IF NOT EXISTS idx_one_location_place_ratings_author
  ON one_location_place_ratings (author_user_id, updated_at DESC);

-- Covering, for the aggregate recompute. Deliberately does NOT include
-- author_user_id: the read path that builds a public average must never have a
-- reason to select it.
CREATE INDEX IF NOT EXISTS idx_one_location_place_ratings_place
  ON one_location_place_ratings (place_id)
  INCLUDE (rating)
  WHERE aggregatable;

-- ------------------------------------------------------------------
-- 3. The anonymous aggregate
-- ------------------------------------------------------------------
--
-- Count and sum, never the rows. Recomputed inside the same transaction as
-- every insert, update and delete -- a deleted rating that keeps contributing
-- to an average has not been deleted.
--
-- The k-threshold and the count bucketing are enforced in the service, not
-- here, because they are read-time policy: at count = 1 the average IS the
-- rating, and an observer polling an exact (count, average) pair recovers each
-- new rating by subtraction whatever the value of n. The table stores the
-- truth; the projection is what is allowed to be coarse.
CREATE TABLE IF NOT EXISTS one_location_place_rating_aggregates (
  place_id TEXT PRIMARY KEY CHECK (char_length(place_id) BETWEEN 1 AND 300),
  rating_count INTEGER NOT NULL DEFAULT 0 CHECK (rating_count >= 0),
  rating_sum INTEGER NOT NULL DEFAULT 0 CHECK (rating_sum >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE one_location_place_rating_aggregates IS
  'Anonymous per-place rating totals. Holds no user reference of any kind. Publication thresholds and count bucketing are applied at read time, not stored here.';

-- ------------------------------------------------------------------
-- 4. Domain events
-- ------------------------------------------------------------------
--
-- Full list restated from 187 because a CHECK constraint is replaced whole,
-- and DROP-then-ADD is what makes the replay safe (see
-- tests/test_migrations_are_replay_safe.py, written after 158/159 rolled back
-- both production revisions).
--
-- No Feed projection for these in this migration. The existing triggers filter
-- on event_type and will ignore them, which is correct: a Feed row saying "you
-- rated a place" would reintroduce, to a durable audience, the who-was-where
-- signal the roster spends a rotating alias to suppress.
ALTER TABLE one_location_events
  DROP CONSTRAINT IF EXISTS one_location_events_event_type_check;

ALTER TABLE one_location_events
  ADD CONSTRAINT one_location_events_event_type_check CHECK (
    event_type IN (
      'location_recipient_key_registered',
      'location_share_created',
      'location_envelope_updated',
      'location_share_viewed',
      'location_share_revoked',
      'location_share_shortened',
      'location_share_duration_changed',
      'location_share_expired',
      'location_access_request',
      'location_access_approved',
      'location_auto_approve_rule_changed',
      'location_access_denied',
      'location_access_request_withdrawn',
      'location_referral_invite',
      'location_public_invite_created',
      'location_public_invite_revoked',
      'location_public_invite_submitted',
      'location_circle_invite_created',
      'location_circle_invite_claimed',
      'location_circle_invite_revoked',
      'location_one_network_joined',
      'location_circle_code_joined',
      'location_circle_member_invite_accepted',
      'circle_member_added',
      'location_sms_contact_added',
      'location_sms_contact_removed',
      'location_place_rating_saved',
      'location_place_rating_updated',
      'location_place_rating_withdrawn'
    )
  ) NOT VALID;

COMMIT;
