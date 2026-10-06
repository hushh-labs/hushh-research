-- Migration 273: Hushh One referral display handles.
--
-- PR4 foundation. One additive table, closing a real gap the PR1 privacy
-- audit flagged before any cross-user display existed: `actor_identity_cache
-- .display_name` is sourced from the real Firebase account (often a Google
-- or Apple real name), and nothing in the referral program previously had a
-- self-service, opt-in alias distinct from it. A leaderboard built directly
-- on display_name would deanonymize every ranked person to every other
-- ranked person -- the one thing the qualification/attribution design has
-- been careful never to do for a REFERRED person (see migration 165's own
-- header) would quietly start happening to REFERRERS the moment a
-- leaderboard shipped.
--
-- Setting a handle is opt-in and self-service: a referrer who has not set
-- one is simply not eligible to appear on a leaderboard by real name --
-- callers must fall back to an anonymous placeholder, never to
-- actor_identity_cache.display_name. This migration creates no fallback
-- display logic itself; that is a read-time decision for the service layer.

BEGIN;

CREATE TABLE IF NOT EXISTS one_referral_display_handles (
  user_id          TEXT PRIMARY KEY REFERENCES actor_profiles(user_id) ON DELETE CASCADE,
  handle           TEXT NOT NULL,
  normalized_handle TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Same shape discipline as one_referral_codes.normalized_slug: the
  -- normalized form is what uniqueness and lookup are both defined on, so a
  -- service bug cannot write an unnormalized value a case-insensitive lookup
  -- would then miss.
  CONSTRAINT one_referral_display_handles_normalized_shape
    CHECK (normalized_handle ~ '^[a-z0-9](-?[a-z0-9])*$' AND length(normalized_handle) BETWEEN 3 AND 24)
);

-- Case-insensitive uniqueness across the whole program: two referrers cannot
-- appear under the same leaderboard name.
CREATE UNIQUE INDEX IF NOT EXISTS one_referral_display_handles_normalized_key
  ON one_referral_display_handles (normalized_handle);

COMMENT ON TABLE one_referral_display_handles IS
  'Opt-in, self-chosen public alias for referral leaderboard display. Deliberately separate from actor_identity_cache.display_name (the real/account name): a referrer who has not set one has no public leaderboard identity and must be rendered as an anonymous placeholder, never under their real name.';

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'install_account_deletion_write_guards') THEN
    PERFORM public.install_account_deletion_write_guards();
  END IF;
END $$;

COMMIT;
