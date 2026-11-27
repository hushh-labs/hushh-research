-- An incompatible rollback cannot discard any isolated identity-erasure intent.
BEGIN;
LOCK TABLE public.account_deletion_tombstones IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.account_generations IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.account_deletion_tombstones WHERE firebase_erasure_authority IS NOT NULL OR firebase_cleanup_project IS NOT NULL) THEN
  RAISE EXCEPTION 'Isolated Firebase erasure requires forward recovery' USING ERRCODE='42501';
 END IF;
END $$;
DROP TRIGGER account_firebase_erasure ON public.account_deletion_tombstones;
DROP FUNCTION public.guard_account_firebase_erasure();
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

CREATE OR REPLACE FUNCTION public.retire_erased_account_generation()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE current_generation public.account_generations%ROWTYPE; confirmed boolean;
BEGIN
 IF NEW.cleanup_intent_kind<>'full_account' OR NEW.erasure_phase<>'erased'
  OR OLD.erasure_phase='erased' THEN RETURN NEW; END IF;
 confirmed:=(NEW.cleanup_status='quarantined'
  AND NEW.cleanup_last_outcome='identity_retained'
  AND NEW.cleanup_last_classification='firebase_shared_identity_retained')
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
DROP FUNCTION public.account_firebase_erasure_qualified(public.account_deletion_tombstones);
DROP FUNCTION public.account_firebase_erasure_contract_version();
ALTER TABLE public.account_deletion_tombstones DROP COLUMN firebase_erasure_authority, DROP COLUMN firebase_erasure_checkpoint, DROP COLUMN firebase_cleanup_project;
COMMIT;
