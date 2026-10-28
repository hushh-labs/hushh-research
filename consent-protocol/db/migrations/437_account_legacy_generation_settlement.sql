-- Erasures that committed before provider cleanup receipts existed carry
-- migration 418's legacy marker, and migration 419 kept their generation zero
-- unconfirmed ("never promoted to verified provider cleanup"). This migration
-- adds one reviewed exception to that rule and settles nothing by itself: the
-- UAT overlay and reviewed operator runs call settle_legacy_account_generation.
-- A settled legacy generation is accepted for re-enrollment only. Its erasure
-- committed, its external identity was kept by design, and no provider
-- credential remains in Hussh custody here. Provider-side revocation was never
-- verified for these erasures. Every other history stays Action required.
BEGIN;

-- Public UUIDv8 reference for an accepted legacy erasure; never a grant.
CREATE OR REPLACE FUNCTION public.account_legacy_cleanup_reference(identity_digest text, generation integer)
RETURNS uuid LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT encode(set_byte(set_byte(digest,6,(get_byte(digest,6)&15)|128),8,(get_byte(digest,8)&63)|128),'hex')::uuid
 FROM (SELECT substring(sha256(convert_to('hussh-legacy-account-cleanup/v1|'||identity_digest
  ||'|'||generation::text,'UTF8')) FROM 1 FOR 16) AS digest) reference;
$$;

-- The sources of 418's account_provider_cleanup_live_inventory. Any remaining
-- row is custody whatever its status; an absent table holds none.
CREATE OR REPLACE FUNCTION public.account_legacy_provider_custody_absent(owner_digest text)
RETURNS boolean LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,public AS $$
DECLARE source text; held boolean;
BEGIN
 IF owner_digest IS NULL THEN RETURN false; END IF;
 FOREACH source IN ARRAY ARRAY['google_provider_connections','google_calendar_additional_accounts',
  'kai_gmail_connections','user_external_connector_connections','external_connector_oauth_attempts'] LOOP
  IF to_regclass('public.'||source) IS NULL THEN CONTINUE; END IF;
  EXECUTE format('SELECT EXISTS(SELECT 1 FROM public.%I WHERE ''sha256:''||encode(sha256(convert_to(user_id,''UTF8'')),''hex'')=$1)',
   source) INTO held USING owner_digest;
  IF held THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END;
$$;

-- Only erasures that kept the external identity can be presented again: the
-- retained shared identity, or the maintainer UAT backend-only erasure.
-- Deleted or absent identities, and any other outcome, stay Action required.
CREATE OR REPLACE FUNCTION public.account_legacy_cleanup_settleable(g public.account_generations)
RETURNS boolean LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,public AS $$
DECLARE erasure public.account_deletion_tombstones%ROWTYPE;
BEGIN
 IF g.retired_at IS NULL OR g.generation IS DISTINCT FROM 0 OR g.owner_hash IS DISTINCT FROM g.identity_hash
  OR g.cleanup_operation IS NOT NULL OR g.cleanup_confirmed IS NOT FALSE
  OR g.owner_id IS NOT NULL OR g.identity_uid IS NOT NULL THEN RETURN false; END IF;
 SELECT * INTO erasure FROM public.account_deletion_tombstones WHERE user_id_hash=g.owner_hash;
 IF NOT FOUND OR erasure.firebase_identity_hash IS DISTINCT FROM g.identity_hash
  OR erasure.cleanup_intent_kind IS DISTINCT FROM 'full_account' OR erasure.erasure_phase IS DISTINCT FROM 'erased'
  OR erasure.generation_retired_at IS DISTINCT FROM g.retired_at OR erasure.provider_cleanup_id IS NOT NULL
  OR erasure.provider_cleanup_receipt IS DISTINCT FROM jsonb_build_object('version',1,'coverage','legacy_unconfirmed')
  OR erasure.provider_cleanup_inventory IS DISTINCT FROM '{}'::jsonb
  OR erasure.firebase_uid IS NOT NULL OR erasure.account_owner_id IS NOT NULL
  OR erasure.cleanup_next_attempt_at IS NOT NULL OR erasure.cleanup_claim_token IS NOT NULL
  OR NOT ((erasure.cleanup_status,erasure.cleanup_last_outcome,erasure.cleanup_last_classification)
    IS NOT DISTINCT FROM ('quarantined'::text,'identity_retained'::text,'firebase_shared_identity_retained'::text)
   OR (erasure.cleanup_status,erasure.cleanup_last_outcome,erasure.cleanup_last_classification)
    IS NOT DISTINCT FROM ('completed'::text,NULL::text,'uat_backend_only_erasure'::text)) THEN
  RETURN false;
 END IF;
 RETURN public.account_firebase_mutations_settled(g.identity_hash)
  AND public.account_legacy_provider_custody_absent(g.owner_hash);
END;
$$;

-- The only writer of a legacy settlement. Idempotent: a settled row no longer qualifies.
CREATE OR REPLACE FUNCTION public.settle_legacy_account_generation(identity_digest text)
RETURNS boolean LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog,public AS $$
DECLARE latest public.account_generations%ROWTYPE;
BEGIN
 IF identity_digest IS NULL THEN RETURN false; END IF;
 -- Enrollment's identity lock, taken before the row lock as enrollment does.
 PERFORM pg_advisory_xact_lock(hashtextextended(identity_digest,199));
 SELECT * INTO latest FROM public.account_generations WHERE identity_hash=identity_digest
  ORDER BY generation DESC LIMIT 1 FOR UPDATE;
 IF NOT FOUND OR NOT public.account_legacy_cleanup_settleable(latest) THEN RETURN false; END IF;
 PERFORM set_config('hussh.account_legacy_settlement',identity_digest,true);
 UPDATE public.account_generations SET cleanup_confirmed=true,
  cleanup_operation=public.account_legacy_cleanup_reference(latest.identity_hash,latest.generation)
  WHERE identity_hash=latest.identity_hash AND generation=latest.generation;
 PERFORM set_config('hussh.account_legacy_settlement','',true);
 RETURN true;
END;
$$;

-- Migration 419's guard with one leading branch: only settle_legacy_account_generation
-- may confirm a qualified legacy generation, changing nothing else. The row is
-- immutable again afterwards, and every other write meets the unchanged 419 rules.
CREATE OR REPLACE FUNCTION public.guard_account_generation_history()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE settled public.account_deletion_tombstones%ROWTYPE;
 previous public.account_generations%ROWTYPE; qualified boolean;
BEGIN
 IF TG_OP='UPDATE' AND OLD.retired_at IS NOT NULL AND OLD.generation=0 AND OLD.cleanup_operation IS NULL
  AND OLD.cleanup_confirmed IS FALSE AND NEW.cleanup_confirmed IS TRUE
  AND current_setting('hussh.account_legacy_settlement',true) IS NOT DISTINCT FROM OLD.identity_hash THEN
  IF NEW.cleanup_operation IS NOT DISTINCT FROM public.account_legacy_cleanup_reference(OLD.identity_hash,OLD.generation)
   AND to_jsonb(NEW)-ARRAY['cleanup_operation','cleanup_confirmed']
    = to_jsonb(OLD)-ARRAY['cleanup_operation','cleanup_confirmed'] THEN
   IF public.account_legacy_cleanup_settleable(OLD) THEN
    RETURN NEW;
   END IF;
  END IF;
 END IF;
 IF TG_OP='DELETE' OR (TG_OP='UPDATE' AND
  (OLD.retired_at IS NOT NULL OR NEW.identity_hash IS DISTINCT FROM OLD.identity_hash
   OR NEW.generation IS DISTINCT FROM OLD.generation OR NEW.owner_hash IS DISTINCT FROM OLD.owner_hash
   OR NEW.enrollment_operation IS DISTINCT FROM OLD.enrollment_operation
   OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.admitted_after IS DISTINCT FROM OLD.admitted_after
   OR NEW.enrollment_authenticated_at IS DISTINCT FROM OLD.enrollment_authenticated_at
   OR NEW.enrollment_review_digest IS DISTINCT FROM OLD.enrollment_review_digest
   OR NEW.retired_at IS NULL)) THEN
  RAISE EXCEPTION 'account generation history is immutable' USING ERRCODE='42501';
 END IF;
 IF TG_OP='UPDATE' AND (NEW.owner_id IS NOT NULL OR NEW.identity_uid IS NOT NULL) THEN
  RAISE EXCEPTION 'retired account identity must be scrubbed' USING ERRCODE='42501';
 END IF;
 IF NEW.retired_at IS NOT NULL THEN
  IF TG_OP='INSERT' AND NEW.generation<>0 THEN
   RAISE EXCEPTION 'retired generation must already exist' USING ERRCODE='42501';
  END IF;
  SELECT * INTO settled FROM public.account_deletion_tombstones
   WHERE user_id_hash=NEW.owner_hash AND firebase_identity_hash=NEW.identity_hash
    AND cleanup_intent_kind='full_account' AND erasure_phase='erased';
  IF NOT FOUND OR NEW.cleanup_operation IS DISTINCT FROM settled.provider_cleanup_id
   OR NEW.retired_at IS DISTINCT FROM settled.generation_retired_at THEN
   RAISE EXCEPTION 'account retirement is unconfirmed' USING ERRCODE='42501';
  END IF;
  qualified:=(settled.cleanup_status='quarantined'
   AND settled.cleanup_last_outcome='identity_retained'
   AND settled.cleanup_last_classification='firebase_shared_identity_retained')
   AND public.account_provider_cleanup_qualified(settled.provider_cleanup_receipt,
    settled.provider_cleanup_inventory,settled.user_id_hash,settled.provider_cleanup_id) IS TRUE;
  IF TG_OP='INSERT' AND NEW.generation=0 AND NEW.owner_hash<>NEW.identity_hash THEN qualified:=false; END IF;
  IF NEW.cleanup_confirmed IS DISTINCT FROM qualified THEN
   RAISE EXCEPTION 'account cleanup evidence changed' USING ERRCODE='42501';
  END IF;
 ELSIF NEW.generation=0 THEN
  IF NEW.owner_id IS DISTINCT FROM NEW.identity_uid OR EXISTS(SELECT 1 FROM public.account_deletion_tombstones
   WHERE user_id_hash=NEW.owner_hash) THEN
   RAISE EXCEPTION 'legacy account is ineligible' USING ERRCODE='42501';
  END IF;
 ELSE
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.identity_hash,199));
  IF NOT public.account_firebase_mutations_settled(NEW.identity_hash) THEN
   RAISE EXCEPTION 'identity mutation requires reconciliation' USING ERRCODE='42501';
  END IF;
  SELECT * INTO previous FROM public.account_generations WHERE identity_hash=NEW.identity_hash
   ORDER BY generation DESC LIMIT 1;
  IF NOT FOUND OR previous.generation<>NEW.generation-1 OR previous.retired_at IS NULL
   OR previous.cleanup_confirmed IS NOT TRUE OR NEW.cleanup_operation IS DISTINCT FROM previous.cleanup_operation
   OR NEW.admitted_after IS DISTINCT FROM public.account_generation_admission_cutoff(previous.retired_at)
   OR NEW.owner_id !~ '^acct_[0-9a-f]{32}$'
   OR NEW.enrollment_operation IS NULL OR NEW.cleanup_operation IS NULL
   OR NEW.enrollment_authenticated_at IS NULL OR NEW.enrollment_authenticated_at<=NEW.admitted_after
   OR NEW.enrollment_authenticated_at<extract(epoch FROM clock_timestamp())-300
   OR NEW.enrollment_authenticated_at>extract(epoch FROM clock_timestamp())
   OR NEW.enrollment_review_digest IS DISTINCT FROM public.account_enrollment_review_digest(
    NEW.identity_hash,NEW.generation-1,NEW.cleanup_operation,NEW.enrollment_operation,
    NEW.enrollment_authenticated_at,NEW.admitted_after)
   OR EXISTS(SELECT 1 FROM public.account_identity_presence WHERE user_id_hash=NEW.owner_hash) THEN
   RAISE EXCEPTION 'account enrollment lineage is unconfirmed' USING ERRCODE='42501';
  END IF;
 END IF;
 RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.account_legacy_cleanup_reference(text,integer) IS
 'Public UUIDv8 reference recorded as cleanup_operation for an accepted legacy erasure. Legacy settlements are exactly the rows where cleanup_operation equals this value for (identity_hash, generation).';
COMMENT ON FUNCTION public.account_legacy_cleanup_settleable(public.account_generations) IS
 'Legacy erasure accepted for re-enrollment: committed legacy erasure, external identity kept by design, settled identity writes, no provider credential in Hussh custody in this environment. Provider-side revocation was not verified.';
COMMENT ON FUNCTION public.settle_legacy_account_generation(text) IS
 'Sole writer of a legacy settlement. Called only by the UAT overlay and reviewed operator runs, never by an application request path.';

REVOKE ALL ON FUNCTION public.account_legacy_cleanup_reference(text,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.account_legacy_provider_custody_absent(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.account_legacy_cleanup_settleable(public.account_generations) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.settle_legacy_account_generation(text) FROM PUBLIC;
DO $$ DECLARE client_role text;
BEGIN
 FOREACH client_role IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=client_role) THEN
   EXECUTE format('REVOKE ALL ON FUNCTION public.account_legacy_cleanup_reference(text,integer) FROM %I',client_role);
   EXECUTE format('REVOKE ALL ON FUNCTION public.account_legacy_provider_custody_absent(text) FROM %I',client_role);
   EXECUTE format('REVOKE ALL ON FUNCTION public.account_legacy_cleanup_settleable(public.account_generations) FROM %I',client_role);
   EXECUTE format('REVOKE ALL ON FUNCTION public.settle_legacy_account_generation(text) FROM %I',client_role);
  END IF;
 END LOOP;
END;
$$;
COMMIT;
