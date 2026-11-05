-- Refuse removal of any retained forward-recovery authority.
BEGIN;
DO $rollback$ BEGIN
 LOCK TABLE public.personal_agent_cloud_removals IN ACCESS EXCLUSIVE MODE;
 IF EXISTS(SELECT 1 FROM public.personal_agent_cloud_removals WHERE recovery IS NOT NULL) THEN
  RAISE EXCEPTION 'Legacy recovery retained; forward recovery required'; END IF;
END $rollback$;
CREATE OR REPLACE FUNCTION public.assert_project_grant_admission(project_id text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
 IF project_id IS NULL OR project_id='' THEN RETURN; END IF;
 IF (project_id !~ '^[a-z][a-z0-9-]{4,61}[a-z0-9]$'
     AND project_id !~ '^/subscriptions/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/resourceGroups/[A-Za-z0-9_().-]{0,89}[A-Za-z0-9_()-]$')
 OR current_setting('transaction_isolation') <> 'read committed' THEN
  RAISE EXCEPTION 'project grant admission unavailable' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(project_id,205));
 IF EXISTS (SELECT 1 FROM public.personal_agent_registry r WHERE r.backend_metadata->'erasure'->'grantRelease'->>'project'=project_id) THEN
  RAISE EXCEPTION 'project grant release reserved' USING ERRCODE='42501'; END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.guard_personal_agent_cloud_removal()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE owner_id text; agent public.personal_agent_registry%ROWTYPE; r jsonb; review jsonb; history jsonb;
BEGIN
 owner_id:=CASE WHEN TG_OP='DELETE' THEN OLD.user_id ELSE NEW.user_id END;
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 -- Full account erasure explicitly removes these records in its own transaction.
 IF TG_OP='DELETE' THEN
  IF EXISTS(SELECT 1 FROM public.account_deletion_tombstones WHERE cleanup_intent_kind='full_account'
   AND user_id_hash='sha256:'||encode(sha256(convert_to(owner_id,'UTF8')),'hex')) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'cloud removal evidence retained' USING ERRCODE='42501';
 END IF;
 IF EXISTS(SELECT 1 FROM public.account_deletion_tombstones
  WHERE user_id_hash='sha256:'||encode(sha256(convert_to(owner_id,'UTF8')),'hex')) THEN
  RAISE EXCEPTION 'cloud removal owner deleted' USING ERRCODE='42501'; END IF;
 SELECT * INTO agent FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 r:=agent.backend_metadata->'erasure';
 IF NOT FOUND OR agent.status IS DISTINCT FROM 'suspended' OR jsonb_typeof(r) IS DISTINCT FROM 'object'
 OR NEW.attempt_id IS DISTINCT FROM r->>'attemptId' OR r->>'ownerId' IS DISTINCT FROM owner_id
 OR NEW.placement_epoch IS DISTINCT FROM agent.placement_epoch
 OR NEW.snapshot_sha256 IS DISTINCT FROM encode(sha256(convert_to((r->'registrySnapshot')::text,'UTF8')),'hex') THEN
  RAISE EXCEPTION 'cloud removal placement changed' USING ERRCODE='42501'; END IF;
 IF TG_OP='UPDATE' AND OLD.cancelled_at IS NOT NULL THEN
  RAISE EXCEPTION 'cancelled cloud removal immutable' USING ERRCODE='42501'; END IF;
 IF TG_OP='UPDATE' AND NEW.cancelled_at IS NOT NULL THEN
  IF to_jsonb(NEW)-'cancelled_at' IS DISTINCT FROM to_jsonb(OLD)-'cancelled_at'
  OR public.cloud_removal_cancel_ready(owner_id,NEW.attempt_id) IS NOT TRUE THEN
   RAISE EXCEPTION 'cloud removal cannot cancel' USING ERRCODE='42501'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.approved_digest IS NOT NULL OR NEW.archive IS NOT NULL OR NEW.cancelled_at IS NOT NULL OR NEW.execution_started_at IS NOT NULL OR NEW.execution_digest IS NOT NULL THEN
   RAISE EXCEPTION 'cloud removal approval required' USING ERRCODE='42501'; END IF;
  RETURN NEW;
 END IF;
 IF OLD.completed_at IS NOT NULL OR to_jsonb(NEW)-ARRAY['approved_digest','approved_at','completed_at','archive','released_identity','execution_started_at','execution_digest']
  IS DISTINCT FROM to_jsonb(OLD)-ARRAY['approved_digest','approved_at','completed_at','archive','released_identity','execution_started_at','execution_digest'] THEN
  RAISE EXCEPTION 'cloud removal evidence immutable' USING ERRCODE='42501'; END IF;
 IF OLD.execution_started_at IS NOT NULL AND (NEW.execution_started_at IS DISTINCT FROM OLD.execution_started_at
  OR NEW.execution_digest IS DISTINCT FROM OLD.execution_digest) THEN
  RAISE EXCEPTION 'cloud removal dispatch immutable' USING ERRCODE='42501'; END IF;
 IF NEW.execution_started_at IS NOT NULL AND (NEW.execution_digest IS DISTINCT FROM NEW.approved_digest
  OR (OLD.execution_started_at IS NULL AND public.personal_agent_cloud_removal_execute_ready(owner_id,NEW.attempt_id) IS NOT TRUE)) THEN
  RAISE EXCEPTION 'cloud removal dispatch not admitted' USING ERRCODE='42501'; END IF;
 review:=public.personal_agent_cloud_removal_review(r);
 IF NEW.approved_digest IS NULL OR NEW.approved_digest IS DISTINCT FROM encode(sha256(convert_to(review::text,'UTF8')),'hex')
 OR (NEW.archive IS NOT NULL AND (NEW.approved_digest IS DISTINCT FROM OLD.approved_digest
  OR NEW.approved_at IS DISTINCT FROM OLD.approved_at)) THEN
  RAISE EXCEPTION 'cloud removal approval changed' USING ERRCODE='42501'; END IF;
 IF NEW.archive IS NOT NULL THEN
  SELECT authorization_attempts INTO history FROM public.byoc_setup_jobs WHERE user_id=owner_id;
  IF public.personal_agent_erasure_complete(owner_id) IS NOT TRUE
  OR NEW.archive IS DISTINCT FROM public.personal_agent_erasure_archive(r,history)
  OR NEW.released_identity IS DISTINCT FROM public.personal_agent_cloud_removal_identity(to_jsonb(agent),NEW.completed_at,NEW.attempt_id) THEN
   RAISE EXCEPTION 'cloud removal completion unconfirmed' USING ERRCODE='42501'; END IF;
 END IF;
 RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.finalize_personal_agent_cloud_removal(owner_id text, attempt text, expected_digest text)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE agent public.personal_agent_registry%ROWTYPE; op public.personal_agent_cloud_removals%ROWTYPE;
 r jsonb; history jsonb; removed_at timestamptz; replacement public.personal_agent_registry%ROWTYPE;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 IF public.personal_agent_cloud_removal_ready() IS NOT TRUE THEN RETURN false; END IF;
 SELECT * INTO op FROM public.personal_agent_cloud_removals WHERE user_id=owner_id AND attempt_id=attempt FOR UPDATE;
 IF NOT FOUND OR op.approved_digest IS DISTINCT FROM expected_digest OR expected_digest IS NULL THEN RETURN false; END IF;
 -- A lost response is recoverable only while its exact released identity is
 -- still current. A replacement never becomes "unplaced" through an old replay.
 IF op.completed_at IS NOT NULL THEN
  RETURN public.personal_agent_cloud_removal_replay_current(owner_id,attempt);
 END IF;
 IF public.personal_agent_erasure_complete(owner_id) IS NOT TRUE
 OR EXISTS(SELECT 1 FROM public.personal_agent_standby_placements WHERE user_id=owner_id) THEN RETURN false; END IF;
 SELECT * INTO agent FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 r:=agent.backend_metadata->'erasure';
 IF r->>'attemptId' IS DISTINCT FROM attempt THEN RETURN false; END IF;
 SELECT authorization_attempts INTO history FROM public.byoc_setup_jobs WHERE user_id=owner_id FOR UPDATE;
 removed_at:=clock_timestamp();
 UPDATE public.personal_agent_cloud_removals SET completed_at=removed_at,
  archive=public.personal_agent_erasure_archive(r,history),
  released_identity=public.personal_agent_cloud_removal_identity(to_jsonb(agent),removed_at,attempt)
 WHERE user_id=owner_id AND attempt_id=attempt RETURNING * INTO op;
 IF public.personal_agent_erasure_archived(owner_id,r,history) IS NOT TRUE THEN
  RAISE EXCEPTION 'cloud removal archive unconfirmed' USING ERRCODE='42501'; END IF;
 DELETE FROM public.pod_lifecycle_events WHERE user_id=owner_id;
 DELETE FROM public.byoc_setup_jobs WHERE user_id=owner_id;
 DELETE FROM public.personal_agent_registry WHERE user_id=owner_id;
 replacement:=jsonb_populate_record(NULL::public.personal_agent_registry,op.released_identity);
 INSERT INTO public.personal_agent_registry SELECT replacement.*;
 RETURN true;
END;
$function$;

DROP FUNCTION public.retain_legacy_cloud_removal(text,text,text,jsonb,jsonb);
DROP FUNCTION public.legacy_cloud_removal_archive(jsonb,jsonb,jsonb);
DROP FUNCTION public.legacy_cloud_removal_complete(text,text);
DROP FUNCTION public.legacy_cloud_removal_append_valid(jsonb,jsonb,jsonb);
DROP FUNCTION public.legacy_cloud_removal_event_valid(jsonb,jsonb);
DROP FUNCTION public.legacy_cloud_removal_plan_valid(jsonb,jsonb);
ALTER TABLE public.personal_agent_cloud_removals DROP COLUMN recovery;
COMMIT;
