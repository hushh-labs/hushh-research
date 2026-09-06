-- Migration 198: one verified owner per canonical phone number
-- =============================================================
-- Contact matching deliberately refuses an exact phone proof when more than
-- one verified identity owns it. Historical duplicate shadows therefore fail
-- closed as zero matches even after the matching path itself is correct.
--
-- No database-only rule can safely decide which user still possesses an
-- ambiguous number. This migration clears every ambiguous binding instead of
-- selecting a winner by uid, source, or timestamp. It also clears verified
-- values that are NULL or not canonical E.164. Those users must re-verify
-- phone possession; that data repair is intentional and irreversible.

BEGIN;

-- Freeze identity mutations while classifying and repairing the complete
-- verified-phone set. Ordinary reads remain available. The migration runner's
-- lock timeout makes a busy deployment fail without partially changing data.
LOCK TABLE actor_identity_cache IN SHARE ROW EXCLUSIVE MODE;

-- A verified binding is authoritative only when it is a canonical E.164
-- string: leading '+', non-zero first digit, and at most fifteen digits.
UPDATE actor_identity_cache
SET
  phone_number = NULL,
  phone_verified = FALSE,
  -- Make the next authenticated request re-read Firebase immediately rather
  -- than trusting a now-cleared identity shadow for up to 24 hours.
  last_synced_at = TIMESTAMPTZ 'epoch',
  updated_at = NOW()
WHERE phone_verified = TRUE
  AND (
    phone_number IS NULL
    OR phone_number !~ '^[+][1-9][0-9]{1,14}$'
  );

-- Clear every member of each exact duplicate group. Keeping an arbitrary row
-- would disclose the wrong One identity if that row is the stale owner.
WITH ambiguous_verified_phones AS MATERIALIZED (
  SELECT phone_number
  FROM actor_identity_cache
  WHERE phone_verified = TRUE
    AND phone_number IS NOT NULL
  GROUP BY phone_number
  HAVING COUNT(*) > 1
)
UPDATE actor_identity_cache AS identity
SET
  phone_number = NULL,
  phone_verified = FALSE,
  last_synced_at = TIMESTAMPTZ 'epoch',
  updated_at = NOW()
FROM ambiguous_verified_phones AS ambiguous
WHERE identity.phone_verified = TRUE
  AND identity.phone_number = ambiguous.phone_number;

-- PostgreSQL has no ADD CONSTRAINT IF NOT EXISTS. Guard the canonical-format
-- check explicitly so the repository's replay-on-every-deploy lane is safe.
DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'actor_identity_cache'::regclass
      AND conname = 'actor_identity_cache_verified_phone_e164_check'
  ) THEN
    ALTER TABLE actor_identity_cache
      ADD CONSTRAINT actor_identity_cache_verified_phone_e164_check
      CHECK (
        phone_verified = FALSE
        OR (
          phone_number IS NOT NULL
          AND phone_number ~ '^[+][1-9][0-9]{1,14}$'
        )
      );
  END IF;
END
$migration$;

-- The partial predicate matches the authorization invariant: unverified
-- historical values are not identities, while each verified E.164 value has
-- exactly one owner. Non-concurrent creation keeps cleanup and enforcement in
-- the same transaction, leaving no writer race between them.
CREATE UNIQUE INDEX IF NOT EXISTS uq_actor_identity_cache_verified_phone
  ON actor_identity_cache(phone_number)
  WHERE phone_verified = TRUE AND phone_number IS NOT NULL;

COMMIT;
