-- Refuse rollback once a quota obligation or receipt exists; use forward recovery.
BEGIN;
LOCK TABLE public.personal_agent_registry, public.personal_agent_standby_placements,
 public.byoc_setup_jobs, public.personal_agent_deletion_tombstones IN SHARE ROW EXCLUSIVE MODE;
DO $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.personal_agent_registry WHERE
  (backend_metadata ? 'provisionAttempt' AND backend_metadata->'provisionAttempt'->>'phase' IS DISTINCT FROM 'provisioned')
  OR jsonb_path_exists(backend_metadata,'$.** ? (@.role == "roles/serviceusage.serviceUsageConsumer" || @.step == "iam_pod_sa_quota")')
  OR jsonb_path_exists(backend_metadata,'$.**.runtimeGrantErasure.quota'))
 OR EXISTS(SELECT 1 FROM public.personal_agent_standby_placements WHERE
  jsonb_path_exists(backend_metadata,'$.** ? (@.role == "roles/serviceusage.serviceUsageConsumer" || @.step == "iam_pod_sa_quota")')
  OR jsonb_path_exists(backend_metadata,'$.**.runtimeGrantErasure.quota'))
 OR EXISTS(SELECT 1 FROM public.byoc_setup_jobs WHERE
  jsonb_path_exists(to_jsonb(byoc_setup_jobs),'$.** ? (@.role == "roles/serviceusage.serviceUsageConsumer" || @.step == "iam_pod_sa_quota")'))
 OR EXISTS(SELECT 1 FROM public.personal_agent_deletion_tombstones WHERE
  jsonb_path_exists(to_jsonb(personal_agent_deletion_tombstones),'$.**.runtimeQuotaGrantDeletion'))
 THEN RAISE EXCEPTION 'Runtime quota grant custody requires forward recovery'; END IF;
END $$;
CREATE OR REPLACE FUNCTION public.valid_erasure_runtime_grant_receipt(r jsonb, stage text, receipt jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $$
DECLARE binding jsonb; identity jsonb; admitted jsonb;
BEGIN
 IF stage IS NULL OR stage NOT IN ('admission','acknowledgement','deletion') OR jsonb_typeof(receipt) IS DISTINCT FROM 'object'
 OR public.valid_erasure_grant_release(r,r->'grantRelease') IS DISTINCT FROM true THEN RETURN false; END IF;
 identity:=r->'writerDisabled'->'runtimeIdentity'; binding:=receipt->'bindingObservation';
 IF receipt - ARRAY['ownerId','attemptId','runtimeIdentity','bindingObservation','status']<>'{}'::jsonb
 OR receipt->>'ownerId' IS DISTINCT FROM r->>'ownerId' OR receipt->>'attemptId' IS DISTINCT FROM r->>'attemptId'
 OR receipt->'runtimeIdentity' IS DISTINCT FROM identity OR jsonb_typeof(binding) IS DISTINCT FROM 'object'
 OR binding - ARRAY['step','policyResource','role','member','disposition','beforeEtag','afterEtag']<>'{}'::jsonb
 OR binding->>'step' IS DISTINCT FROM 'iam_pod_sa_vertex' OR binding->>'role' IS DISTINCT FROM 'roles/aiplatform.user'
 OR binding->>'disposition' IS DISTINCT FROM 'added'
 OR binding->>'member' IS DISTINCT FROM 'serviceAccount:'||(identity->>'email')
 OR binding->>'policyResource' IS DISTINCT FROM 'https://cloudresourcemanager.googleapis.com/v1/projects/'||(r->'grantRelease'->>'project')||':getIamPolicy'
 OR coalesce(length(binding->>'beforeEtag'),0) NOT BETWEEN 1 AND 512 OR coalesce(length(binding->>'afterEtag'),0) NOT BETWEEN 1 AND 512
 OR (SELECT count(*) FROM jsonb_array_elements(r->'substrateInventory'->'bindingObservations') b WHERE b=binding)<>1 THEN RETURN false; END IF;
 IF stage='admission' THEN RETURN receipt->>'status'='admitted'; END IF;
 admitted:=r->'runtimeGrantErasure'->'admission';
 IF public.valid_erasure_runtime_grant_receipt(r,'admission',admitted) IS DISTINCT FROM true OR receipt - 'status' IS DISTINCT FROM admitted - 'status' THEN RETURN false; END IF;
 IF stage='acknowledgement' THEN RETURN receipt->>'status'='acknowledged'; END IF;
 -- Fresh observed absence may reconcile a lost write acknowledgement; never fabricate it.
 RETURN receipt->>'status'='observed_absent';
END;
$$;

CREATE OR REPLACE FUNCTION public.valid_erasure_runtime_grant_append(old_r jsonb,new_r jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $$
DECLARE old_s jsonb; new_s jsonb; stage text;
BEGIN
 old_s:=coalesce(old_r->'runtimeGrantErasure','{}'::jsonb); new_s:=new_r->'runtimeGrantErasure';
 IF new_r - 'runtimeGrantErasure' IS DISTINCT FROM old_r - 'runtimeGrantErasure' OR jsonb_typeof(new_s) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 FOREACH stage IN ARRAY ARRAY['admission','acknowledgement','deletion'] LOOP
  IF NOT (old_s ? stage) AND new_s - stage=old_s AND public.valid_erasure_runtime_grant_receipt(old_r,stage,new_s->stage) IS TRUE THEN RETURN true; END IF;
 END LOOP;
 RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.retain_erasure_runtime_grant_receipt(owner_id text, attempt_id text, expected jsonb, stage text, receipt jsonb)
RETURNS boolean LANGUAGE plpgsql SET search_path=public AS $$
DECLARE current_row public.personal_agent_registry%ROWTYPE; r jsonb; s jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 SELECT * INTO current_row FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 IF NOT FOUND OR current_row.status IS DISTINCT FROM 'suspended' THEN RETURN false; END IF;
 r:=current_row.backend_metadata->'erasure';
 IF r->>'ownerId' IS DISTINCT FROM owner_id OR r->>'attemptId' IS DISTINCT FROM attempt_id
 OR public.valid_erasure_runtime_grant_receipt(r,stage,receipt) IS DISTINCT FROM true THEN RETURN false; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_registry'::regclass
 AND tgname='zz_personal_agent_erasure_registry' AND tgenabled IN ('O','A') AND tgtype=27 AND tgnargs=0 AND tgqual IS NULL
 AND tgfoid='public.guard_personal_agent_erasure_registry()'::regprocedure) THEN RETURN false; END IF;
 IF public.project_grant_release_is_exclusive(owner_id,r->'grantRelease'->>'project') IS DISTINCT FROM true THEN RETURN false; END IF;
 s:=coalesce(r->'runtimeGrantErasure','{}'::jsonb);
 IF s ? stage THEN RETURN stage <> 'admission' AND s->stage=receipt; END IF;
 IF r IS DISTINCT FROM expected THEN RETURN false; END IF;
 UPDATE public.personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata,ARRAY['erasure','runtimeGrantErasure'],s || jsonb_build_object(stage,receipt),true) WHERE user_id=owner_id;
 RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.valid_erasure_repository_grant_receipt(r jsonb, stage text, receipt jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $$
DECLARE binding jsonb; identity jsonb; admitted jsonb;
BEGIN
 IF stage IS NULL OR stage NOT IN ('admission','acknowledgement','deletion') OR jsonb_typeof(receipt) IS DISTINCT FROM 'object'
 OR public.valid_erasure_grant_release(r,r->'grantRelease') IS DISTINCT FROM true THEN RETURN false; END IF;
 IF public.valid_erasure_runtime_grant_receipt(r,'deletion',r->'runtimeGrantErasure'->'deletion') IS DISTINCT FROM true THEN RETURN false; END IF;
 identity:=receipt->'repositoryIdentity'; binding:=receipt->'bindingObservation';
 IF jsonb_typeof(identity) IS DISTINCT FROM 'object'
 OR identity - ARRAY['name','format','createTime']<>'{}'::jsonb
 OR identity->>'name' IS DISTINCT FROM 'projects/'||(r->'grantRelease'->>'project')||'/locations/'||(r->'registrySnapshot'->>'user_cloud_region')||'/repositories/one-pod'
 OR identity->>'format' IS DISTINCT FROM 'DOCKER'
 OR (identity->>'createTime' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$') IS DISTINCT FROM true
 OR (SELECT count(*) FROM jsonb_array_elements(r->'substrateInventory'->'plannedResources') p WHERE p->>'type'='artifact_repository' AND p->>'id'='one-pod')<>1
 OR (SELECT count(*) FROM jsonb_array_elements(r->'substrateInventory'->'resourceObservations') o WHERE o=jsonb_build_object('type','artifact_repository','id','one-pod','disposition','created','identity',identity))<>1 THEN RETURN false; END IF;
 IF receipt - ARRAY['ownerId','attemptId','repositoryIdentity','bindingObservation','status']<>'{}'::jsonb
 OR receipt->>'ownerId' IS DISTINCT FROM r->>'ownerId' OR receipt->>'attemptId' IS DISTINCT FROM r->>'attemptId'
 OR receipt->'repositoryIdentity' IS DISTINCT FROM identity OR jsonb_typeof(binding) IS DISTINCT FROM 'object'
 OR binding - ARRAY['step','policyResource','role','member','disposition','beforeEtag','afterEtag']<>'{}'::jsonb
 OR binding->>'step' IS DISTINCT FROM 'artifact_repo_grant_copy_writer' OR binding->>'role' IS DISTINCT FROM 'roles/artifactregistry.writer'
 OR binding->>'disposition' IS DISTINCT FROM 'added'
 OR (binding->>'member' ~ '^serviceAccount:[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.gserviceaccount\.com$') IS DISTINCT FROM true
 OR binding->>'policyResource' IS DISTINCT FROM 'https://artifactregistry.googleapis.com/v1/'||(identity->>'name')||':getIamPolicy'
 OR coalesce(length(binding->>'beforeEtag'),0) NOT BETWEEN 1 AND 512 OR coalesce(length(binding->>'afterEtag'),0) NOT BETWEEN 1 AND 512
 OR (SELECT count(*) FROM jsonb_array_elements(r->'substrateInventory'->'bindingObservations') b WHERE b=binding)<>1 THEN RETURN false; END IF;
 IF stage='admission' THEN RETURN receipt->>'status'='admitted'; END IF;
 admitted:=r->'repositoryGrantErasure'->'admission';
 IF public.valid_erasure_repository_grant_receipt(r,'admission',admitted) IS DISTINCT FROM true OR receipt - 'status' IS DISTINCT FROM admitted - 'status' THEN RETURN false; END IF;
 IF stage='acknowledgement' THEN RETURN receipt->>'status'='acknowledged'; END IF;
 -- Fresh observed absence may reconcile a lost write acknowledgement; never fabricate it.
 RETURN receipt->>'status'='observed_absent';
END;
$$;

CREATE OR REPLACE FUNCTION public.personal_agent_erasure_archive(r jsonb, history jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=public AS $$
 SELECT jsonb_build_object(
  'version',1,'ownerId',r->>'ownerId','hushhId',r->>'hushhId','attemptId',r->>'attemptId',
  'project',r->'registrySnapshot'->>'user_cloud_project',
  'reservationSha256',encode(sha256(convert_to(r::text,'UTF8')),'hex'),
  'authorizationHistorySha256',encode(sha256(convert_to(history::text,'UTF8')),'hex'),
  'receipts',jsonb_build_object(
   'memoryDeletion',r->'memoryDeletion','computeDeletion',r->'computeDeletion',
   'writerDisabled',r->'writerDisabled','bucketDeletion',r->'bucketDeletion',
   'mailDeletion',jsonb_build_object(
    'cloud_scheduler_job',r->'mailErasure'->'cloud_scheduler_job'->'deletion',
    'pubsub_subscription',r->'mailErasure'->'pubsub_subscription'->'deletion',
    'pubsub_topic',r->'mailErasure'->'pubsub_topic'->'deletion') ||
    -- 956: preserve every independent resource's qualified stages in the archive.
    CASE WHEN EXISTS(SELECT 1 FROM jsonb_each(coalesce(r->'mailErasure','{}'::jsonb)) x WHERE x.value ? 'resources')
     THEN jsonb_build_object('resourcesByKind',r->'mailErasure') ELSE '{}'::jsonb END,
   'kmsCompletion',r->'kmsErasure'->'completion','secretDeletion',r->'secretErasure'->'deletion',
   'accountDeletion',r->'accountErasure'->'deletion',
   'runtimeGrantDeletion',r->'runtimeGrantErasure'->'deletion',
   'repositoryGrantDeletion',r->'repositoryGrantErasure'->'deletion',
   'repositoryRetention',r->'repositoryRetention',
   'bootstrapGrantRelease',r->'bootstrapGrantRelease',
   'bootstrapGrantErasure',r->'bootstrapGrantErasure') ||
   CASE WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(r->'substrateInventory'->'plannedResources') x WHERE x->>'type'='cloud_tasks_queue')
    THEN jsonb_build_object('filesErasure',r->'filesErasure') ELSE '{}'::jsonb END
   -- 954: keep the person's never-hosted receipt; absent (no key) on every hosted archive.
   || jsonb_strip_nulls(jsonb_build_object('neverHosted',r->'neverHosted'))
   || CASE WHEN jsonb_typeof(r->'azureTeardown')='object'
      THEN jsonb_build_object('azureCleanup',r->'azureTeardown',
       'agentCryptoErase',r->'agentCryptoErase','ownerAccessErasure',r->'ownerAccessErasure') ELSE '{}'::jsonb END
   || CASE WHEN jsonb_array_length(coalesce(r->'substrateInventory'->'operatorBindingObservations','[]'::jsonb))>0
    THEN jsonb_build_object('operatorNotificationCustody',jsonb_build_object(
     'bindings',r->'substrateInventory'->'operatorBindingObservations',
     'topics',(SELECT coalesce(jsonb_agg(x),'[]'::jsonb)
      FROM jsonb_array_elements(r->'substrateInventory'->'resourceObservations') x
      WHERE x->>'type'='pubsub_topic' AND starts_with(x->>'id','projects/'))))
    ELSE '{}'::jsonb END);
$$;
DROP FUNCTION public.erasure_runtime_grants_complete(jsonb);
COMMIT;
