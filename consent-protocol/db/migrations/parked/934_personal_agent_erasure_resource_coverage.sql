-- Dev-only: preserve recovery access until every planned resource has a disposition.
BEGIN;
CREATE OR REPLACE FUNCTION public.erasure_planned_resources_covered(r jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $$
DECLARE planned jsonb:=r->'substrateInventory'->'plannedResources'; item jsonb; receipt jsonb;
 kind text; captured_id text; wanted_status text;
BEGIN
 -- Coverage supplements existing immutable receipt validation; it never grants deletion authority.
 IF jsonb_typeof(planned) IS DISTINCT FROM 'array' OR jsonb_array_length(planned) NOT BETWEEN 1 AND 1024
 OR (SELECT count(*)<>count(DISTINCT x) FROM jsonb_array_elements(planned) x) THEN RETURN false; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(planned) LOOP
  IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR item-ARRAY['type','id']<>'{}'::jsonb
   OR jsonb_typeof(item->'id') IS DISTINCT FROM 'string' OR length(item->>'id')=0 THEN RETURN false; END IF;
  kind:=item->>'type'; receipt:=NULL; captured_id:=NULL; wanted_status:=NULL;
  CASE kind
   WHEN 'cloud_run_service' THEN
    receipt:=r->'computeDeletion'; captured_id:=split_part(receipt->>'serviceName','/',6); wanted_status:='compute_deleted';
   WHEN 'gcs_bucket' THEN
    receipt:=r->'bucketDeletion'; captured_id:=receipt->'bucketIdentity'->>'name'; wanted_status:='deleted';
   WHEN 'service_account' THEN
    receipt:=r->'accountErasure'->'deletion'; captured_id:=receipt->'resourceObservation'->>'id'; wanted_status:='absent';
   WHEN 'kms_key' THEN
    receipt:=r->'kmsErasure'->'completion'; captured_id:=receipt->'resourceObservation'->>'id'; wanted_status:='destroyed';
   WHEN 'secret' THEN
    receipt:=r->'secretErasure'->'deletion'; captured_id:=receipt->'resourceObservation'->>'id'; wanted_status:='absent';
   WHEN 'artifact_repository' THEN
    receipt:=r->'repositoryRetention'; captured_id:=split_part(receipt->'repositoryIdentity'->>'name','/',6);
    IF receipt->>'disposition' IS DISTINCT FROM 'retained_shared' THEN RETURN false; END IF;
   WHEN 'cloud_scheduler_job','pubsub_subscription','pubsub_topic' THEN
    receipt:=r->'mailErasure'->kind->'deletion'; captured_id:=receipt->'resourceObservation'->>'id'; wanted_status:='absent';
   ELSE RETURN false;
  END CASE;
  IF captured_id IS DISTINCT FROM item->>'id' OR jsonb_typeof(receipt) IS DISTINCT FROM 'object'
   OR (wanted_status IS NOT NULL AND receipt->>'status' IS DISTINCT FROM wanted_status) THEN RETURN false; END IF;
  -- Compute receipts are bound through the existing compute admission contract.
  IF kind<>'cloud_run_service' AND (receipt->>'ownerId' IS DISTINCT FROM r->>'ownerId'
   OR receipt->>'attemptId' IS DISTINCT FROM r->>'attemptId') THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END;
$$;
CREATE OR REPLACE FUNCTION public.expected_erasure_bootstrap_release(owner_id text,r jsonb,recovery_member text)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=public AS $$
DECLARE history jsonb; job record; identity jsonb; binding jsonb; groups jsonb:='{}'::jsonb;
 g jsonb; k text; target_project text; recovery_key text; n integer:=0;
BEGIN
 IF public.erasure_planned_resources_covered(r) IS DISTINCT FROM true THEN RETURN NULL; END IF;
 IF public.valid_erasure_repository_retention(r,r->'repositoryRetention') IS DISTINCT FROM true THEN RETURN NULL; END IF;
 target_project:=r->'registrySnapshot'->>'user_cloud_project';
 SELECT authorization_attempts INTO history FROM public.byoc_setup_jobs WHERE user_id=owner_id;
 IF jsonb_typeof(history) IS DISTINCT FROM 'object' THEN RETURN NULL; END IF;
 FOR job IN SELECT key,value FROM jsonb_each(history) ORDER BY key LOOP
  IF job.value->'intent'->>'project' IS DISTINCT FROM target_project THEN CONTINUE; END IF;
  n:=n+1;
  IF n>1024 OR job.value->'intent'->>'ownerId' IS DISTINCT FROM owner_id
   OR job.value->'intent'->>'jobId' IS DISTINCT FROM job.key OR NOT (job.value ? 'receipt') THEN RETURN NULL; END IF;
  identity:=job.value->'receipt'->'bootstrapIdentity'; binding:=job.value->'receipt'->'bindingObservation';
  IF identity->>'projectId' IS DISTINCT FROM target_project OR binding->>'role' IS DISTINCT FROM 'roles/iam.serviceAccountTokenCreator'
   OR binding->>'member' IS DISTINCT FROM 'serviceAccount:'||(job.value->'intent'->>'callerEmail')
   OR (binding->>'disposition' IN ('added','already_present')) IS DISTINCT FROM true THEN RETURN NULL; END IF;
  k:=(identity->>'uniqueId')||'|'||(binding->>'member');
  IF k IS NULL THEN RETURN NULL; END IF;
  g:=groups->k;
  IF g IS NULL THEN g:=jsonb_build_object('jobIds','[]'::jsonb,'bootstrapIdentity',identity,'bindingObservation',NULL); END IF;
  IF g->'bootstrapIdentity' IS DISTINCT FROM identity THEN RETURN NULL; END IF;
  g:=jsonb_set(g,'{jobIds}',(g->'jobIds')||jsonb_build_array(job.key));
  IF binding->>'disposition'='added' AND g->'bindingObservation'='null'::jsonb THEN g:=jsonb_set(g,'{bindingObservation}',binding); END IF;
  groups:=jsonb_set(groups,ARRAY[k],g,true);
  IF binding->>'member'=recovery_member AND identity->>'email'=regexp_replace(r->'registrySnapshot'->>'user_cloud_bootstrap_sa','^serviceAccount:','') THEN
   IF recovery_key IS NOT NULL AND recovery_key<>k THEN RETURN NULL; END IF;
   recovery_key:=k;
  END IF;
 END LOOP;
 IF n=0 OR recovery_key IS NULL THEN RETURN NULL; END IF;
 FOR g IN SELECT value FROM jsonb_each(groups) LOOP
  IF g->'bindingObservation'='null'::jsonb THEN RETURN NULL; END IF;
 END LOOP;
 RETURN jsonb_build_object('ownerId',owner_id,'attemptId',r->>'attemptId','project',target_project,
  'groups',groups,'recoveryMember',recovery_member,'recoveryGrantKey',recovery_key,'status','reserved');
END;
$$;

COMMIT;
