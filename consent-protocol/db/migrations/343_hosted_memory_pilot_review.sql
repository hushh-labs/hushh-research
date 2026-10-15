-- Pending owner review only. No worker may read sources or decrypt memory from
-- these rows; no vault key, owner token, DEK or attestation is stored here.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.live_memory_hosted_pilot_grants (
  user_id TEXT PRIMARY KEY REFERENCES public.vault_keys(user_id) ON DELETE CASCADE,
  grant_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  generation BIGINT NOT NULL DEFAULT 1 CHECK (generation > 0),
  source_kind TEXT NOT NULL CHECK (source_kind = 'curated_oauth_connector'),
  review_version TEXT NOT NULL CHECK (review_version = 'hosted_memory_pilot.v1'),
  status TEXT NOT NULL CHECK (status IN ('pending', 'revoked')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  reviewed_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  CHECK (expires_at > reviewed_at),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);

COMMENT ON TABLE public.live_memory_hosted_pilot_grants IS
  'Owner-reviewed pending intent for one hosted-memory source. No active capture state, worker capability, key material, owner token, attestation, or source value.';

ALTER TABLE public.live_memory_hosted_pilot_grants ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.live_memory_hosted_pilot_grants FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON public.live_memory_hosted_pilot_grants TO service_role;
  END IF;
END $$;

-- Install the existing tombstone guard for this newly created UID-bearing
-- table, including when an older application runtime is serving traffic.
DO $$
BEGIN
  IF to_regprocedure('public.install_account_deletion_write_guards()') IS NOT NULL THEN
    PERFORM public.install_account_deletion_write_guards();
  END IF;
END $$;
COMMIT;
