-- Migration 182: stable opaque public person references
--
-- A public person reference is an address, never an authority. It is random,
-- immutable, and deliberately unrelated to Firebase uid, email, or phone.

BEGIN;

ALTER TABLE actor_profiles
  ADD COLUMN IF NOT EXISTS public_person_ref UUID;

ALTER TABLE actor_profiles
  ADD COLUMN IF NOT EXISTS public_profile_status TEXT NOT NULL DEFAULT 'active';

UPDATE actor_profiles
SET public_person_ref = gen_random_uuid()
WHERE public_person_ref IS NULL;

ALTER TABLE actor_profiles
  ALTER COLUMN public_person_ref SET DEFAULT gen_random_uuid(),
  ALTER COLUMN public_person_ref SET NOT NULL;

ALTER TABLE actor_profiles
  DROP CONSTRAINT IF EXISTS actor_profiles_public_profile_status_check;

ALTER TABLE actor_profiles
  ADD CONSTRAINT actor_profiles_public_profile_status_check
  CHECK (public_profile_status IN ('active', 'disabled', 'suppressed'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_actor_profiles_public_person_ref
  ON actor_profiles(public_person_ref);

CREATE OR REPLACE FUNCTION prevent_public_person_ref_change()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.public_person_ref IS DISTINCT FROM OLD.public_person_ref THEN
    RAISE EXCEPTION 'public_person_ref is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS actor_profiles_public_person_ref_immutable ON actor_profiles;
CREATE TRIGGER actor_profiles_public_person_ref_immutable
  BEFORE UPDATE OF public_person_ref ON actor_profiles
  FOR EACH ROW EXECUTE FUNCTION prevent_public_person_ref_change();

COMMENT ON COLUMN actor_profiles.public_person_ref IS
  'Random immutable public route address. It conveys no identity, relationship, scope, consent, or information authority.';

COMMENT ON COLUMN actor_profiles.public_profile_status IS
  'Public profile lifecycle. Non-active rows always resolve as the same non-enumerating 404 as an unknown reference.';

COMMIT;
