-- Dev-only: reviewed cloud removal preserves the person's application identity.
-- Resource execution and receipt validation remain owned by the erasure engine.
-- No account tombstone is created by this operation. Forward recovery only once
-- an operation has been admitted; reverting must not strand retained resources.
BEGIN;

CREATE TABLE public.personal_agent_cloud_removals (
 user_id text NOT NULL,
 attempt_id text NOT NULL,
 placement_epoch bigint NOT NULL CHECK (placement_epoch >= 0),
 snapshot_sha256 text NOT NULL CHECK (snapshot_sha256 ~ '^[0-9a-f]{64}$'),
 approved_digest text CHECK (approved_digest ~ '^[0-9a-f]{64}$'),
 approved_at timestamptz,
 completed_at timestamptz,
 archive jsonb,
 released_identity jsonb,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY (user_id,attempt_id),
 CHECK ((approved_digest IS NULL) = (approved_at IS NULL)),
 CHECK ((completed_at IS NULL) = (archive IS NULL)),
 CHECK ((completed_at IS NULL) = (released_identity IS NULL)),
 CHECK (archive IS NULL OR (jsonb_typeof(archive)='object' AND octet_length(archive::text)<=2097152))
);
ALTER TABLE public.personal_agent_cloud_removals ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE public.personal_agent_cloud_removals IS
 'Cloud-only owner approval and qualified resource-erasure proof. Deleted in the full account transaction; never authorizes account erasure or unrelated resource deletion.';

CREATE FUNCTION public.personal_agent_cloud_removal_review(r jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=public AS $$
DECLARE inventory jsonb; snapshot jsonb:=r->'registrySnapshot';
BEGIN
 IF jsonb_typeof(r) IS DISTINCT FROM 'object' OR r->>'ownerId' IS DISTINCT FROM snapshot->>'user_id'
 OR r->>'hushhId' IS DISTINCT FROM snapshot->>'hushh_id' THEN RETURN NULL; END IF;
 IF snapshot->>'deployment_target'='user_azure'
 OR public.azure_setup_never_deployed(r->>'ownerId',snapshot) IS TRUE THEN
  IF public.valid_azure_erasure_plan(r->>'ownerId',r->'azureTeardown'->'plan') IS NOT TRUE THEN RETURN NULL; END IF;
  RETURN r->'azureTeardown'->'plan';
 END IF;
 IF snapshot->>'deployment_target' IS DISTINCT FROM 'user_gcp' THEN RETURN NULL; END IF;
 inventory:=public.effective_erasure_substrate_inventory(r);
 IF jsonb_typeof(inventory) IS DISTINCT FROM 'object' THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('version',1,'purpose','remove_cloud_keep_account',
  'ownerId',r->>'ownerId','attemptId',r->>'attemptId','placementEpoch',snapshot->'placement_epoch',
  'project',snapshot->>'user_cloud_project','region',snapshot->>'user_cloud_region',
  'service',snapshot->>'external_agent_id','serviceUid',snapshot->'backend_metadata'->>'serviceUid',
  'inventory',inventory,'termsVersion','gcp-owned-resources-retention-v1');
END;
$$;

-- A fresh identity row contains no cloud credentials, endpoint or public pod key.
-- Keep only historical links; the completed archive owns the actual cleanup proof.
CREATE FUNCTION public.personal_agent_cloud_removal_identity(agent jsonb, removed_at timestamptz, attempt text)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=public AS $$
 SELECT jsonb_build_object('user_id',agent->'user_id','hushh_id',agent->'hushh_id',
  'phone_e164_hash',agent->'phone_e164_hash','space_id',agent->'space_id',
  'billing_space_id',agent->'billing_space_id','a2a_route',agent->'a2a_route',
  'identity_mode',agent->'identity_mode','placement_epoch',coalesce((agent->>'placement_epoch')::bigint,0)+1,
  'status','unprovisioned','health_state','unknown','liveness_mode',agent->'liveness_mode',
  'liveness_failures',0,'created_at',agent->'created_at','updated_at',to_jsonb(removed_at),
  'backend_metadata',jsonb_build_object('detachedPlacements',
   coalesce(agent->'backend_metadata'->'detachedPlacements','[]'::jsonb)
   || jsonb_build_array((agent->'backend_metadata'->'erasure'->'registrySnapshot')
    || jsonb_build_object('detachedAt',to_char(removed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
     'cloudRemovalAttempt',attempt))));
$$;

CREATE FUNCTION public.guard_personal_agent_cloud_removal()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
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
 IF TG_OP='INSERT' THEN
  IF NEW.approved_digest IS NOT NULL OR NEW.archive IS NOT NULL THEN
   RAISE EXCEPTION 'cloud removal approval required' USING ERRCODE='42501'; END IF;
  RETURN NEW;
 END IF;
 IF OLD.completed_at IS NOT NULL OR to_jsonb(NEW)-ARRAY['approved_digest','approved_at','completed_at','archive','released_identity']
  IS DISTINCT FROM to_jsonb(OLD)-ARRAY['approved_digest','approved_at','completed_at','archive','released_identity'] THEN
  RAISE EXCEPTION 'cloud removal evidence immutable' USING ERRCODE='42501'; END IF;
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
$$;
CREATE TRIGGER zz_personal_agent_cloud_removal BEFORE INSERT OR UPDATE OR DELETE ON public.personal_agent_cloud_removals
FOR EACH ROW EXECUTE FUNCTION public.guard_personal_agent_cloud_removal();
CREATE FUNCTION public.guard_personal_agent_cloud_removal_history()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
DECLARE r jsonb; prior_placement jsonb;
BEGIN
 IF NEW.completed_at IS NULL THEN RETURN NEW; END IF;
 SELECT backend_metadata->'erasure' INTO r FROM public.personal_agent_registry WHERE user_id=NEW.user_id;
 FOR prior_placement IN SELECT * FROM jsonb_array_elements(coalesce(r->'registrySnapshot'->'backend_metadata'->'detachedPlacements','[]'::jsonb)) LOOP
  IF public.personal_agent_cloud_removal_covers(NEW.user_id,prior_placement) IS NOT TRUE
   AND public.notification_erasure_custody_archived(NEW.user_id,r,prior_placement) IS NOT TRUE THEN
   RAISE EXCEPTION 'cloud removal prior placement requires review' USING ERRCODE='42501'; END IF;
 END LOOP;
 RETURN NEW;
END;
$$;
CREATE TRIGGER zz_personal_agent_cloud_removal_history AFTER INSERT OR UPDATE ON public.personal_agent_cloud_removals
FOR EACH ROW EXECUTE FUNCTION public.guard_personal_agent_cloud_removal_history();
DROP TRIGGER IF EXISTS trg_reject_deleted_account_insert ON public.personal_agent_cloud_removals;
CREATE TRIGGER trg_reject_deleted_account_insert BEFORE INSERT ON public.personal_agent_cloud_removals
FOR EACH ROW EXECUTE FUNCTION public.reject_deleted_account_identity_write('user_id');
DROP TRIGGER IF EXISTS trg_reject_deleted_account_reference_update ON public.personal_agent_cloud_removals;
CREATE TRIGGER trg_reject_deleted_account_reference_update BEFORE UPDATE OF user_id ON public.personal_agent_cloud_removals
FOR EACH ROW EXECUTE FUNCTION public.reject_deleted_account_identity_write('user_id');

CREATE FUNCTION public.personal_agent_cloud_removal_ready()
RETURNS boolean LANGUAGE sql STABLE SET search_path=public AS $$
 SELECT public.azure_account_cleanup_ready() IS TRUE
 AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_cloud_removals'::regclass
  AND tgname='zz_personal_agent_cloud_removal' AND tgtype=31 AND tgenabled IN ('O','A')
  AND tgfoid='public.guard_personal_agent_cloud_removal()'::regprocedure AND tgnargs=0 AND tgqual IS NULL)
 AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_cloud_removals'::regclass
  AND tgname='zz_personal_agent_cloud_removal_history' AND tgtype=21 AND tgenabled IN ('O','A')
  AND tgfoid='public.guard_personal_agent_cloud_removal_history()'::regprocedure AND tgnargs=0 AND tgqual IS NULL);
$$;

CREATE FUNCTION public.reserve_personal_agent_cloud_removal(owner_id text, expected_snapshot text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SET search_path=public AS $$
DECLARE agent public.personal_agent_registry%ROWTYPE; r jsonb; snapshot jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 SELECT * INTO agent FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 IF NOT FOUND OR public.personal_agent_cloud_removal_ready() IS NOT TRUE THEN RETURN NULL; END IF;
 snapshot:=coalesce(agent.backend_metadata->'erasure'->'registrySnapshot',to_jsonb(agent));
 IF expected_snapshot IS DISTINCT FROM encode(sha256(convert_to(snapshot::text,'UTF8')),'hex')
 OR snapshot->>'user_id' IS DISTINCT FROM owner_id
 OR EXISTS(SELECT 1 FROM public.personal_agent_standby_placements WHERE user_id=owner_id)
 OR EXISTS(SELECT 1 FROM public.pod_migration_jobs WHERE user_id=owner_id) THEN RETURN NULL; END IF;
 IF snapshot->>'deployment_target'='user_azure' OR public.azure_setup_never_deployed(owner_id,snapshot) IS TRUE THEN
  r:=public.reserve_azure_account_cleanup(owner_id,public.azure_cleanup_candidate_digest(snapshot));
 ELSIF snapshot->>'deployment_target'='user_gcp' THEN
  r:=public.reserve_personal_agent_erasure(owner_id,replace(gen_random_uuid()::text,'-',''));
 ELSE RETURN NULL;
 END IF;
 IF r IS NULL THEN RETURN NULL; END IF;
 INSERT INTO public.personal_agent_cloud_removals(user_id,attempt_id,placement_epoch,snapshot_sha256)
 VALUES(owner_id,r->>'attemptId',agent.placement_epoch,expected_snapshot) ON CONFLICT DO NOTHING;
 RETURN r;
END;
$$;

CREATE FUNCTION public.approve_personal_agent_cloud_removal(owner_id text, attempt text, expected_digest text, confirmation text)
RETURNS boolean LANGUAGE plpgsql VOLATILE SET search_path=public AS $$
DECLARE agent public.personal_agent_registry%ROWTYPE; r jsonb; review jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 SELECT * INTO agent FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 r:=agent.backend_metadata->'erasure'; review:=public.personal_agent_cloud_removal_review(r);
 IF review IS NULL OR r->>'attemptId' IS DISTINCT FROM attempt
 OR NOT EXISTS(SELECT 1 FROM public.personal_agent_cloud_removals WHERE user_id=owner_id AND attempt_id=attempt AND completed_at IS NULL)
 OR expected_digest IS DISTINCT FROM encode(sha256(convert_to(review::text,'UTF8')),'hex') THEN RETURN false; END IF;
 IF review->'context'->>'subscriptionId' IS NOT NULL THEN
  IF public.approve_azure_erasure_plan(owner_id,attempt,expected_digest,confirmation) IS NULL THEN RETURN false; END IF;
 ELSIF confirmation IS DISTINCT FROM review->>'project' THEN RETURN false;
 END IF;
 UPDATE public.personal_agent_cloud_removals SET approved_digest=expected_digest,approved_at=clock_timestamp()
 WHERE user_id=owner_id AND attempt_id=attempt AND completed_at IS NULL;
 RETURN FOUND;
END;
$$;

CREATE FUNCTION public.personal_agent_cloud_removal_execute_ready(owner_id text, attempt text)
RETURNS boolean LANGUAGE sql STABLE SET search_path=public AS $$
 SELECT public.personal_agent_cloud_removal_ready() IS TRUE AND EXISTS(
  SELECT 1 FROM public.personal_agent_cloud_removals c JOIN public.personal_agent_registry p ON p.user_id=c.user_id
  WHERE c.user_id=owner_id AND c.attempt_id=attempt AND c.completed_at IS NULL
  AND p.status='suspended' AND p.backend_metadata->'erasure'->>'attemptId'=attempt
  AND p.backend_metadata->'erasure'->>'ownerId'=owner_id AND p.placement_epoch=c.placement_epoch
  AND c.snapshot_sha256=encode(sha256(convert_to((p.backend_metadata->'erasure'->'registrySnapshot')::text,'UTF8')),'hex')
  AND c.approved_digest=encode(sha256(convert_to(public.personal_agent_cloud_removal_review(p.backend_metadata->'erasure')::text,'UTF8')),'hex')
  AND c.approved_at>clock_timestamp()-interval '10 minutes');
$$;

-- A legacy account-cleanup grant never supplies the new cloud-only purpose.
CREATE FUNCTION public.azure_cleanup_cloud_purpose_authorized(owner_id text, attempt text)
RETURNS boolean LANGUAGE sql STABLE SET search_path=public AS $$
 SELECT NOT EXISTS(SELECT 1 FROM public.personal_agent_cloud_removals WHERE user_id=owner_id AND attempt_id=attempt)
 OR public.personal_agent_cloud_removal_execute_ready(owner_id,attempt) IS TRUE;
$$;

CREATE OR REPLACE FUNCTION public.personal_agent_erasure_archived(owner_id text,r jsonb,history jsonb DEFAULT NULL)
RETURNS boolean LANGUAGE sql STABLE SET search_path=public AS $$
 SELECT jsonb_typeof(r)='object' AND r->>'ownerId'=owner_id AND coalesce(r->>'attemptId','')<>''
 AND (
  (EXISTS(SELECT 1 FROM public.personal_agent_deletion_tombstones t WHERE t.status='erasure_completed'
    AND t.metadata->>'ownerId'=owner_id AND t.hushh_id=r->>'hushhId' AND t.metadata->>'attemptId'=r->>'attemptId'
    AND t.metadata->>'reservationSha256'=encode(sha256(convert_to(r::text,'UTF8')),'hex')
    AND (history IS NULL OR t.metadata->>'authorizationHistorySha256'=encode(sha256(convert_to(history::text,'UTF8')),'hex')))
   AND EXISTS(SELECT 1 FROM public.account_deletion_tombstones WHERE cleanup_intent_kind='full_account'
    AND user_id_hash='sha256:'||encode(sha256(convert_to(owner_id,'UTF8')),'hex')))
  OR (public.personal_agent_cloud_removal_ready() IS TRUE AND EXISTS(
   SELECT 1 FROM public.personal_agent_cloud_removals c WHERE c.user_id=owner_id AND c.attempt_id=r->>'attemptId'
    AND c.completed_at IS NOT NULL AND c.archive->>'hushhId'=r->>'hushhId'
    AND c.snapshot_sha256=encode(sha256(convert_to((r->'registrySnapshot')::text,'UTF8')),'hex')
    AND c.placement_epoch=(r->'registrySnapshot'->>'placement_epoch')::bigint
    AND c.archive->>'reservationSha256'=encode(sha256(convert_to(r::text,'UTF8')),'hex')
    AND (history IS NULL OR c.archive->>'authorizationHistorySha256'=encode(sha256(convert_to(history::text,'UTF8')),'hex')))))
 AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_deletion_tombstones'::regclass
  AND tgname='zz_personal_agent_erasure_archive' AND tgtype=31 AND tgenabled IN ('O','A')
  AND tgfoid='public.guard_personal_agent_erasure_archive()'::regprocedure AND tgnargs=0 AND tgqual IS NULL);
$$;

CREATE FUNCTION public.personal_agent_cloud_removal_covers(owner_id text, placement jsonb)
RETURNS boolean LANGUAGE sql STABLE SET search_path=public AS $$
 SELECT public.personal_agent_cloud_removal_ready() IS TRUE AND placement->>'user_id'=owner_id
 AND EXISTS(SELECT 1 FROM public.personal_agent_cloud_removals c WHERE c.user_id=owner_id
  AND c.attempt_id=placement->>'cloudRemovalAttempt' AND c.completed_at IS NOT NULL
  AND c.archive->>'hushhId'=placement->>'hushh_id'
  AND c.snapshot_sha256=encode(sha256(convert_to((placement-ARRAY['detachedAt','cloudRemovalAttempt'])::text,'UTF8')),'hex'));
$$;

-- Terminal replay must also respect choices stored outside the registry.
-- This is a response fence, separate from proof that old cloud resources are gone.
CREATE FUNCTION public.personal_agent_cloud_removal_replay_current(owner_id text, attempt text)
RETURNS boolean LANGUAGE sql STABLE SET search_path=public AS $$
 SELECT public.personal_agent_cloud_removal_ready() IS TRUE AND EXISTS(
  SELECT 1 FROM public.personal_agent_cloud_removals c JOIN public.personal_agent_registry p ON p.user_id=c.user_id
  WHERE c.user_id=owner_id AND c.attempt_id=attempt AND c.completed_at IS NOT NULL AND p.status='unprovisioned'
  AND to_jsonb(p)-'updated_at'=to_jsonb(jsonb_populate_record(NULL::public.personal_agent_registry,c.released_identity))-'updated_at'
  AND NOT EXISTS(SELECT 1 FROM public.byoc_setup_jobs WHERE user_id=owner_id)
  AND NOT EXISTS(SELECT 1 FROM public.pod_migration_jobs WHERE user_id=owner_id)
  AND NOT EXISTS(SELECT 1 FROM public.personal_agent_standby_placements WHERE user_id=owner_id)
  AND NOT EXISTS(SELECT 1 FROM public.vault_keys v WHERE v.user_id=owner_id
   AND to_jsonb(v)->>'one_hosting_choice'='shared'
   AND (to_jsonb(v)->>'one_hosting_choice_at')::timestamptz >= date_trunc('second',c.completed_at)));
$$;

CREATE FUNCTION public.finalize_personal_agent_cloud_removal(owner_id text, attempt text, expected_digest text)
RETURNS boolean LANGUAGE plpgsql VOLATILE SET search_path=public AS $$
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
$$;

CREATE FUNCTION public.personal_agent_cloud_removed(owner_id text)
RETURNS boolean LANGUAGE sql STABLE SET search_path=public AS $$
 SELECT public.personal_agent_cloud_removal_ready() IS TRUE AND EXISTS(
  SELECT 1 FROM public.personal_agent_cloud_removals c JOIN public.personal_agent_registry p ON p.user_id=c.user_id
  WHERE c.user_id=owner_id AND c.completed_at IS NOT NULL AND p.status='unprovisioned'
  AND to_jsonb(p)-'updated_at' = to_jsonb(jsonb_populate_record(NULL::public.personal_agent_registry,c.released_identity))-'updated_at');
$$;
COMMIT;
