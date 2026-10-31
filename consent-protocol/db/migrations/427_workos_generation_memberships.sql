-- SPDX-License-Identifier: Apache-2.0
-- SPDX-FileCopyrightText: 2026 Hushh
-- Immutable provider attribution; no credentials, email, names or raw provider IDs.
CREATE TABLE IF NOT EXISTS public.account_workos_memberships (
 membership_hash text PRIMARY KEY CHECK(membership_hash ~ '^sha256:[0-9a-f]{64}$'),
 binding_hash text NOT NULL UNIQUE CHECK(binding_hash ~ '^sha256:[0-9a-f]{64}$'),
 profile_hash text NOT NULL UNIQUE CHECK(profile_hash ~ '^sha256:[0-9a-f]{64}$'),
 identity_hash text NOT NULL CHECK(identity_hash ~ '^sha256:[0-9a-f]{64}$'),
 owner_hash text NOT NULL CHECK(owner_hash ~ '^sha256:[0-9a-f]{64}$'),
 generation integer NOT NULL CHECK(generation=0),
 origin text NOT NULL CHECK(origin IN ('created','linked')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 offboarded_at timestamptz,
 FOREIGN KEY(identity_hash,generation) REFERENCES public.account_generations(identity_hash,generation)
);
REVOKE ALL ON public.account_workos_memberships FROM PUBLIC;
COMMENT ON TABLE public.account_workos_memberships IS
 'Immutable hash-only SSO/Directory Sync attribution to the original generation. Retain after erasure to refuse stale webhook rebinding. Replacement SSO enrollment is not supported.';
CREATE OR REPLACE FUNCTION public.guard_workos_generation_membership()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='DELETE' OR (TG_OP='UPDATE' AND (
  ROW(NEW.membership_hash,NEW.binding_hash,NEW.profile_hash,NEW.identity_hash,
      NEW.owner_hash,NEW.generation,NEW.origin,NEW.created_at)
  IS DISTINCT FROM ROW(OLD.membership_hash,OLD.binding_hash,OLD.profile_hash,OLD.identity_hash,
      OLD.owner_hash,OLD.generation,OLD.origin,OLD.created_at)
  OR OLD.offboarded_at IS NOT NULL OR NEW.offboarded_at IS NULL)) THEN
  RAISE EXCEPTION 'WorkOS membership attribution is immutable' USING ERRCODE='42501';
 END IF;
 IF TG_OP='INSERT' AND (NEW.offboarded_at IS NOT NULL OR NOT EXISTS(
  SELECT 1 FROM public.account_generations g WHERE g.identity_hash=NEW.identity_hash
    AND g.generation=NEW.generation AND g.owner_hash=NEW.owner_hash AND g.retired_at IS NULL)) THEN
  RAISE EXCEPTION 'WorkOS generation binding is unconfirmed' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS workos_generation_membership ON public.account_workos_memberships;
CREATE TRIGGER workos_generation_membership BEFORE INSERT OR UPDATE OR DELETE
 ON public.account_workos_memberships FOR EACH ROW
 EXECUTE FUNCTION public.guard_workos_generation_membership();
ALTER TABLE public.account_firebase_mutations DROP CONSTRAINT account_firebase_mutations_purpose_check;
ALTER TABLE public.account_firebase_mutations ADD CONSTRAINT account_firebase_mutations_purpose_check
 CHECK(purpose IN ('display_name','welcome_marker','phone_unlink','sso_claims','sso_create','sso_offboarding'));
REVOKE ALL ON FUNCTION public.guard_workos_generation_membership() FROM PUBLIC;
DO $$ DECLARE client_role text;
BEGIN
 FOREACH client_role IN ARRAY ARRAY['anon','authenticated'] LOOP
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=client_role) THEN
   EXECUTE format('REVOKE ALL ON public.account_workos_memberships FROM %I',client_role);
  END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  GRANT SELECT,INSERT,UPDATE ON public.account_workos_memberships TO service_role;
 END IF;
END;
$$;
