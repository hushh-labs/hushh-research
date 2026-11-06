-- Dev-only forward recovery on the existing owner-approved removal journal.
-- Original registry snapshots, approvals, dispatches and modern erasure remain unchanged.
BEGIN;
ALTER TABLE public.personal_agent_cloud_removals ADD COLUMN recovery jsonb;
ALTER TABLE public.personal_agent_cloud_removals ADD CONSTRAINT cloud_removal_recovery_bounded
 CHECK (recovery IS NULL OR jsonb_typeof(recovery)='object' AND octet_length(recovery::text)<=2097152);

CREATE FUNCTION public.legacy_cloud_removal_plan_valid(r jsonb,p jsonb)
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=public AS $$
DECLARE s jsonb:=r->'registrySnapshot'; m jsonb:=s->'backend_metadata'; inventory jsonb;
 project text:=s->>'user_cloud_project'; item jsonb; original jsonb; count_items integer;
BEGIN
 IF jsonb_typeof(p) IS DISTINCT FROM 'object'
 OR p-ARRAY['version','controlProject','ownerId','accountGeneration','attemptId','placementEpoch','snapshotSha256','project','runtime','memory','resources','sourceRevision','actor','observedAt','termsVersion']<>'{}'::jsonb
 OR p->'version' IS DISTINCT FROM '1'::jsonb OR p->>'controlProject' IS DISTINCT FROM 'hushh-pda-dev'
 OR p->>'termsVersion' IS DISTINCT FROM 'gcp-legacy-native-removal-v1'
 OR p->'accountGeneration' IS DISTINCT FROM '0'::jsonb
 OR r-ARRAY['version','ownerId','hushhId','attemptId','phase','registrySnapshot']<>'{}'::jsonb
 OR r->'version' IS DISTINCT FROM '1'::jsonb OR r->>'phase' IS DISTINCT FROM 'reserved'
 OR s->>'status' IS DISTINCT FROM 'provisioned' OR s->>'deployment_target' IS DISTINCT FROM 'user_gcp'
 OR s->>'backend' IS DISTINCT FROM 'user_gcp' OR s->>'user_id' IS DISTINCT FROM r->>'ownerId'
 OR s->>'hushh_id' IS DISTINCT FROM r->>'hushhId' OR m ? 'upgradeLease'
 OR p->>'ownerId' IS DISTINCT FROM r->>'ownerId' OR p->>'attemptId' IS DISTINCT FROM r->>'attemptId'
 OR p->'placementEpoch' IS DISTINCT FROM coalesce(s->'placement_epoch','0'::jsonb)
 OR p->>'snapshotSha256' IS DISTINCT FROM encode(sha256(convert_to(s::text,'UTF8')),'hex')
 OR coalesce(p->>'sourceRevision','') !~ '^[0-9a-f]{40}$'
 OR coalesce(project,'') !~ '^[a-z][a-z0-9-]{4,61}[a-z0-9]$'
 OR project IN ('hushh-pda-dev','hushh-pda-uat','hushh-pda','hushh-gemini-bridge')
 OR p->'project'->>'projectId' IS DISTINCT FROM project
 OR coalesce(p->'project'->>'projectNumber','') !~ '^[1-9][0-9]{5,20}$'
 OR p->'runtime'->>'serviceUid' IS DISTINCT FROM m->>'serviceUid'
 OR p->'runtime'->>'serviceName' IS DISTINCT FROM 'projects/'||project||'/locations/'||(s->>'user_cloud_region')||'/services/'||(s->>'external_agent_id')
 OR p->'runtime'->>'image' IS DISTINCT FROM m->>'image'
 OR coalesce(p->'runtime'->>'generation','') !~ '^[1-9][0-9]*$'
 OR coalesce(p->'runtime'->>'etag','')=''
 OR NOT starts_with(coalesce(p->'runtime'->>'revision',''),(s->>'external_agent_id')||'-')
 OR p->'runtime'->'principal'->>'projectId' IS DISTINCT FROM project
 OR p->'runtime'->'principal'->>'email' IS DISTINCT FROM m->>'runtime_service_account'
 OR p->'runtime'->'principal'->>'email' IS NOT DISTINCT FROM s->>'user_cloud_bootstrap_sa'
 OR coalesce(p->'runtime'->'principal'->>'uniqueId','') !~ '^[0-9]{6,30}$'
 OR coalesce(p->'memory'->>'generation','') !~ '^[1-9][0-9]*$'
 OR coalesce(p->'memory'->>'sha256','') !~ '^[0-9a-f]{64}$'
 OR coalesce(p->'memory'->>'engineName','') !~ ('^projects/'||project||'/locations/[a-z0-9-]+/reasoningEngines/[A-Za-z0-9_-]+$')
 OR coalesce(p->'memory'->>'engineCreateTime','')=''
 OR coalesce(p->>'actor','')='' OR coalesce(p->>'observedAt','')=''
 OR jsonb_typeof(p->'resources') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 IF jsonb_typeof(p->'project') IS DISTINCT FROM 'object'
 OR (p->'project')-ARRAY['projectId','projectNumber','createTime']<>'{}'::jsonb
 OR coalesce(p->'project'->>'createTime','')=''
 OR jsonb_typeof(p->'runtime') IS DISTINCT FROM 'object'
 OR (p->'runtime')-ARRAY['serviceName','serviceUid','revision','image','generation','etag','principal']<>'{}'::jsonb
 OR jsonb_typeof(p->'memory') IS DISTINCT FROM 'object'
 OR (p->'memory')-ARRAY['bucket','object','generation','sha256','engineName','engineCreateTime']<>'{}'::jsonb
 OR regexp_replace(coalesce(p->'memory'->>'object',''),'^.*/','')<>'memory_bank.json'
 THEN RETURN false; END IF;
 IF jsonb_array_length(p->'resources') NOT BETWEEN 1 AND 128 THEN RETURN false; END IF;
 inventory:=public.effective_erasure_substrate_inventory(r);
 IF jsonb_typeof(inventory) IS DISTINCT FROM 'object' OR jsonb_typeof(inventory->'plannedResources') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(p->'resources') LOOP
  IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR item-ARRAY['type','id','identity','authority']<>'{}'::jsonb
  OR coalesce(item->>'type','') NOT IN ('cloud_run_service','service_account','gcs_bucket','kms_key','secret','artifact_repository','pubsub_topic','pubsub_subscription','cloud_scheduler_job','cloud_tasks_queue','reasoning_engine','project_iam_policy','bootstrap_access')
  OR coalesce(item->>'id','')='' OR jsonb_typeof(item->'identity') IS DISTINCT FROM 'object'
  OR coalesce(item->>'authority','') NOT IN ('owner_reviewed','observe_only','retain_shared')
  OR (item->>'authority'='retain_shared' AND item->>'type'<>'artifact_repository')
  OR (starts_with(item->>'id','projects/') AND split_part(item->>'id','/',2)<>project AND item->>'authority'<>'observe_only') THEN RETURN false; END IF;
  SELECT count(*) INTO count_items FROM jsonb_array_elements(p->'resources') x WHERE x->>'type'=item->>'type' AND x->>'id'=item->>'id';
  IF count_items<>1 THEN RETURN false; END IF;
  IF item->>'type'='reasoning_engine' THEN
   IF item->>'id' IS DISTINCT FROM p->'memory'->>'engineName'
    OR item->'identity'->>'createTime' IS DISTINCT FROM p->'memory'->>'engineCreateTime' THEN RETURN false; END IF;
  ELSIF item->>'type'='bootstrap_access' THEN
   IF item->>'id' IS DISTINCT FROM s->>'user_cloud_bootstrap_sa'
    OR item->'identity'->'account'->>'email' IS DISTINCT FROM s->>'user_cloud_bootstrap_sa'
    OR item->'identity'->'account'->>'projectId' IS DISTINCT FROM project
    OR coalesce(item->'identity'->'account'->>'uniqueId','') !~ '^[0-9]{6,30}$'
    OR jsonb_typeof(item->'identity'->'bindings') IS DISTINCT FROM 'array'
    OR item->>'authority' IS DISTINCT FROM 'owner_reviewed' THEN RETURN false; END IF;
   FOR original IN SELECT value FROM jsonb_array_elements(item->'identity'->'bindings') LOOP
    IF original-ARRAY['role','member','condition']<>'{}'::jsonb
     OR original->>'role' IS DISTINCT FROM 'roles/iam.serviceAccountTokenCreator'
     OR original->>'member' IS DISTINCT FROM 'serviceAccount:consent-protocol-runtime@hushh-pda-dev.iam.gserviceaccount.com'
    THEN RETURN false; END IF;
   END LOOP;
  ELSIF item->>'type'='project_iam_policy' THEN
   IF item->>'id' IS DISTINCT FROM project OR jsonb_typeof(item->'identity'->'bindings') IS DISTINCT FROM 'array'
    OR (item->'identity')-ARRAY['bindings']<>'{}'::jsonb THEN RETURN false; END IF;
   FOR original IN SELECT value FROM jsonb_array_elements(item->'identity'->'bindings') LOOP
    IF jsonb_typeof(original) IS DISTINCT FROM 'object' OR original-ARRAY['role','member','condition']<>'{}'::jsonb
     OR coalesce(original->>'role','')='' OR coalesce(original->>'member','')=''
     OR NOT (
      EXISTS(SELECT 1 FROM jsonb_array_elements(inventory->'plannedResources') x
       WHERE x->>'type'='service_account' AND original->>'member'='serviceAccount:'||(x->>'id'))
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(m->'substrateReceipt'->'bindingObservations','[]'::jsonb)) x
       WHERE x->>'disposition'='added' AND x->>'member'=original->>'member' AND x->>'role'=original->>'role'
        AND x->>'policyResource'='https://cloudresourcemanager.googleapis.com/v1/projects/'||project||':getIamPolicy'
        AND NOT original ? 'condition')) THEN RETURN false; END IF;
   END LOOP;
  ELSIF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(inventory->'plannedResources') x WHERE x->>'type'=item->>'type' AND x->>'id'=item->>'id') THEN RETURN false;
  END IF;
 END LOOP;
 FOR original IN SELECT value FROM jsonb_array_elements(inventory->'plannedResources') LOOP
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p->'resources') x WHERE x->>'type'=original->>'type' AND x->>'id'=original->>'id') THEN RETURN false; END IF;
 END LOOP;
 RETURN EXISTS(SELECT 1 FROM jsonb_array_elements(p->'resources') x WHERE x->>'type'='gcs_bucket' AND x->>'id'=p->'memory'->>'bucket')
  AND (SELECT count(*) FROM jsonb_array_elements(p->'resources') x WHERE x->>'type'='reasoning_engine')=1
  AND (SELECT count(*) FROM jsonb_array_elements(p->'resources') x WHERE x->>'type'='project_iam_policy')=1
  AND (SELECT count(*) FROM jsonb_array_elements(p->'resources') x WHERE x->>'type'='bootstrap_access')=1;
END;
$$;

CREATE FUNCTION public.legacy_cloud_removal_event_valid(recovery jsonb,event jsonb)
RETURNS boolean LANGUAGE plpgsql VOLATILE SET search_path=public AS $$
DECLARE p jsonb:=recovery->'plan'; item jsonb; prior jsonb; receipt jsonb:=event->'receipt'; key text:=event->>'resource'; stage text:=event->>'stage'; identity_hash text;
BEGIN
 IF jsonb_typeof(event) IS DISTINCT FROM 'object' OR event-ARRAY['sequence','resource','stage','receipt','recordedAt','executionId']<>'{}'::jsonb
 OR event->'sequence' IS DISTINCT FROM to_jsonb(jsonb_array_length(recovery->'events'))
 OR jsonb_typeof(receipt) IS DISTINCT FROM 'object' OR octet_length(receipt::text)>65536
 OR coalesce(stage,'') NOT IN ('approval','executor_started','writer_intent','writer_acknowledgement','writer_disabled','intent','acknowledgement','provider_dispatch','provider_ack','checkpoint','observation','attention','executor_exit')
 OR coalesce(event->>'recordedAt','')='' THEN RETURN false; END IF;
 IF stage='approval' THEN
  RETURN key='$approval' AND receipt-ARRAY['planSha256','ownerId','confirmation'] = '{}'::jsonb
   AND receipt->>'planSha256'=recovery->>'planSha256' AND receipt->>'ownerId'=p->>'ownerId'
   AND receipt->>'confirmation'=p->'project'->>'projectId';
 END IF;
 IF stage='executor_started' THEN
  IF key<>'$executor' OR receipt-ARRAY['executionId','sourceRevision','databasePid','databaseStartedAt']<>'{}'::jsonb
  OR coalesce(receipt->>'executionId','') !~ '^[0-9a-f]{32}$'
  OR receipt->>'sourceRevision' IS DISTINCT FROM p->>'sourceRevision'
  OR receipt->'databasePid' IS DISTINCT FROM to_jsonb(pg_backend_pid()) THEN RETURN false; END IF;
  RETURN receipt->>'databaseStartedAt'=(SELECT backend_start::text FROM pg_stat_activity WHERE pid=pg_backend_pid())
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') started WHERE started->>'stage'='executor_started'
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') exited WHERE exited->>'stage'='executor_exit'
     AND exited->'receipt'->>'executionId'=started->'receipt'->>'executionId'));
 END IF;
 IF stage NOT IN ('approval','executor_exit') AND NOT EXISTS(
  SELECT 1 FROM jsonb_array_elements(recovery->'events') started
  WHERE started->>'stage'='executor_started' AND started->'receipt'->>'executionId'=event->>'executionId'
   AND started->'receipt'->>'sourceRevision'=p->>'sourceRevision'
   AND started->'receipt'->'databasePid'=to_jsonb(pg_backend_pid())
   AND started->'receipt'->>'databaseStartedAt'=(SELECT backend_start::text FROM pg_stat_activity WHERE pid=pg_backend_pid())
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') exited WHERE exited->>'stage'='executor_exit'
    AND exited->'receipt'->>'executionId'=event->>'executionId')) THEN RETURN false; END IF;
 IF stage='attention' THEN
  RETURN coalesce(receipt->>'code','') ~ '^[A-Z][A-Z0-9_]{0,63}$'
   AND receipt-ARRAY['code','uncertain'] = '{}'::jsonb AND jsonb_typeof(receipt->'uncertain')='boolean';
 END IF;
 IF stage='executor_exit' THEN
  RETURN key='$executor' AND receipt-ARRAY['executionId','sourceRevision','outcome','supervisorVerified','databasePid','databaseStartedAt','processExitCode'] = '{}'::jsonb
   AND coalesce(receipt->>'executionId','') ~ '^[0-9a-f]{32}$'
   AND receipt->>'sourceRevision'=p->>'sourceRevision' AND receipt->>'outcome' IN ('returned','failed','cancelled')
   AND receipt->'supervisorVerified'='true'::jsonb
   AND jsonb_typeof(receipt->'processExitCode')='number'
   AND (receipt->>'outcome'='returned')=(receipt->'processExitCode'='0'::jsonb)
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') started WHERE started->>'stage'='executor_started'
    AND started->'receipt'->>'executionId'=receipt->>'executionId'
    AND started->'receipt'->'databasePid'=receipt->'databasePid'
    AND started->'receipt'->'databaseStartedAt'=receipt->'databaseStartedAt')
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') e WHERE e->>'stage'='executor_exit'
    AND e->'receipt'->>'executionId'=receipt->>'executionId')
   AND NOT EXISTS(SELECT 1 FROM pg_stat_activity a WHERE to_jsonb(a.pid)=receipt->'databasePid' AND a.backend_start::text=receipt->>'databaseStartedAt');
 END IF;
 SELECT value INTO item FROM jsonb_array_elements(p->'resources') WHERE (value->>'type')||':'||(value->>'id')=key;
 IF item IS NULL THEN RETURN false; END IF;
 identity_hash:=encode(sha256(convert_to((item->'identity')::text,'UTF8')),'hex');
 IF receipt->>'identitySha256' IS DISTINCT FROM identity_hash THEN RETURN false; END IF;
 IF stage='provider_dispatch' THEN
  RETURN item->>'authority'='owner_reviewed'
   AND receipt-ARRAY['identitySha256','requestId','targetSha256','method','purpose']='{}'::jsonb
   AND coalesce(receipt->>'purpose','mutation') IN ('mutation','credential_probe')
   AND (receipt->>'purpose' IS DISTINCT FROM 'credential_probe' OR item->>'type'='service_account' AND receipt->>'method'='POST')
   AND coalesce(receipt->>'requestId','') ~ '^[0-9a-f]{32}$'
   AND coalesce(receipt->>'targetSha256','') ~ '^[0-9a-f]{64}$'
   AND receipt->>'method' IN ('DELETE','POST','PATCH','PUT')
   AND (item->>'type'<>'reasoning_engine' OR EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') e
    WHERE e->>'resource'=key AND e->>'stage'='checkpoint' AND e->'receipt'->>'stage'='memoryBinding'
     AND e->'receipt'->'value' IS NOT DISTINCT FROM p->'memory'))
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') e WHERE e->>'resource'=key AND e->>'stage' IN ('intent','writer_intent'))
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') e WHERE e->>'resource'=key AND e->>'stage'='provider_dispatch'
    AND e->'receipt'->>'targetSha256'=receipt->>'targetSha256'
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') ack WHERE ack->>'stage'='provider_ack'
      AND ack->'receipt'->>'requestId'=e->'receipt'->>'requestId'
      AND (ack->'receipt'->>'httpStatus' IN ('401','403','412','429') OR receipt->>'purpose'='credential_probe')));
 END IF;
 IF stage='provider_ack' THEN
  RETURN receipt-ARRAY['identitySha256','requestId','targetSha256','httpStatus','bodySha256','operationName']='{}'::jsonb
   AND coalesce(receipt->>'httpStatus','') ~ '^[1-5][0-9]{2}$'
   AND coalesce(receipt->>'bodySha256','') ~ '^[0-9a-f]{64}$'
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') e WHERE e->>'resource'=key AND e->>'stage'='provider_dispatch'
    AND e->'receipt'->>'requestId'=receipt->>'requestId' AND e->'receipt'->>'targetSha256'=receipt->>'targetSha256')
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') e WHERE e->>'stage'='provider_ack' AND e->'receipt'->>'requestId'=receipt->>'requestId');
 END IF;
 IF stage='checkpoint' THEN
  RETURN item->>'type' IN ('gcs_bucket','kms_key','service_account','project_iam_policy','reasoning_engine')
   AND receipt-ARRAY['identitySha256','stage','value']='{}'::jsonb
   AND receipt->>'stage' IN ('bucketAdmission','bucketAcknowledgement','bucketDeletion','memoryBinding','inventory','admission','acknowledgement','destruction','completion','temporaryGrant','temporaryGrantRemoved')
   AND jsonb_typeof(receipt->'value')='object'
   AND (receipt->>'stage'<>'memoryBinding' OR (item->>'type'='reasoning_engine' AND receipt->'value' IS NOT DISTINCT FROM p->'memory'))
   AND (receipt->>'stage' NOT IN ('bucketAdmission','bucketAcknowledgement','bucketDeletion') OR
    (item->>'type'='gcs_bucket' AND receipt->'value'->'bucketIdentity' IS NOT DISTINCT FROM item->'identity'
     AND receipt->'value'->>'status'=CASE receipt->>'stage' WHEN 'bucketAdmission' THEN 'admitted' WHEN 'bucketAcknowledgement' THEN 'acknowledged' ELSE 'deleted' END
     AND coalesce(receipt->'value'->>'metageneration','') ~ '^[1-9][0-9]*$'))
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') e WHERE e->>'resource'=key AND e->>'stage' IN ('intent','writer_intent'));
 END IF;
 IF stage IN ('intent','writer_intent') THEN
  IF item->>'authority'<>'owner_reviewed' OR coalesce(receipt->>'requestId','') !~ '^[0-9a-f]{32}$'
  OR receipt-ARRAY['requestId','identitySha256','method']<>'{}'::jsonb
  OR receipt->>'method' NOT IN ('DELETE','POST','PATCH')
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') e WHERE e->>'resource'=key AND e->>'stage'=stage) THEN RETURN false; END IF;
  IF stage='writer_intent' THEN RETURN item->>'type'='service_account' AND item->>'id'=p->'runtime'->'principal'->>'email'; END IF;
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') e WHERE e->>'stage'='writer_disabled') THEN RETURN false; END IF;
  IF item->>'type'<>'cloud_run_service' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') e
    WHERE e->>'resource'='cloud_run_service:'||regexp_replace(p->'runtime'->>'serviceName','^.*/','') AND e->>'stage'='observation' AND e->'receipt'->>'status'='deleted') THEN RETURN false; END IF;
  IF item->>'type' NOT IN ('cloud_run_service','reasoning_engine') AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') e
    WHERE e->>'resource'='reasoning_engine:'||(p->'memory'->>'engineName') AND e->>'stage'='observation' AND e->'receipt'->>'status' IN ('deleted','observed_absent')) THEN RETURN false; END IF;
  IF item->>'type'='bootstrap_access' THEN
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(p->'resources') candidate WHERE candidate->>'type'<>'bootstrap_access'
    AND coalesce((SELECT e->'receipt'->>'status' FROM jsonb_array_elements(recovery->'events') WITH ORDINALITY x(e,ord)
     WHERE e->>'resource'=(candidate->>'type')||':'||(candidate->>'id') AND e->>'stage'='observation' ORDER BY ord DESC LIMIT 1),'')
     NOT IN ('deleted','observed_absent','retained_shared')) THEN RETURN false; END IF;
   RETURN public.project_grant_release_is_exclusive(p->>'ownerId',p->'project'->>'projectId') IS TRUE;
  END IF;
  IF item->>'type'='project_iam_policy' THEN
   RETURN public.project_grant_release_is_exclusive(p->>'ownerId',p->'project'->>'projectId') IS TRUE;
  END IF;
  RETURN true;
 END IF;
 SELECT value INTO prior FROM jsonb_array_elements(recovery->'events') e WHERE e->>'resource'=key
  AND e->>'stage'=CASE WHEN stage IN ('writer_acknowledgement','writer_disabled') THEN 'writer_intent' ELSE 'intent' END;
 IF stage IN ('acknowledgement','writer_acknowledgement') THEN
  RETURN prior IS NOT NULL AND receipt-ARRAY['requestId','identitySha256','httpStatus','operationName'] = '{}'::jsonb
   AND receipt->>'requestId'=prior->'receipt'->>'requestId' AND coalesce(receipt->>'httpStatus','') ~ '^2[0-9]{2}$'
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') e WHERE e->>'resource'=key AND e->>'stage'=stage);
 END IF;
 IF stage='writer_disabled' THEN
  RETURN prior IS NOT NULL AND item->>'id'=p->'runtime'->'principal'->>'email'
   AND receipt-ARRAY['identitySha256','status','nativeReadbackSha256','credentialDenied'] = '{}'::jsonb
   AND receipt->>'status'='disabled' AND receipt->'credentialDenied'='true'::jsonb
   AND coalesce(receipt->>'nativeReadbackSha256','') ~ '^[0-9a-f]{64}$';
 END IF;
 IF stage='observation' THEN
  IF receipt-ARRAY['identitySha256','status','httpStatus','nativeReadbackSha256','operationName','operationDone','coverage']<>'{}'::jsonb
  OR coalesce(receipt->>'nativeReadbackSha256','') !~ '^[0-9a-f]{64}$'
  OR coalesce(receipt->>'status','') NOT IN ('observed_absent','deleted','retained_shared','waiting_for_provider') THEN RETURN false; END IF;
  IF receipt->>'status'='observed_absent' THEN RETURN item->>'type'<>'gcs_bucket' AND receipt->'httpStatus'='404'::jsonb AND prior IS NULL; END IF;
  IF receipt->>'status'='retained_shared' THEN RETURN item->>'authority'='retain_shared' AND item->>'type'='artifact_repository' AND receipt->'httpStatus'='200'::jsonb AND prior IS NULL; END IF;
  IF receipt->>'status'='waiting_for_provider' THEN RETURN prior IS NOT NULL; END IF;
  IF item->>'type' IN ('project_iam_policy','bootstrap_access') AND receipt->>'status'='deleted' THEN
   RETURN prior IS NOT NULL AND receipt->'httpStatus'='200'::jsonb
    AND receipt->'coverage'->'bindingsAbsent'='true'::jsonb;
  END IF;
  IF item->>'type'='kms_key' AND receipt->>'status'='deleted' THEN
   RETURN prior IS NOT NULL AND receipt->'httpStatus'='200'::jsonb
    AND receipt->'coverage'->'allVersionsDestroyed'='true'::jsonb
    AND EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') e WHERE e->>'resource'=key
     AND e->>'stage'='checkpoint' AND e->'receipt'->>'stage'='completion');
  END IF;
  IF item->>'type'='gcs_bucket' AND receipt->>'status'='deleted' AND NOT EXISTS(
   SELECT 1 FROM jsonb_array_elements(recovery->'events') e WHERE e->>'resource'=key
    AND e->>'stage'='checkpoint' AND e->'receipt'->>'stage'='bucketDeletion'
    AND e->'receipt'->'value'->>'status'='deleted'
    AND e->'receipt'->'value'->'bucketIdentity' IS NOT DISTINCT FROM item->'identity') THEN RETURN false; END IF;
  IF prior IS NULL OR receipt->'httpStatus'<>'404'::jsonb THEN RETURN false; END IF;
  IF item->>'type' IN ('cloud_run_service','reasoning_engine') THEN
   IF item->>'type'='reasoning_engine' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') e
    WHERE e->>'resource'=key AND e->>'stage'='checkpoint' AND e->'receipt'->>'stage'='memoryBinding'
     AND e->'receipt'->'value' IS NOT DISTINCT FROM p->'memory') THEN RETURN false; END IF;
   IF receipt->'operationDone' IS DISTINCT FROM 'true'::jsonb OR coalesce(receipt->>'operationName','')=''
   OR receipt->'coverage'->'complete' IS DISTINCT FROM 'true'::jsonb
   OR receipt->'coverage'->'pendingOperations' IS DISTINCT FROM '0'::jsonb THEN RETURN false; END IF;
   IF item->>'type'='cloud_run_service' AND receipt->'coverage'->'remainingRevisions' IS DISTINCT FROM '0'::jsonb THEN RETURN false; END IF;
  END IF;
  RETURN EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') e WHERE e->>'resource'=key AND e->>'stage'='acknowledgement'
   AND e->'receipt'->'operationName' IS NOT DISTINCT FROM receipt->'operationName');
 END IF;
 RETURN false;
END;
$$;

CREATE FUNCTION public.legacy_cloud_removal_append_valid(r jsonb,old_value jsonb,new_value jsonb)
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=public AS $$
DECLARE n integer; event jsonb;
BEGIN
 IF jsonb_typeof(new_value) IS DISTINCT FROM 'object' OR new_value-ARRAY['version','plan','planSha256','events']<>'{}'::jsonb
 OR new_value->'version' IS DISTINCT FROM '1'::jsonb OR jsonb_typeof(new_value->'events') IS DISTINCT FROM 'array'
 OR new_value->>'planSha256' IS DISTINCT FROM encode(sha256(convert_to((new_value->'plan')::text,'UTF8')),'hex')
 OR public.legacy_cloud_removal_plan_valid(r,new_value->'plan') IS NOT TRUE THEN RETURN false; END IF;
 IF old_value IS NULL THEN RETURN new_value->'events'='[]'::jsonb; END IF;
 IF new_value-'events' IS DISTINCT FROM old_value-'events' THEN RETURN false; END IF;
 n:=jsonb_array_length(old_value->'events');
 IF n>=2048 OR jsonb_array_length(new_value->'events')<>n+1 THEN RETURN false; END IF;
 IF coalesce((SELECT jsonb_agg(value ORDER BY ordinality) FROM jsonb_array_elements(new_value->'events') WITH ORDINALITY WHERE ordinality<=n),'[]'::jsonb)
    IS DISTINCT FROM old_value->'events' THEN RETURN false; END IF;
 event:=new_value->'events'->n;
 RETURN public.legacy_cloud_removal_event_valid(old_value,event);
END;
$$;

CREATE FUNCTION public.legacy_cloud_removal_complete(owner_id text,attempt text)
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=public AS $$
DECLARE op public.personal_agent_cloud_removals%ROWTYPE; agent public.personal_agent_registry%ROWTYPE; item jsonb; latest jsonb;
BEGIN
 SELECT * INTO op FROM public.personal_agent_cloud_removals WHERE user_id=owner_id AND attempt_id=attempt;
 SELECT * INTO agent FROM public.personal_agent_registry WHERE user_id=owner_id;
 IF op.recovery IS NULL OR op.completed_at IS NOT NULL OR op.cancelled_at IS NOT NULL OR agent.status IS DISTINCT FROM 'suspended'
 OR agent.backend_metadata->'erasure'->>'attemptId' IS DISTINCT FROM attempt
 OR public.legacy_cloud_removal_plan_valid(agent.backend_metadata->'erasure',op.recovery->'plan') IS NOT TRUE
 OR EXISTS(SELECT 1 FROM public.personal_agent_standby_placements WHERE user_id=owner_id)
 OR EXISTS(SELECT 1 FROM public.pod_migration_jobs WHERE user_id=owner_id)
 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(op.recovery->'events') e WHERE e->>'stage'='approval') THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(op.recovery->'events') dispatched WHERE dispatched->>'stage'='provider_dispatch'
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(op.recovery->'events') ack WHERE ack->>'stage'='provider_ack'
   AND ack->'receipt'->>'requestId'=dispatched->'receipt'->>'requestId')) THEN RETURN false; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(op.recovery->'plan'->'resources') LOOP
  SELECT value INTO latest FROM jsonb_array_elements(op.recovery->'events') WITH ORDINALITY e(value,ord)
   WHERE value->>'resource'=(item->>'type')||':'||(item->>'id') AND value->>'stage'='observation' ORDER BY ord DESC LIMIT 1;
  IF latest IS NULL OR latest->'receipt'->>'status' NOT IN ('observed_absent','deleted','retained_shared') THEN RETURN false; END IF;
 END LOOP;
 SELECT value INTO latest FROM jsonb_array_elements(op.recovery->'events') WITH ORDINALITY e(value,ord)
  WHERE value->>'stage' IN ('executor_started','executor_exit') ORDER BY ord DESC LIMIT 1;
 RETURN coalesce(latest->>'stage'='executor_exit' AND latest->'receipt'->>'outcome'='returned'
  AND latest->'receipt'->'supervisorVerified'='true'::jsonb,false);
END;
$$;

CREATE FUNCTION public.legacy_cloud_removal_archive(r jsonb,history jsonb,recovery jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=public AS $$
 SELECT public.personal_agent_erasure_archive(r,history)||jsonb_build_object('legacyRecovery',recovery);
$$;

CREATE FUNCTION public.retain_legacy_cloud_removal(owner_id text,attempt text,expected_digest text,plan jsonb,event jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SET search_path=public AS $$
DECLARE op public.personal_agent_cloud_removals%ROWTYPE; agent public.personal_agent_registry%ROWTYPE; candidate jsonb; digest text;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RETURN NULL; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 SELECT * INTO agent FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 SELECT * INTO op FROM public.personal_agent_cloud_removals WHERE user_id=owner_id AND attempt_id=attempt FOR UPDATE;
 IF op IS NULL OR op.completed_at IS NOT NULL OR op.cancelled_at IS NOT NULL OR agent.status IS DISTINCT FROM 'suspended'
 OR op.approved_digest IS NULL OR op.execution_started_at IS NULL
 OR agent.backend_metadata->'erasure'->>'attemptId' IS DISTINCT FROM attempt
 OR EXISTS(SELECT 1 FROM public.account_deletion_tombstones WHERE user_id_hash='sha256:'||encode(sha256(convert_to(owner_id,'UTF8')),'hex')) THEN RETURN NULL; END IF;
 IF op.recovery IS NULL THEN
  IF event IS NOT NULL OR expected_digest IS DISTINCT FROM op.snapshot_sha256 THEN RETURN NULL; END IF;
  candidate:=jsonb_build_object('version',1,'plan',plan,'planSha256',encode(sha256(convert_to(plan::text,'UTF8')),'hex'),'events','[]'::jsonb);
 ELSE
  digest:=encode(sha256(convert_to(op.recovery::text,'UTF8')),'hex');
  IF expected_digest IS DISTINCT FROM digest OR plan IS DISTINCT FROM op.recovery->'plan' OR event IS NULL THEN RETURN NULL; END IF;
  event:=event||jsonb_build_object('sequence',jsonb_array_length(op.recovery->'events'),'recordedAt',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
  candidate:=jsonb_set(op.recovery,'{events}',op.recovery->'events'||jsonb_build_array(event));
 END IF;
 IF public.legacy_cloud_removal_append_valid(agent.backend_metadata->'erasure',op.recovery,candidate) IS NOT TRUE THEN RETURN NULL; END IF;
 IF event IS NOT NULL AND event->>'stage' IN ('intent','writer_intent','provider_dispatch') AND NOT EXISTS(
  SELECT 1 FROM jsonb_array_elements(op.recovery->'events') e WHERE e->>'stage'='approval'
   AND (e->>'recordedAt')::timestamptz>clock_timestamp()-interval '10 minutes') THEN RETURN NULL; END IF;
 UPDATE public.personal_agent_cloud_removals SET recovery=candidate WHERE user_id=owner_id AND attempt_id=attempt;
 RETURN candidate;
END;
$$;

-- Guard and finalizer successors are installed below with exact predecessor checks.

DO $preimages$ BEGIN
IF encode(sha256(convert_to(pg_get_functiondef('public.guard_personal_agent_cloud_removal()'::regprocedure),'UTF8')),'hex') IS DISTINCT FROM 'eb565a365d386bd85d2409c33edb11dadd152981ab8407a30dae40fadebd53b7' THEN RAISE EXCEPTION 'Legacy recovery predecessor changed: guard_personal_agent_cloud_removal()'; END IF;
IF encode(sha256(convert_to(pg_get_functiondef('public.finalize_personal_agent_cloud_removal(text,text,text)'::regprocedure),'UTF8')),'hex') IS DISTINCT FROM 'da5f9deff4c3a6c0175639f40373bef33595e681390274561280b65117d88b30' THEN RAISE EXCEPTION 'Legacy recovery predecessor changed: finalize_personal_agent_cloud_removal(text,text,text)'; END IF;
IF encode(sha256(convert_to(pg_get_functiondef('public.assert_project_grant_admission(text)'::regprocedure),'UTF8')),'hex') IS DISTINCT FROM '7809762b1a8f4e0703ca6d070c89fdec1d2ac30e2cd33298628d2dced7c72182' THEN RAISE EXCEPTION 'Legacy recovery predecessor changed: assert_project_grant_admission(text)'; END IF;
END $preimages$;

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
 IF EXISTS (SELECT 1 FROM public.personal_agent_registry r WHERE r.backend_metadata->'erasure'->'grantRelease'->>'project'=project_id)
 OR EXISTS(SELECT 1 FROM public.personal_agent_cloud_removals c WHERE c.completed_at IS NULL AND c.cancelled_at IS NULL
  AND c.recovery->'plan'->'project'->>'projectId'=project_id
  AND EXISTS(SELECT 1 FROM jsonb_array_elements(c.recovery->'events') e
   WHERE e->>'resource' IN (SELECT (x->>'type')||':'||(x->>'id') FROM jsonb_array_elements(c.recovery->'plan'->'resources') x WHERE x->>'type' IN ('bootstrap_access','project_iam_policy')) AND e->>'stage'='intent')) THEN
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
 IF TG_OP='INSERT' AND NEW.recovery IS NOT NULL THEN
  RAISE EXCEPTION 'legacy recovery requires an existing removal' USING ERRCODE='42501'; END IF;
 IF TG_OP='UPDATE' AND NEW.recovery IS DISTINCT FROM OLD.recovery THEN
  IF OLD.completed_at IS NOT NULL OR OLD.cancelled_at IS NOT NULL
  OR to_jsonb(NEW)-'recovery' IS DISTINCT FROM to_jsonb(OLD)-'recovery'
  OR public.legacy_cloud_removal_append_valid(r,OLD.recovery,NEW.recovery) IS NOT TRUE THEN
   RAISE EXCEPTION 'legacy recovery append refused' USING ERRCODE='42501'; END IF;
  RETURN NEW;
 END IF;
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
  IF public.legacy_cloud_removal_complete(owner_id,NEW.attempt_id) IS TRUE THEN
   IF NEW.archive IS DISTINCT FROM public.legacy_cloud_removal_archive(r,history,OLD.recovery)
    OR NEW.released_identity IS DISTINCT FROM public.personal_agent_cloud_removal_identity(to_jsonb(agent),NEW.completed_at,NEW.attempt_id) THEN
    RAISE EXCEPTION 'legacy recovery completion unconfirmed' USING ERRCODE='42501'; END IF;
   RETURN NEW;
  END IF;
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
 IF NOT FOUND OR expected_digest IS NULL THEN RETURN false; END IF;
 -- A lost response is recoverable only while its exact released identity is
 -- still current. A replacement never becomes "unplaced" through an old replay.
 IF op.completed_at IS NOT NULL THEN
  RETURN (expected_digest=op.approved_digest OR expected_digest=op.recovery->>'planSha256')
   AND public.personal_agent_cloud_removal_replay_current(owner_id,attempt);
 END IF;
 IF expected_digest IS DISTINCT FROM coalesce(op.recovery->>'planSha256',op.approved_digest) THEN RETURN false; END IF;
 IF (public.legacy_cloud_removal_complete(owner_id,attempt) IS NOT TRUE
 AND public.personal_agent_erasure_complete(owner_id) IS NOT TRUE)
 OR EXISTS(SELECT 1 FROM public.personal_agent_standby_placements WHERE user_id=owner_id) THEN RETURN false; END IF;
 SELECT * INTO agent FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 r:=agent.backend_metadata->'erasure';
 IF r->>'attemptId' IS DISTINCT FROM attempt THEN RETURN false; END IF;
 SELECT authorization_attempts INTO history FROM public.byoc_setup_jobs WHERE user_id=owner_id FOR UPDATE;
 removed_at:=clock_timestamp();
 UPDATE public.personal_agent_cloud_removals SET completed_at=removed_at,
  archive=CASE WHEN op.recovery IS NULL THEN public.personal_agent_erasure_archive(r,history) ELSE public.legacy_cloud_removal_archive(r,history,op.recovery) END,
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

REVOKE ALL ON FUNCTION public.legacy_cloud_removal_plan_valid(jsonb,jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.legacy_cloud_removal_event_valid(jsonb,jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.legacy_cloud_removal_append_valid(jsonb,jsonb,jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.legacy_cloud_removal_complete(text,text) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.legacy_cloud_removal_archive(jsonb,jsonb,jsonb) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.retain_legacy_cloud_removal(text,text,text,jsonb,jsonb) FROM PUBLIC;

COMMIT;
