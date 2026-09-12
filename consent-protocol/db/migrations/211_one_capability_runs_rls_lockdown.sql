BEGIN;

-- one_capability_runs is server-owned workflow authority. Browser and mobile
-- callers reach it only through the authenticated Capability Runtime API; no
-- database-facing client role receives a row policy or direct table access.
--
-- The Cloud SQL runtime and migration credentials currently share the table
-- owner role, so PostgreSQL's owner bypass is the backend access path there.
-- Supabase-compatible environments use service_role's BYPASSRLS path. Do not
-- FORCE RLS until runtime and schema-owner credentials are separated.
ALTER TABLE public.one_capability_runs ENABLE ROW LEVEL SECURITY;

-- Remove any out-of-band policy rather than letting an earlier/manual policy
-- silently turn this default-deny table into a direct client data plane.
DO $$
DECLARE
  existing_policy RECORD;
BEGIN
  FOR existing_policy IN
    SELECT policy.polname
    FROM pg_policy AS policy
    WHERE policy.polrelid = 'public.one_capability_runs'::regclass
  LOOP
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON public.one_capability_runs',
      existing_policy.polname
    );
  END LOOP;
END $$;

REVOKE ALL PRIVILEGES ON TABLE public.one_capability_runs FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL PRIVILEGES ON TABLE public.one_capability_runs FROM anon;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL PRIVILEGES ON TABLE public.one_capability_runs FROM authenticated;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    -- Normalize away default/broad table grants (TRUNCATE, REFERENCES, TRIGGER)
    -- before granting only the DML operations used by the backend runtime.
    REVOKE ALL PRIVILEGES ON TABLE public.one_capability_runs FROM service_role;
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON TABLE public.one_capability_runs TO service_role;
  END IF;
END $$;

COMMIT;
