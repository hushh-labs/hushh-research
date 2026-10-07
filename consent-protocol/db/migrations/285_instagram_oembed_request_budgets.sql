-- One app-wide oEmbed budget across production Cloud Run workers and instances.
-- Production 12/minute and UAT 4/minute stay below Meta's 1,000 requests/hour
-- allowance even across two partial boundary minutes ((12 + 4) * 61 = 976).
BEGIN;

CREATE TABLE IF NOT EXISTS public.instagram_oembed_request_budgets (
  bucket_start TIMESTAMPTZ PRIMARY KEY,
  request_count INTEGER NOT NULL CHECK (request_count BETWEEN 1 AND 12)
);

COMMENT ON TABLE public.instagram_oembed_request_budgets IS
  'Short-lived, app-wide Instagram oEmbed request counts. No account, post URL, token, IP address, or other personal information.';

ALTER TABLE public.instagram_oembed_request_budgets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.instagram_oembed_request_budgets FROM PUBLIC;
DO $$
DECLARE role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.instagram_oembed_request_budgets FROM %I', role_name);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.instagram_oembed_request_budgets TO service_role;
  END IF;
END $$;

COMMIT;
