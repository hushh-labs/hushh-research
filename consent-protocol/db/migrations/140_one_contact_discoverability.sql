-- Migration 140: contact discoverability for One network matching
-- ================================================================
-- One Location contact sync previously matched only against
-- marketplace_public_profiles, which is opt-in and defaults to not
-- discoverable. An ordinary One user syncing their contact book therefore got
-- zero matches even when the people in it were on One.
--
-- This column governs the wider match: whether someone who already holds this
-- user's phone number may learn that the number belongs to a One account. It
-- defaults to TRUE, matching the behaviour users expect from contact sync, and
-- is revocable from privacy settings at any time.
--
-- Matching still requires a verified phone number, and the backend only ever
-- compares SHA-256 digests supplied by the requester against digests it derives
-- itself. No phone number is disclosed by the match.

BEGIN;

ALTER TABLE actor_profiles
  ADD COLUMN IF NOT EXISTS contact_discoverable BOOLEAN NOT NULL DEFAULT TRUE;

-- Partial index mirrors idx_actor_profiles_marketplace_opt_in: the match query
-- only ever reads the TRUE side.
CREATE INDEX IF NOT EXISTS idx_actor_profiles_contact_discoverable
  ON actor_profiles(contact_discoverable)
  WHERE contact_discoverable = TRUE;

-- Contact matching buckets candidates by the last four digits of the verified
-- phone number. That predicate is an expression over phone_number, so the
-- existing idx_actor_identity_cache_phone_number cannot serve it and every
-- sync degrades into a sequential scan of the identity cache. This functional
-- index matches the predicate the matcher actually issues.
CREATE INDEX IF NOT EXISTS idx_actor_identity_cache_phone_last4
  ON actor_identity_cache (RIGHT(regexp_replace(phone_number, '[^0-9]', '', 'g'), 4))
  WHERE phone_verified = TRUE AND phone_number IS NOT NULL;

COMMIT;
