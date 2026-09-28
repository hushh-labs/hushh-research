-- Which version of the Terms of Use and Privacy Policy each person accepted,
-- when, and from which surface.
--
-- One row per (person, document, version, effective date). Accepting the same
-- version again is a no-op that keeps the first accepted_at, so the table is an
-- append-only history: a policy update adds rows and never rewrites an earlier
-- acceptance. The version strings come from the app's legal document source;
-- the server validates their shape, not their meaning.
--
-- No foreign key to actor_profiles: acceptance is recorded at sign-in, before a
-- vault or actor profile exists. Rows are removed by an explicit DELETE in the
-- full account-deletion path and are kept across an account reset, because the
-- account (and its agreement) survives a reset.
--
-- Replay-safe: every statement is guarded, so re-running the migration on each
-- deploy changes nothing and never takes a lock on a populated table.

BEGIN;

CREATE TABLE IF NOT EXISTS account_legal_acceptances (
  user_id TEXT NOT NULL,
  document_id TEXT NOT NULL CHECK (document_id IN ('terms', 'privacy')),
  document_version TEXT NOT NULL CHECK (char_length(document_version) BETWEEN 1 AND 64),
  effective_date TEXT NOT NULL CHECK (char_length(effective_date) BETWEEN 1 AND 64),
  surface TEXT NOT NULL CHECK (surface IN ('web', 'native')),
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, document_id, document_version, effective_date)
);

DO $$
BEGIN
  IF to_regclass('public.idx_account_legal_acceptances_latest') IS NULL THEN
    CREATE INDEX idx_account_legal_acceptances_latest
      ON account_legal_acceptances (user_id, document_id, accepted_at DESC);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = 'public.account_legal_acceptances'::regclass AND relrowsecurity
  ) THEN
    ALTER TABLE account_legal_acceptances ENABLE ROW LEVEL SECURITY;
  END IF;
END $$;

REVOKE ALL ON account_legal_acceptances FROM PUBLIC;
DO $$ DECLARE role_name TEXT; BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON account_legal_acceptances FROM %I', role_name);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, DELETE ON account_legal_acceptances TO service_role;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'install_account_deletion_write_guards') THEN
    PERFORM public.install_account_deletion_write_guards();
  END IF;
END $$;

COMMENT ON TABLE account_legal_acceptances IS
  'Append-only record of the Terms of Use and Privacy Policy versions each person accepted, with accepted_at and surface (web or native). Kept across account reset; deleted with the account.';

COMMIT;
