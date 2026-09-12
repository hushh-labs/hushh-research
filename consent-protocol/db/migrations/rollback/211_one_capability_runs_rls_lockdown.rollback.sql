BEGIN;

-- Emergency compatibility rollback: remove the RLS layer for a deployment
-- whose backend connects as the table owner without BYPASSRLS. Keep the ACL
-- lockdown and policy removal in place so rolling back never exposes durable
-- Agent One task state to PUBLIC, anon, or authenticated database clients.
ALTER TABLE public.one_capability_runs DISABLE ROW LEVEL SECURITY;

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
    REVOKE ALL PRIVILEGES ON TABLE public.one_capability_runs FROM service_role;
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON TABLE public.one_capability_runs TO service_role;
  END IF;
END $$;

COMMIT;
