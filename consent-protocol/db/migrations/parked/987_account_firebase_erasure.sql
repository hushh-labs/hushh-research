-- Fresh Dev identity erasure extends the existing staged account cleanup.
-- Historical authority stays NULL. Provider receipt v2 and its checks stay intact.
BEGIN;
LOCK TABLE public.account_deletion_tombstones IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.account_generations IN SHARE ROW EXCLUSIVE MODE;
DO $firebase_erasure_preimage$ DECLARE expected record; observed record; BEGIN
 FOR expected IN SELECT * FROM (VALUES ('guard_account_generation_history()','9868a2b1da81ec2bc77d428b8a460e280911270ea0bd4a8458e84a8154ca6df7'),('retire_erased_account_generation()','8319de4b4bd150db306bca77bb784bfd75c0a50ad52510c20146f5be47c37a2f')) pin(signature,sha256) LOOP
  SELECT p.proowner,p.prosecdef,p.prokind,
   encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex') AS sha256
   INTO observed FROM pg_proc p WHERE p.oid=to_regprocedure('public.'||expected.signature);
  IF observed.sha256 IS DISTINCT FROM expected.sha256 OR observed.prosecdef IS DISTINCT FROM false
   OR observed.prokind IS DISTINCT FROM 'f' OR observed.proowner IS DISTINCT FROM
    (SELECT relowner FROM pg_class WHERE oid='public.account_deletion_tombstones'::regclass) THEN
   RAISE EXCEPTION 'Unqualified Firebase erasure preimage' USING ERRCODE='42501';
  END IF;
 END LOOP;
END $firebase_erasure_preimage$;

ALTER TABLE public.account_deletion_tombstones
 ADD COLUMN IF NOT EXISTS firebase_cleanup_project text,
 ADD COLUMN IF NOT EXISTS firebase_erasure_authority jsonb,
 ADD COLUMN IF NOT EXISTS firebase_erasure_checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE OR REPLACE FUNCTION public.account_firebase_erasure_contract_version()
RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$ SELECT 1 $$;

CREATE OR REPLACE FUNCTION public.account_firebase_erasure_qualified(t public.account_deletion_tombstones)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$
 SELECT (t.firebase_erasure_authority IS NOT NULL
  AND t.firebase_erasure_authority->>'projectId'='hushh-pda-dev'
  AND t.firebase_cleanup_project=t.firebase_erasure_authority->>'projectId'
  AND t.firebase_erasure_authority->>'identityHash'=t.firebase_identity_hash
  AND t.firebase_erasure_authority->>'ownerHash'=t.user_id_hash
  AND t.firebase_erasure_authority->>'cleanupId'=t.provider_cleanup_id::text
  AND t.firebase_erasure_checkpoint->>'state'='absent'
  AND t.firebase_erasure_checkpoint->>'observation'='USER_NOT_FOUND') IS TRUE;
$$;

CREATE OR REPLACE FUNCTION public.guard_account_firebase_erasure()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE a jsonb:=NEW.firebase_erasure_authority; checkpoint jsonb:=NEW.firebase_erasure_checkpoint;
 previous_state text; next_state text:=checkpoint->>'state'; g public.account_generations%ROWTYPE;
BEGIN
 IF (TG_OP='UPDATE' AND NEW.firebase_cleanup_project IS DISTINCT FROM OLD.firebase_cleanup_project)
  OR (NEW.firebase_cleanup_project IS NOT NULL AND NEW.firebase_cleanup_project<>'hushh-pda-dev') THEN
  RAISE EXCEPTION 'Firebase cleanup realm is immutable' USING ERRCODE='42501';
 END IF;
 IF TG_OP='UPDATE' AND a IS DISTINCT FROM OLD.firebase_erasure_authority THEN
  RAISE EXCEPTION 'Firebase erasure authority is immutable' USING ERRCODE='42501';
 END IF;
 IF a IS NULL THEN
  IF checkpoint IS DISTINCT FROM '{}'::jsonb OR
   (NEW.firebase_cleanup_project IS NOT NULL AND NEW.cleanup_intent_kind='full_account') THEN
   RAISE EXCEPTION 'Historical Firebase erasure cannot acquire authority' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
 END IF;
 IF jsonb_typeof(a) IS DISTINCT FROM 'object'
  OR a-ARRAY['version','projectId','identityHash','ownerHash','accountGeneration','cleanupId']<>'{}'::jsonb
  OR a->'version' IS DISTINCT FROM '1'::jsonb OR a->>'projectId' IS DISTINCT FROM 'hushh-pda-dev'
  OR NEW.firebase_cleanup_project IS DISTINCT FROM a->>'projectId'
  OR a->>'identityHash' IS DISTINCT FROM NEW.firebase_identity_hash
  OR a->>'ownerHash' IS DISTINCT FROM NEW.user_id_hash
  OR a->>'cleanupId' IS DISTINCT FROM NEW.provider_cleanup_id::text
  OR coalesce(a->>'accountGeneration','') !~ '^(0|[1-9][0-9]{0,8})$'
  OR NEW.cleanup_intent_kind IS DISTINCT FROM 'full_account' OR NEW.provider_cleanup_id IS NULL
  OR jsonb_typeof(checkpoint) IS DISTINCT FROM 'object'
  OR octet_length(checkpoint::text)>1024
  OR checkpoint-ARRAY['state','requestId','identityCreatedAt','observation']<>'{}'::jsonb
  OR coalesce(next_state,'') NOT IN ('prepared','dispatched','absent') THEN
  RAISE EXCEPTION 'Invalid Firebase erasure binding' USING ERRCODE='42501';
 END IF;
 IF TG_OP='INSERT' THEN
  IF checkpoint IS DISTINCT FROM jsonb_build_object('state','prepared') THEN
   RAISE EXCEPTION 'Firebase erasure must start prepared' USING ERRCODE='42501';
  END IF;
 ELSE
  previous_state:=OLD.firebase_erasure_checkpoint->>'state';
  IF checkpoint IS DISTINCT FROM OLD.firebase_erasure_checkpoint THEN
   IF OLD.erasure_phase<>'provider_cleanup' OR NEW.erasure_phase<>'provider_cleanup'
    OR NEW.cleanup_status<>'running' OR NEW.cleanup_claim_token IS NULL
    OR NEW.cleanup_claim_token IS DISTINCT FROM OLD.cleanup_claim_token
    OR NEW.cleanup_claimed_at IS DISTINCT FROM OLD.cleanup_claimed_at
    OR NEW.cleanup_claimed_at IS NULL OR NEW.cleanup_claimed_at<=clock_timestamp()-interval '5 minutes'
    OR previous_state='absent' OR next_state='prepared'
    OR (previous_state='dispatched' AND checkpoint-'state'-'observation'
      IS DISTINCT FROM OLD.firebase_erasure_checkpoint-'state'-'observation')
    OR public.account_provider_cleanup_qualified(NEW.provider_cleanup_receipt,
      NEW.provider_cleanup_inventory,NEW.user_id_hash,NEW.provider_cleanup_id) IS NOT TRUE THEN
    RAISE EXCEPTION 'Firebase erasure transition is unqualified' USING ERRCODE='42501';
   END IF;
   PERFORM pg_advisory_xact_lock(hashtextextended(NEW.firebase_identity_hash,199));
   IF public.account_firebase_mutations_settled(NEW.firebase_identity_hash) IS NOT TRUE THEN
    RAISE EXCEPTION 'Firebase identity mutation is unsettled' USING ERRCODE='42501';
   END IF;
   SELECT * INTO g FROM public.account_generations WHERE owner_hash=NEW.user_id_hash;
   IF (FOUND AND (g.retired_at IS NOT NULL OR g.identity_hash IS DISTINCT FROM NEW.firebase_identity_hash
     OR g.generation IS DISTINCT FROM (a->>'accountGeneration')::integer))
    OR (NOT FOUND AND (a->>'accountGeneration'<>'0' OR NEW.user_id_hash<>NEW.firebase_identity_hash)) THEN
    RAISE EXCEPTION 'Firebase erasure generation changed' USING ERRCODE='42501';
   END IF;
  END IF;
 END IF;
 IF next_state='dispatched' AND (coalesce(checkpoint->>'requestId','') !~ '^[0-9a-f-]{36}$'
  OR jsonb_typeof(checkpoint->'identityCreatedAt') IS DISTINCT FROM 'number'
  OR checkpoint ? 'observation') THEN
  RAISE EXCEPTION 'Firebase dispatch evidence is invalid' USING ERRCODE='42501';
 END IF;
 IF next_state='absent' AND (checkpoint->>'observation' IS DISTINCT FROM 'USER_NOT_FOUND'
  OR (TG_OP='UPDATE' AND previous_state='prepared' AND checkpoint IS DISTINCT FROM
    jsonb_build_object('state','absent','observation','USER_NOT_FOUND'))) THEN
  RAISE EXCEPTION 'Native Firebase absence is required' USING ERRCODE='42501';
 END IF;
 IF NEW.erasure_phase IN ('local_erasure','erased')
  AND public.account_firebase_erasure_qualified(NEW) IS NOT TRUE THEN
  RAISE EXCEPTION 'Firebase erasure has not settled' USING ERRCODE='42501';
 END IF;
 IF NEW.erasure_phase='erased' AND (NEW.cleanup_status IS DISTINCT FROM 'completed'
  OR NEW.cleanup_last_outcome IS DISTINCT FROM 'deleted'
  OR NEW.cleanup_last_classification IS DISTINCT FROM 'firebase_isolated_identity_absent') THEN
  RAISE EXCEPTION 'Isolated Firebase erasure outcome is unconfirmed' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS account_firebase_erasure ON public.account_deletion_tombstones;
CREATE TRIGGER account_firebase_erasure BEFORE INSERT OR UPDATE
 ON public.account_deletion_tombstones FOR EACH ROW EXECUTE FUNCTION public.guard_account_firebase_erasure();

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
  qualified:=((settled.firebase_erasure_authority IS NULL AND settled.cleanup_status='quarantined'
   AND settled.cleanup_last_outcome='identity_retained'
   AND settled.cleanup_last_classification='firebase_shared_identity_retained')
   OR (public.account_firebase_erasure_qualified(settled)
    AND settled.cleanup_status='completed' AND settled.cleanup_last_outcome='deleted'
    AND settled.cleanup_last_classification='firebase_isolated_identity_absent'))
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

CREATE OR REPLACE FUNCTION public.retire_erased_account_generation()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE current_generation public.account_generations%ROWTYPE; confirmed boolean;
BEGIN
 IF NEW.cleanup_intent_kind<>'full_account' OR NEW.erasure_phase<>'erased'
  OR OLD.erasure_phase='erased' THEN RETURN NEW; END IF;
 confirmed:=((NEW.firebase_erasure_authority IS NULL AND NEW.cleanup_status='quarantined'
  AND NEW.cleanup_last_outcome='identity_retained'
  AND NEW.cleanup_last_classification='firebase_shared_identity_retained')
  OR (public.account_firebase_erasure_qualified(NEW)
   AND NEW.cleanup_status='completed' AND NEW.cleanup_last_outcome='deleted'
   AND NEW.cleanup_last_classification='firebase_isolated_identity_absent'))
  AND public.account_provider_cleanup_qualified(
  NEW.provider_cleanup_receipt,NEW.provider_cleanup_inventory,NEW.user_id_hash,
  NEW.provider_cleanup_id) IS TRUE;
 SELECT * INTO current_generation FROM public.account_generations
  WHERE owner_hash=NEW.user_id_hash FOR UPDATE;
 IF FOUND THEN
  IF current_generation.retired_at IS NOT NULL
   OR current_generation.identity_hash IS DISTINCT FROM NEW.firebase_identity_hash THEN
   RAISE EXCEPTION 'account generation retirement changed' USING ERRCODE='42501';
  END IF;
  UPDATE public.account_generations SET retired_at=NEW.generation_retired_at,owner_id=NULL,
   identity_uid=NULL,cleanup_operation=NEW.provider_cleanup_id,cleanup_confirmed=confirmed
   WHERE owner_hash=NEW.user_id_hash;
 ELSE
  -- Only a legacy generation-zero owner may lack an explicit generation row.
  IF NEW.firebase_identity_hash IS DISTINCT FROM NEW.user_id_hash THEN
   RAISE EXCEPTION 'account generation binding is missing' USING ERRCODE='42501';
  END IF;
  INSERT INTO public.account_generations(identity_hash,generation,owner_hash,retired_at,
   cleanup_operation,cleanup_confirmed) VALUES(NEW.firebase_identity_hash,0,NEW.user_id_hash,
   NEW.generation_retired_at,NEW.provider_cleanup_id,confirmed);
 END IF;
 RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.account_firebase_erasure_contract_version() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.account_firebase_erasure_qualified(public.account_deletion_tombstones) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_account_firebase_erasure() FROM PUBLIC;
COMMIT;
