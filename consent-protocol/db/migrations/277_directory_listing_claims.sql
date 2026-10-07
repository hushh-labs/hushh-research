-- Directory listing claims: a One user says "this White Pages listing is me".
--
-- listing_id is the public-record id hussh.ai shows (an NPI, a state DOI NPN
-- roster id, a licensed-professional slug or an SEC id). A claim starts
-- 'pending' and becomes 'verified' only when an operator confirms it, because a
-- verified phone proves who holds the phone, not who the listed person is. Only a
-- verified claim makes the owner's for-sale packets visible on the listing.
--
-- A person holds at most one active claim, and a listing has at most one
-- verified owner. Rows are user-owned (user_id): removed on account reset and
-- deletion, which returns the listing to unclaimed.
--
-- Replay-safe: every statement is guarded.

BEGIN;

CREATE TABLE IF NOT EXISTS directory_listing_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  listing_id TEXT NOT NULL CHECK (listing_id ~ '^[a-z0-9][a-z0-9:-]{0,127}$'),
  listing_name TEXT NOT NULL CHECK (char_length(listing_name) BETWEEN 1 AND 200),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'verified', 'rejected', 'withdrawn')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolution_note TEXT CHECK (resolution_note IS NULL OR char_length(resolution_note) <= 500)
);

DO $$
BEGIN
  IF to_regclass('public.uq_directory_listing_claims_active_user') IS NULL THEN
    CREATE UNIQUE INDEX uq_directory_listing_claims_active_user
      ON directory_listing_claims (user_id) WHERE status IN ('pending', 'verified');
  END IF;
  IF to_regclass('public.uq_directory_listing_claims_verified_listing') IS NULL THEN
    CREATE UNIQUE INDEX uq_directory_listing_claims_verified_listing
      ON directory_listing_claims (listing_id) WHERE status = 'verified';
  END IF;
  IF to_regclass('public.idx_directory_listing_claims_listing') IS NULL THEN
    CREATE INDEX idx_directory_listing_claims_listing
      ON directory_listing_claims (listing_id, status);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE oid = 'public.directory_listing_claims'::regclass AND relrowsecurity
  ) THEN
    ALTER TABLE directory_listing_claims ENABLE ROW LEVEL SECURITY;
  END IF;
END $$;

REVOKE ALL ON directory_listing_claims FROM PUBLIC;
DO $$ DECLARE role_name TEXT; BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON directory_listing_claims FROM %I', role_name);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON directory_listing_claims TO service_role;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'install_account_deletion_write_guards') THEN
    PERFORM public.install_account_deletion_write_guards();
  END IF;
END $$;

COMMENT ON TABLE directory_listing_claims IS
  'A One user''s claim to a public White Pages listing. pending until an operator verifies; one verified owner per listing, one active claim per user. Deleted on account reset and deletion.';

COMMIT;
