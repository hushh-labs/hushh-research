-- Dev only: retain Azure setup's non-secret binding BEFORE the first ARM write.
-- Stays in the existing setup job; no credential or second infrastructure ledger.
BEGIN;

CREATE OR REPLACE FUNCTION public.valid_byoc_azure_setup_intent(
  owner_id text, job_id text, target text, hushh_id text, intent jsonb
) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $$
BEGIN
 IF intent->'version'='2'::jsonb THEN
   RETURN public.valid_byoc_azure_hosted_intent(owner_id,job_id,target,hushh_id,intent);
 END IF;
 IF jsonb_typeof(intent) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 IF EXISTS (SELECT 1 FROM unnest(ARRAY['jobId','hushhId','tenantId','subscriptionId',
   'resourceGroup','location','setupNonce']) field
   WHERE jsonb_typeof(intent->field) IS DISTINCT FROM 'string') THEN RETURN false; END IF;
 RETURN intent - ARRAY['version','jobId','hushhId','tenantId','subscriptionId',
   'resourceGroup','location','setupNonce','groupInitiallyAbsent'] = '{}'::jsonb
 AND intent ?& ARRAY['version','jobId','hushhId','tenantId','subscriptionId',
   'resourceGroup','location','setupNonce']
 AND (NOT intent ? 'groupInitiallyAbsent' OR jsonb_typeof(intent->'groupInitiallyAbsent')='boolean')
 AND intent->'version' = '1'::jsonb
 AND coalesce(owner_id,'') <> '' AND coalesce(job_id,'') <> ''
 AND intent->>'jobId' = job_id AND intent->>'hushhId' = hushh_id
 AND (intent->>'tenantId' ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$') IS TRUE
 AND (intent->>'subscriptionId' ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$') IS TRUE
 AND (intent->>'resourceGroup' ~ '^[A-Za-z0-9_().-]{0,89}[A-Za-z0-9_()-]$') IS TRUE
 AND (intent->>'location' ~ '^[a-z][a-z0-9]{1,39}$') IS TRUE
 AND (intent->>'setupNonce' ~ '^[0-9a-f]{16}$') IS TRUE
 AND target = '/subscriptions/' || (intent->>'subscriptionId') ||
   '/resourceGroups/' || (intent->>'resourceGroup')
 AND pg_column_size(intent) <= 4096;
END;
$$;

-- Exact tuple lists cannot grant themselves custody or arbitrary resource writes.
-- Resource names follow the installed registry's provider-observed naming digest.
CREATE OR REPLACE FUNCTION public.valid_byoc_azure_hosted_request(intent jsonb,call jsonb,target text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $$
DECLARE digest text:=substring(intent->'binding'->>'image' FROM '^crhussh([a-f0-9]{16})\.azurecr\.io/');
 base text:=target||'/providers/'; path text:=call->>'path'; purpose text:=call->>'purpose';
 app text:=target||'/providers/Microsoft.App/containerApps/ca-hussh-one-pod'; registry text;
 roles text[]; scope text;
BEGIN
 IF digest IS NULL OR intent->'binding'->>'external_agent_id' IS DISTINCT FROM app
 THEN RETURN false; END IF;
 registry:=base||'Microsoft.ContainerRegistry/registries/crhussh'||digest;
 IF purpose='files_activation' THEN
  RETURN intent->>'kind'='upgrade' AND intent->'capabilityPlanDigest'<>'null'::jsonb
   AND call->>'method'='PUT' AND call->>'apiVersion' IN ('2023-05-01','2022-04-01');
 END IF;
 IF purpose='importing_image' THEN RETURN call->>'method'='POST'
  AND call->>'apiVersion'='2023-07-01' AND path=registry||'/importImage'; END IF;
 IF purpose='deploying_agent' AND path=app THEN RETURN call->>'method'='PUT'
  AND call->>'apiVersion'='2025-01-01'; END IF;
 IF intent->>'kind'<>'rebuild' THEN RETURN false; END IF;
 IF purpose='registering_providers' THEN RETURN call->>'method'='POST'
  AND call->>'apiVersion'='2021-04-01'
  AND path=ANY(ARRAY(SELECT '/subscriptions/'||(intent->>'subscriptionId')||'/providers/'||p||'/register'
    FROM unnest(ARRAY['Microsoft.App','Microsoft.ManagedIdentity','Microsoft.KeyVault',
     'Microsoft.Storage','Microsoft.ContainerRegistry','Microsoft.CognitiveServices']) p)); END IF;
 IF call->>'method'<>'PUT' THEN RETURN false; END IF;
 IF purpose='creating_registry' THEN RETURN path=registry AND call->>'apiVersion'='2023-07-01'; END IF;
 IF purpose='creating_model' THEN RETURN call->>'apiVersion'='2024-10-01' AND path IN (
  base||'Microsoft.CognitiveServices/accounts/oai-hussh-'||digest,
  base||'Microsoft.CognitiveServices/accounts/oai-hussh-'||digest||'/deployments/one-chat'); END IF;
 IF purpose='creating_environment' THEN RETURN path=base||'Microsoft.App/managedEnvironments/cae-hussh-one'
  AND call->>'apiVersion'='2025-01-01'; END IF;
 IF purpose NOT IN ('assigning_roles','deploying_agent') OR call->>'apiVersion'<>'2022-04-01'
 THEN RETURN false; END IF;
 IF purpose='assigning_roles' AND starts_with(path,base||'Microsoft.Authorization/roleDefinitions/')
 THEN RETURN substring(path FROM length(base||'Microsoft.Authorization/roleDefinitions/')+1)
   ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'; END IF;
 roles:=ARRAY[target,app,base||'Microsoft.App/managedEnvironments/cae-hussh-one',registry,
  base||'Microsoft.CognitiveServices/accounts/oai-hussh-'||digest,
  base||'Microsoft.KeyVault/vaults/kv-h1-'||digest||'/keys/pod-log-key',
  base||'Microsoft.KeyVault/vaults/kv-h1-'||digest||'/secrets/pod-signing-key',
  base||'Microsoft.Storage/storageAccounts/sthussh'||digest,
  base||'Microsoft.Storage/storageAccounts/sthussh'||digest||'/blobServices/default/containers/pod',
  base||'Microsoft.Storage/storageAccounts/sthussh'||digest||'/queueServices/default/queues/files-organization'];
 FOREACH scope IN ARRAY roles LOOP
  IF purpose='deploying_agent' AND scope<>app THEN CONTINUE; END IF;
  IF starts_with(path,scope||'/providers/Microsoft.Authorization/roleAssignments/') AND
    substring(path FROM length(scope||'/providers/Microsoft.Authorization/roleAssignments/')+1)
     ~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' THEN RETURN true; END IF;
 END LOOP;
 RETURN false;
END $$;

-- Version two binds the same journal to an already installed pod. Retention
-- validates shape; current authority is checked separately at each dispatch.
CREATE OR REPLACE FUNCTION public.valid_byoc_azure_hosted_intent(
 owner_id text, job_id text, target text, hushh_id text, intent jsonb
) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $$
DECLARE extra text[]:=ARRAY['kind','binding','sourceImage','allowedRequests']; call jsonb;
BEGIN
 IF intent->>'kind' NOT IN ('upgrade','rebuild') THEN RETURN false; END IF;
 IF intent->>'kind'='upgrade' THEN
   extra:=extra||ARRAY['attemptId','operationId','releaseId','idempotencyKey','capabilityPlanDigest'];
   IF (intent->>'attemptId' ~ '^[a-f0-9]{64}$') IS NOT TRUE
    OR EXISTS(SELECT 1 FROM unnest(ARRAY['operationId','releaseId','idempotencyKey']) k
      WHERE jsonb_typeof(intent->k) IS DISTINCT FROM 'string' OR length(intent->>k) NOT BETWEEN 1 AND 256)
    OR NOT (intent->'capabilityPlanDigest'='null'::jsonb OR
      (intent->>'capabilityPlanDigest' ~ '^[a-f0-9]{64}$') IS TRUE)
   THEN RETURN false; END IF;
 END IF;
 IF public.valid_byoc_azure_setup_intent(owner_id,job_id,target,hushh_id,
    jsonb_set(intent-extra,'{version}','1'::jsonb)) IS NOT TRUE
  OR NOT intent ?& extra OR octet_length(intent::text)>32768
  OR jsonb_typeof(intent->'binding') IS DISTINCT FROM 'object'
  OR jsonb_typeof(intent->'sourceImage') IS DISTINCT FROM 'string'
  OR (intent->>'sourceImage' ~ '^[A-Za-z0-9./_:-]+@sha256:[a-f0-9]{64}$') IS NOT TRUE
  OR jsonb_typeof(intent->'allowedRequests') IS DISTINCT FROM 'array'
 THEN RETURN false; END IF;
 IF jsonb_array_length(intent->'allowedRequests') NOT BETWEEN 2 AND 64 THEN RETURN false; END IF;
 FOR call IN SELECT value FROM jsonb_array_elements(intent->'allowedRequests') LOOP
  IF call-ARRAY['method','path','apiVersion','purpose']<>'{}'::jsonb
   OR NOT call ?& ARRAY['method','path','apiVersion','purpose']
   OR (call->>'method' IN ('PUT','POST')) IS NOT TRUE
   OR (call->>'apiVersion' ~ '^\d{4}-\d{2}-\d{2}(-preview)?$') IS NOT TRUE
   OR (call->>'purpose' ~ '^[a-z_]{1,64}$') IS NOT TRUE
   OR length(call->>'path') NOT BETWEEN 1 AND 2048
   OR (call->>'path' ~ '^[A-Za-z0-9_./()@:-]+$') IS NOT TRUE
   OR position('..' IN call->>'path')>0
   OR public.valid_byoc_azure_hosted_request(intent,call,target) IS NOT TRUE
   OR NOT (starts_with(call->>'path',target||'/') OR
     (call->>'method'='POST' AND call->>'purpose'='registering_providers'
      AND call->>'path'=ANY(ARRAY(SELECT '/subscriptions/'||(intent->>'subscriptionId')||
       '/providers/'||provider||'/register' FROM unnest(ARRAY['Microsoft.App',
       'Microsoft.ManagedIdentity','Microsoft.KeyVault','Microsoft.Storage',
       'Microsoft.ContainerRegistry','Microsoft.CognitiveServices']) provider))))
  THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.byoc_azure_intent_admitted(
 agent public.personal_agent_registry, job public.byoc_setup_jobs, intent jsonb,
 allow_unbound boolean DEFAULT false
) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=public AS $$
DECLARE metadata jsonb:=coalesce(agent.backend_metadata,'{}'::jsonb);
 approval jsonb:=metadata->'upgradeApproval'; binding jsonb;
BEGIN
 IF job.user_id IS DISTINCT FROM agent.user_id OR job.status IS DISTINCT FROM 'running'
  OR metadata ? 'erasure' OR jsonb_typeof(job.stages) IS DISTINCT FROM 'array'
 THEN RETURN false; END IF;
 IF agent.status IN ('pending','unprovisioned','logical') AND nullif(agent.backend,'') IS NULL
  AND nullif(agent.external_agent_id,'') IS NULL AND nullif(agent.user_cloud_project,'') IS NULL
 THEN RETURN (allow_unbound AND intent IS NULL) OR (intent->'version'='1'::jsonb AND
   public.valid_byoc_azure_setup_intent(agent.user_id,job.job_id,job.project_id,agent.hushh_id,intent));
 END IF;
 IF intent->'version' IS DISTINCT FROM '2'::jsonb
  OR public.valid_byoc_azure_setup_intent(agent.user_id,job.job_id,job.project_id,agent.hushh_id,intent) IS NOT TRUE
  OR agent.deployment_target IS DISTINCT FROM 'user_azure' OR agent.backend IS DISTINCT FROM 'user_azure'
  OR nullif(agent.user_cloud_project,'') IS NOT NULL
  OR agent.user_cloud_tenant_id IS DISTINCT FROM intent->>'tenantId'
  OR agent.user_cloud_subscription_id IS DISTINCT FROM intent->>'subscriptionId'
  OR agent.user_cloud_resource_group IS DISTINCT FROM intent->>'resourceGroup'
  OR agent.user_cloud_region IS DISTINCT FROM intent->>'location'
  OR metadata->>'setupNonce' IS DISTINCT FROM intent->>'setupNonce'
  OR EXISTS(SELECT 1 FROM unnest(ARRAY['serviceUid','runtime_principal_id','runtime_client_id']) k
    WHERE coalesce(metadata->>k,'')='')
  OR coalesce(agent.pod_pubkey,'')='' OR coalesce(agent.pod_key_id,'')=''
 THEN RETURN false; END IF;
 binding:=jsonb_build_object('user_id',agent.user_id,'hushh_id',agent.hushh_id,
  'backend',agent.backend,'external_agent_id',agent.external_agent_id,
  'deployment_target',agent.deployment_target,'pod_pubkey',agent.pod_pubkey,
  'pod_key_id',agent.pod_key_id,'model_credential_mode',agent.model_credential_mode,
  'serviceUid',metadata->'serviceUid','setupNonce',metadata->'setupNonce','image',metadata->'image',
  'runtime_principal_id',metadata->'runtime_principal_id','runtime_client_id',metadata->'runtime_client_id');
 IF intent->'binding' IS DISTINCT FROM binding THEN RETURN false; END IF;
 IF intent->>'kind'='rebuild' THEN
   RETURN agent.status IN ('provisioned','needs_reinit') AND coalesce(metadata->>'upgradeLease','')='';
 END IF;
 RETURN agent.status='provisioned' AND coalesce(metadata->>'upgradeLease','')<>''
  AND intent->>'attemptId'=encode(sha256(convert_to(metadata->>'upgradeLease','UTF8')),'hex')
  AND approval->'version'='1'::jsonb AND approval->>'ownerId'=agent.user_id
  AND approval->>'hushhId'=agent.hushh_id AND approval->>'podIncarnation'=metadata->>'serviceUid'
  AND approval->>'status' IN ('approved','scheduled','updating')
  AND approval->>'targetImage'=intent->>'sourceImage'
  AND approval->>'operationId'=intent->>'operationId' AND approval->>'releaseId'=intent->>'releaseId'
  AND approval->>'idempotencyKey'=intent->>'idempotencyKey'
  AND coalesce(approval->'capabilityPlanDigest','null'::jsonb)=intent->'capabilityPlanDigest';
END $$;

-- Files writes additionally require their current exact capability checkpoint.
CREATE OR REPLACE FUNCTION public.byoc_azure_files_request_admitted(owner_id text,event jsonb)
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=public AS $$
DECLARE agent public.personal_agent_registry%ROWTYPE; metadata jsonb; checkpoint jsonb;
 candidate jsonb; operation jsonb;
BEGIN
 IF to_regprocedure('public.valid_erasure_azure_files_upgrade_observation(jsonb,jsonb)') IS NULL
 THEN RETURN false; END IF;
 SELECT * INTO agent FROM public.personal_agent_registry WHERE user_id=owner_id;
 metadata:=agent.backend_metadata; checkpoint:=metadata->'filesUpgradeCheckpoint';
 IF jsonb_typeof(checkpoint->'completed') IS DISTINCT FROM 'array'
  OR jsonb_typeof(metadata->'azureFilesInventory'->'plannedOperations') IS DISTINCT FROM 'array'
 THEN RETURN false; END IF;
 SELECT x INTO operation FROM jsonb_array_elements(metadata->'azureFilesInventory'->'plannedOperations') x
  WHERE x->>'step'=checkpoint->>'step';
 IF operation IS NULL OR event->>'method' IS DISTINCT FROM 'PUT'
  OR event->>'path' IS DISTINCT FROM operation->>'path'
  OR event->>'apiVersion' IS DISTINCT FROM (CASE operation->>'api'
     WHEN 'storage' THEN '2023-05-01' WHEN 'authorization' THEN '2022-04-01' END)
 THEN RETURN false; END IF;
 -- Validate the admitted prefix and planned operation without asserting a
 -- provider observation: this synthetic failure is never retained as a receipt.
 candidate:=jsonb_set(jsonb_set(checkpoint,'{phase}','"observed"'::jsonb),'{completed}',
  (checkpoint->'completed')||jsonb_build_array(jsonb_build_object(
   'step',checkpoint->>'step','ok',false,'status',0)));
 RETURN public.valid_erasure_azure_files_upgrade_observation(jsonb_build_object(
  'ownerId',owner_id,'hushhId',agent.hushh_id,'registrySnapshot',to_jsonb(agent)),candidate);
END $$;

CREATE OR REPLACE FUNCTION public.byoc_azure_live_worker_admitted(
 owner_id text, expected_job text, allow_unbound boolean DEFAULT false
) RETURNS boolean LANGUAGE sql STABLE SET search_path=public AS $$
 SELECT coalesce((SELECT public.byoc_azure_intent_admitted(r,j,
   (SELECT x->'intent' FROM jsonb_array_elements(j.stages) x WHERE x->>'stage'='azure_setup_intent'),
   allow_unbound)
 FROM public.personal_agent_registry r JOIN public.byoc_setup_jobs j ON j.user_id=r.user_id
 WHERE r.user_id=owner_id AND j.job_id=expected_job),false);
$$;

CREATE OR REPLACE FUNCTION public.retain_byoc_azure_setup_intent(
  owner_id text, expected_job text, intent jsonb
) RETURNS boolean LANGUAGE plpgsql VOLATILE SET search_path=public AS $$
DECLARE agent public.personal_agent_registry%ROWTYPE;
 job public.byoc_setup_jobs%ROWTYPE; previous jsonb; matches integer;
BEGIN
 IF public.byoc_azure_setup_guards_ready() IS NOT TRUE THEN RETURN false; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 SELECT * INTO agent FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT * INTO job FROM public.byoc_setup_jobs WHERE user_id=owner_id FOR UPDATE;
 IF NOT FOUND OR job.job_id IS DISTINCT FROM expected_job OR job.status <> 'running'
    OR jsonb_typeof(job.stages) IS DISTINCT FROM 'array'
    OR public.valid_byoc_azure_setup_intent(owner_id,expected_job,job.project_id,
      agent.hushh_id,intent) IS NOT TRUE
    OR public.byoc_azure_intent_admitted(agent,job,intent) IS NOT TRUE THEN RETURN false; END IF;
 PERFORM public.assert_project_grant_admission(job.project_id);
 SELECT count(*), (jsonb_agg(s->'intent'))->0 INTO matches, previous
   FROM jsonb_array_elements(job.stages) s WHERE s->>'stage'='azure_setup_intent';
 IF matches > 0 THEN RETURN matches=1 AND previous=intent; END IF;
 IF jsonb_array_length(job.stages) >= 2048 OR (SELECT count(*)
   FROM jsonb_array_elements(job.stages) x
   WHERE x->>'stage' IN ('azure_setup_intent','azure_setup_prior_intent')) >= 64
 THEN RETURN false; END IF;
 UPDATE public.byoc_setup_jobs SET stages=stages || jsonb_build_array(
   jsonb_build_object('stage','azure_setup_intent','intent',intent)), updated_at=now()
 WHERE user_id=owner_id AND job_id=expected_job AND status='running';
 RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.byoc_azure_worker_admitted(
  owner_id text, expected_job text
) RETURNS boolean LANGUAGE plpgsql VOLATILE SET search_path=public AS $$
DECLARE agent public.personal_agent_registry%ROWTYPE;
 job public.byoc_setup_jobs%ROWTYPE; intent jsonb; matches integer;
BEGIN
 IF public.byoc_azure_setup_guards_ready() IS NOT TRUE THEN RETURN false; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 SELECT * INTO agent FROM public.personal_agent_registry WHERE user_id=owner_id;
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT * INTO job FROM public.byoc_setup_jobs WHERE user_id=owner_id;
 IF NOT FOUND OR job.job_id IS DISTINCT FROM expected_job OR job.status <> 'running'
    OR jsonb_typeof(job.stages) IS DISTINCT FROM 'array'
 THEN RETURN false; END IF;
 SELECT count(*), (jsonb_agg(s->'intent'))->0 INTO matches, intent
   FROM jsonb_array_elements(job.stages) s WHERE s->>'stage'='azure_setup_intent';
 RETURN matches=1 AND public.byoc_azure_intent_admitted(agent,job,intent) IS TRUE;
END;
$$;

-- Session-scoped local worker identity. Its release does not prove provider drain.
CREATE OR REPLACE FUNCTION public.byoc_azure_worker_session_held(owner_id text)
RETURNS boolean LANGUAGE sql STABLE SET search_path=public AS $$
 SELECT EXISTS (SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory'
   AND granted AND mode='ExclusiveLock' AND objsubid=1
   AND classid=((hashtextextended(owner_id,206)>>32)&4294967295)::oid
   AND objid=(hashtextextended(owner_id,206)&4294967295)::oid);
$$;

-- Reserve completion and exit slots BEFORE admitting a cloud write. Ordinary
-- stage updates must not consume the budget already owed to in-flight work.
CREATE OR REPLACE FUNCTION public.byoc_azure_worker_history_has_capacity(history jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=public AS $$
 WITH events AS (SELECT value e FROM jsonb_array_elements(history)), pending AS (
   SELECT request.e, EXISTS(SELECT 1 FROM events ack WHERE ack.e->>'stage'='azure_provider_ack'
     AND ack.e->>'requestId'=request.e->>'requestId') acknowledged
   FROM events request WHERE request.e->>'stage'='azure_provider_request'
    AND NOT EXISTS(SELECT 1 FROM events terminal WHERE terminal.e->>'stage'='azure_provider_terminal'
      AND terminal.e->>'requestId'=request.e->>'requestId')
 ), active AS (
   SELECT count(*) n FROM events worker WHERE worker.e->>'stage'='azure_worker_started'
    AND NOT EXISTS(SELECT 1 FROM events ended WHERE ended.e->>'stage'='azure_worker_exited'
      AND ended.e->>'executionId'=worker.e->>'executionId')
 ) SELECT jsonb_array_length(history)+(SELECT count(*) FROM pending)
    +(SELECT count(*) FROM pending WHERE NOT acknowledged)+(SELECT n FROM active)<=2048
   AND octet_length(history::text)+(SELECT count(*)*1024 FROM pending)
    +(SELECT count(*)*24576 FROM pending WHERE NOT acknowledged)
    +(SELECT n*512 FROM active)<=1048576;
$$;

-- Shared transport receipt contract; neither setup nor cleanup invents its own.
CREATE OR REPLACE FUNCTION public.valid_azure_arm_acknowledgement(receipt jsonb,target text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=public AS $$
 SELECT (NOT receipt ? 'operationKind' OR receipt->'operationKind'='null'::jsonb
       OR receipt->>'operationKind' IN ('azure-asyncoperation','location'))
    AND receipt ?& ARRAY['status','operationUrl','operationUrlSha256']
    AND jsonb_typeof(receipt->'status')='number' AND (receipt->>'status' ~ '^[2-5][0-9]{2}$') IS TRUE
    AND (receipt->'operationUrlSha256'='null'::jsonb OR (
      jsonb_typeof(receipt->'operationUrlSha256')='string'
      AND receipt->>'operationUrlSha256' ~ '^[0-9a-f]{64}$'))
    AND ((receipt->'operationUrl'='null'::jsonb) OR (
      jsonb_typeof(receipt->'operationUrl')='string'
      AND starts_with(receipt->>'operationUrl','https://management.azure.com/subscriptions/'||
        split_part(target,'/',3)||'/')
      AND receipt->>'operationUrl' ~ '^https://management\.azure\.com/[A-Za-z0-9_./():-]+(\?(api-version=\d{4}-\d{2}-\d{2}(-preview)?|monitor=true)(&(api-version=\d{4}-\d{2}-\d{2}(-preview)?|monitor=true))?)?$'
      AND NOT (receipt->>'operationUrl' ~ '/\.{1,2}(/|\?|$)')
      AND receipt->>'operationUrlSha256'=encode(sha256(convert_to(receipt->>'operationUrl','UTF8')),'hex')));
$$;

CREATE OR REPLACE FUNCTION public.valid_byoc_azure_worker_event(
 owner_id text, expected_job text, event jsonb, history jsonb, target text, hushh_id text
) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=public AS $$
DECLARE kind text:=event->>'stage'; worker jsonb; request jsonb; acknowledgement jsonb;
 intent jsonb; request_id text:=event->>'requestId';
BEGIN
 IF jsonb_typeof(event) IS DISTINCT FROM 'object' OR octet_length(event::text)>24576
 OR jsonb_typeof(event->'jobId') IS DISTINCT FROM 'string'
 OR length(expected_job) NOT BETWEEN 1 AND 128
 OR (target ~ '^/subscriptions/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}/resourceGroups/[A-Za-z0-9_().-]{0,89}[A-Za-z0-9_()-]$') IS NOT TRUE
 OR event->>'jobId' IS DISTINCT FROM expected_job
 OR (event->>'executionId' ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$') IS NOT TRUE
 OR public.byoc_azure_worker_session_held(owner_id) IS NOT TRUE THEN RETURN false; END IF;
 SELECT x INTO worker FROM jsonb_array_elements(history) x
 WHERE x->>'stage'='azure_worker_started' AND x->>'executionId'=event->>'executionId';
 IF kind IN ('azure_worker_started','azure_provider_request') AND
   public.byoc_azure_live_worker_admitted(owner_id,expected_job,kind='azure_worker_started') IS NOT TRUE
 THEN RETURN false; END IF;
 IF kind='azure_worker_started' THEN
   RETURN worker IS NULL AND event-ARRAY['stage','jobId','executionId','backendPid']='{}'::jsonb
    AND event->'backendPid'=to_jsonb(pg_backend_pid())
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(history) pending_request
      WHERE pending_request->>'stage'='azure_provider_request' AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(history) terminal
       WHERE terminal->>'stage'='azure_provider_terminal'
       AND terminal->>'requestId'=pending_request->>'requestId'))
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(history) started
      WHERE started->>'stage'='azure_worker_started' AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(history) ended WHERE ended->>'stage'='azure_worker_exited'
       AND ended->>'executionId'=started->>'executionId'));
 END IF;
 IF worker IS NULL OR worker->>'jobId' IS DISTINCT FROM expected_job
 OR worker->'backendPid' IS DISTINCT FROM to_jsonb(pg_backend_pid())
 OR EXISTS (SELECT 1 FROM jsonb_array_elements(history) ended
   WHERE ended->>'stage'='azure_worker_exited' AND ended->>'executionId'=event->>'executionId')
 THEN RETURN false; END IF;
 IF kind='azure_worker_exited' THEN
   RETURN event-ARRAY['stage','jobId','executionId']='{}'::jsonb;
 END IF;
 IF (request_id ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$') IS NOT TRUE
 THEN RETURN false; END IF;
 SELECT x INTO request FROM jsonb_array_elements(history) x
 WHERE x->>'stage'='azure_provider_request' AND x->>'requestId'=request_id;
 IF kind='azure_provider_request' THEN
   SELECT x->'intent' INTO intent FROM jsonb_array_elements(history) x
     WHERE x->>'stage'='azure_setup_intent';
   RETURN request IS NULL AND public.valid_byoc_azure_setup_intent(
      owner_id,expected_job,target,hushh_id,intent) IS TRUE
    AND event-ARRAY['stage','jobId','executionId','requestId','method','path','apiVersion','purpose']='{}'::jsonb
    AND event->>'method' IN ('PUT','POST')
    AND (event->>'apiVersion' ~ '^\d{4}-\d{2}-\d{2}(-preview)?$') IS TRUE
    AND ((intent->'version'='2'::jsonb AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(intent->'allowedRequests') call
      WHERE call=event-ARRAY['stage','jobId','executionId','requestId']))
     OR (intent->'version'='1'::jsonb AND event->>'purpose' IN (
      'creating_resource_group','registering_providers','creating_identity','creating_key_vault',
      'creating_storage','creating_registry','creating_model','creating_environment',
      'assigning_roles','importing_image','deploying_agent')))
    AND (event->>'purpose'<>'files_activation' OR
      public.byoc_azure_files_request_admitted(owner_id,event) IS TRUE)
    AND length(event->>'path') BETWEEN 1 AND 2048
    AND (event->>'path' ~ '^[A-Za-z0-9_./()@:-]+$') IS TRUE
    AND position('..' IN event->>'path')=0
    AND (event->>'path'=target OR starts_with(event->>'path',target||'/')
      OR (event->>'method'='POST' AND event->>'purpose'='registering_providers'
       AND event->>'path'=ANY(ARRAY(
        SELECT '/subscriptions/'||(intent->>'subscriptionId')||'/providers/'||p||'/register'
        FROM unnest(ARRAY['Microsoft.App','Microsoft.ManagedIdentity','Microsoft.KeyVault',
         'Microsoft.Storage','Microsoft.ContainerRegistry','Microsoft.CognitiveServices']) p))));
 END IF;
 IF request IS NULL OR request->>'executionId' IS DISTINCT FROM event->>'executionId'
 OR request->>'jobId' IS DISTINCT FROM expected_job THEN RETURN false; END IF;
 IF EXISTS (SELECT 1 FROM jsonb_array_elements(history) x
  WHERE x->>'stage'='azure_provider_terminal' AND x->>'requestId'=request_id)
 THEN RETURN false; END IF;
 SELECT x INTO acknowledgement FROM jsonb_array_elements(history) x
 WHERE x->>'stage'='azure_provider_ack' AND x->>'requestId'=request_id;
 IF kind='azure_provider_ack' THEN
   RETURN acknowledgement IS NULL
    AND event-ARRAY['stage','jobId','executionId','requestId','status','operationUrl','operationUrlSha256','operationKind']='{}'::jsonb
    AND public.valid_azure_arm_acknowledgement(event,target) IS TRUE;
 END IF;
 IF kind='azure_provider_terminal' THEN
   RETURN event-ARRAY['stage','jobId','executionId','requestId','outcome']='{}'::jsonb
    AND ((event->>'outcome'='not_dispatched' AND acknowledgement IS NULL)
     OR (event->>'outcome'='refused' AND acknowledgement->>'status'=ANY(
       ARRAY['400','401','403','404','405','409','412','422','429']))
     OR (event->>'outcome' IN ('succeeded','failed') AND
       (acknowledgement->>'status' ~ '^2[0-9]{2}$') IS TRUE));
 END IF;
 RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.retain_byoc_azure_worker_event(
 owner_id text, expected_job text, event jsonb
) RETURNS boolean LANGUAGE plpgsql VOLATILE SET search_path=public AS $$
DECLARE agent public.personal_agent_registry%ROWTYPE; job public.byoc_setup_jobs%ROWTYPE;
BEGIN
 IF public.byoc_azure_setup_guards_ready() IS NOT TRUE THEN RETURN false; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 SELECT * INTO agent FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT * INTO job FROM public.byoc_setup_jobs WHERE user_id=owner_id FOR UPDATE;
 IF NOT FOUND OR job.job_id IS DISTINCT FROM expected_job
 OR jsonb_typeof(job.stages) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 IF EXISTS (SELECT 1 FROM jsonb_array_elements(job.stages) x WHERE x=event) THEN RETURN true; END IF;
 IF event->>'stage' IN ('azure_worker_started','azure_provider_request') AND
   public.byoc_azure_live_worker_admitted(owner_id,expected_job,event->>'stage'='azure_worker_started') IS NOT TRUE
 THEN RETURN false; END IF;
 IF public.byoc_azure_worker_history_has_capacity(job.stages||jsonb_build_array(event)) IS NOT TRUE
 THEN RETURN false; END IF;
 IF public.valid_byoc_azure_worker_event(owner_id,expected_job,event,job.stages,
    job.project_id,agent.hushh_id) IS NOT TRUE THEN RETURN false; END IF;
 UPDATE public.byoc_setup_jobs SET stages=stages||jsonb_build_array(event),updated_at=now()
 WHERE user_id=owner_id AND job_id=expected_job;
 RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.begin_byoc_azure_worker(
 owner_id text, expected_job text, execution_id text
) RETURNS boolean LANGUAGE plpgsql VOLATILE SET search_path=public AS $$
DECLARE result boolean;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 IF NOT pg_try_advisory_lock(hashtextextended(owner_id,206)) THEN RETURN false; END IF;
 result:=public.retain_byoc_azure_worker_event(owner_id,expected_job,jsonb_build_object(
   'stage','azure_worker_started','jobId',expected_job,'executionId',execution_id,
   'backendPid',pg_backend_pid()));
 IF result IS NOT TRUE THEN PERFORM pg_advisory_unlock(hashtextextended(owner_id,206)); END IF;
 RETURN result;
EXCEPTION WHEN OTHERS THEN
 PERFORM pg_advisory_unlock(hashtextextended(owner_id,206)); RAISE;
END;
$$;

CREATE OR REPLACE FUNCTION public.begin_byoc_azure_worker(
 owner_id text, expected_job text, execution_id text, intent jsonb
) RETURNS boolean LANGUAGE plpgsql VOLATILE SET search_path=public AS $$
DECLARE result boolean;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 IF NOT pg_try_advisory_lock(hashtextextended(owner_id,206)) THEN RETURN false; END IF;
 result:=intent->'version'='2'::jsonb AND
   public.retain_byoc_azure_setup_intent(owner_id,expected_job,intent);
 IF result IS TRUE THEN
   result:=public.retain_byoc_azure_worker_event(owner_id,expected_job,jsonb_build_object(
    'stage','azure_worker_started','jobId',expected_job,'executionId',execution_id,
    'backendPid',pg_backend_pid()));
 END IF;
 IF result IS NOT TRUE THEN PERFORM pg_advisory_unlock(hashtextextended(owner_id,206)); END IF;
 RETURN result;
EXCEPTION WHEN OTHERS THEN
 PERFORM pg_advisory_unlock(hashtextextended(owner_id,206)); RAISE;
END $$;

-- Azure jobs have no GCP authorization_attempts; their original binding must
-- nevertheless survive a reserved erasure. Worker liveness is not drain proof.
CREATE OR REPLACE FUNCTION public.guard_byoc_azure_erasure_job()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
DECLARE reservation jsonb; owner_id text; previous_target text; item jsonb; history jsonb; agent public.personal_agent_registry%ROWTYPE; old_journal jsonb; new_journal jsonb;
BEGIN
 IF TG_OP='INSERT' THEN owner_id:=NEW.user_id; previous_target:=NEW.project_id;
 ELSE owner_id:=OLD.user_id; previous_target:=OLD.project_id; END IF;
 IF (previous_target LIKE '/subscriptions/%/resourceGroups/%') IS NOT TRUE
   AND (TG_OP='DELETE' OR (NEW.project_id LIKE '/subscriptions/%/resourceGroups/%') IS NOT TRUE)
 THEN
   IF TG_OP='DELETE' THEN RETURN OLD; END IF;
   RETURN NEW;
 END IF;
 IF TG_OP='UPDATE' AND NEW.user_id IS DISTINCT FROM OLD.user_id
 THEN RAISE EXCEPTION 'Azure setup owner is immutable' USING ERRCODE='42501'; END IF;
 -- A raw UPDATE already holds its job row. Never block on owner locks in that
 -- inverted order; refuse and retry under the normal owner-first entrypoint.
 IF NOT pg_try_advisory_xact_lock(hashtextextended(owner_id,171))
   OR NOT pg_try_advisory_xact_lock(hashtextextended(owner_id,198))
 THEN RAISE EXCEPTION 'Azure setup admission is busy' USING ERRCODE='42501'; END IF;
 SELECT * INTO agent FROM public.personal_agent_registry WHERE user_id=owner_id;
 reservation:=agent.backend_metadata->'erasure';
 IF TG_OP='UPDATE' THEN
   IF jsonb_typeof(NEW.stages) IS DISTINCT FROM 'array'
      OR public.byoc_azure_worker_history_has_capacity(NEW.stages) IS NOT TRUE
   THEN RAISE EXCEPTION 'Azure setup recovery requires reconciliation' USING ERRCODE='42501'; END IF;
   IF NEW.job_id=OLD.job_id THEN
    SELECT coalesce(jsonb_agg(x),'[]'::jsonb) INTO old_journal FROM jsonb_array_elements(OLD.stages) x
     WHERE x->>'stage' IN ('azure_worker_started','azure_worker_exited','azure_provider_request',
       'azure_provider_ack','azure_provider_terminal');
    SELECT coalesce(jsonb_agg(x),'[]'::jsonb) INTO new_journal FROM jsonb_array_elements(NEW.stages) x
     WHERE x->>'stage' IN ('azure_worker_started','azure_worker_exited','azure_provider_request',
       'azure_provider_ack','azure_provider_terminal');
    IF jsonb_array_length(new_journal)<jsonb_array_length(old_journal)
     OR jsonb_array_length(new_journal)>jsonb_array_length(old_journal)+1
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(old_journal) WITH ORDINALITY entry(value,n)
       WHERE new_journal->((n-1)::integer) IS DISTINCT FROM entry.value)
    THEN RAISE EXCEPTION 'Azure worker history is immutable' USING ERRCODE='42501'; END IF;
    IF jsonb_array_length(new_journal)>jsonb_array_length(old_journal)
      AND public.valid_byoc_azure_worker_event(owner_id,OLD.job_id,new_journal->-1,OLD.stages,
        OLD.project_id,agent.hushh_id) IS NOT TRUE
    THEN RAISE EXCEPTION 'Azure worker receipt refused' USING ERRCODE='42501'; END IF;
   END IF;
 END IF;
 IF reservation IS NULL THEN
   IF TG_OP='INSERT' THEN
     IF EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.stages) x
       WHERE x->>'stage' IN ('azure_setup_intent','azure_setup_prior_intent','azure_worker_started',
       'azure_worker_exited','azure_provider_request','azure_provider_ack','azure_provider_terminal'))
     THEN RAISE EXCEPTION 'Azure setup binding admission required' USING ERRCODE='42501'; END IF;
     RETURN NEW;
   END IF;
   SELECT coalesce(jsonb_agg(x),'[]'::jsonb) INTO history
     FROM jsonb_array_elements(OLD.stages) x
     WHERE x->>'stage' IN ('azure_setup_intent','azure_setup_prior_intent','azure_worker_started',
       'azure_worker_exited','azure_provider_request','azure_provider_ack','azure_provider_terminal');
   IF history='[]'::jsonb THEN
     IF TG_OP='DELETE' THEN RETURN OLD; END IF;
     RETURN NEW;
   END IF;
   -- An early eligibility refusal made only reads. Keep the journal unless
   -- 962 independently proves every worker exited and no ARM request existed.
   IF TG_OP='DELETE' THEN
    IF to_regprocedure('public.azure_setup_no_effects(text)') IS NOT NULL THEN
     IF pg_try_advisory_xact_lock(hashtextextended(owner_id,206))
      AND public.azure_setup_no_effects(owner_id) IS TRUE THEN RETURN OLD; END IF;
    END IF;
   END IF;
   IF TG_OP='DELETE' OR NEW.project_id IS DISTINCT FROM OLD.project_id
   THEN RAISE EXCEPTION 'Azure setup recovery retained' USING ERRCODE='42501'; END IF;
   IF NEW.job_id IS DISTINCT FROM OLD.job_id THEN
     IF OLD.status='running' THEN
       RAISE EXCEPTION 'Azure setup worker reconciliation required' USING ERRCODE='42501';
     END IF;
     IF EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.stages) x
       WHERE x->>'stage' IN ('azure_setup_intent','azure_setup_prior_intent','azure_worker_started',
       'azure_worker_exited','azure_provider_request','azure_provider_ack','azure_provider_terminal'))
     THEN RAISE EXCEPTION 'Azure retry binding must be retained by admission' USING ERRCODE='42501'; END IF;
     FOR item IN SELECT value FROM jsonb_array_elements(history) LOOP
       NEW.stages:=NEW.stages||jsonb_build_array(CASE WHEN item->>'stage'='azure_setup_intent'
        THEN jsonb_set(item,'{stage}','"azure_setup_prior_intent"'::jsonb) ELSE item END);
     END LOOP;
   ELSE
     FOR item IN SELECT value FROM jsonb_array_elements(history) LOOP
       IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.stages) x WHERE x=item)
       THEN RAISE EXCEPTION 'Azure setup recovery immutable' USING ERRCODE='42501'; END IF;
     END LOOP;
   END IF;
   IF NEW.stages IS DISTINCT FROM OLD.stages AND (
     (SELECT count(*) FROM jsonb_array_elements(NEW.stages) x
       WHERE x->>'stage' IN ('azure_setup_intent','azure_setup_prior_intent'))>64
     OR jsonb_array_length(NEW.stages)>2048 OR octet_length(NEW.stages::text)>1048576)
   THEN RAISE EXCEPTION 'Azure setup recovery requires reconciliation' USING ERRCODE='42501'; END IF;
   RETURN NEW;
 END IF;
 -- Existing admitted writes may report their actual outcome after erasure fences new work.
 IF TG_OP='UPDATE' AND to_jsonb(NEW)-ARRAY['stages','updated_at'] =
      to_jsonb(OLD)-ARRAY['stages','updated_at']
  AND jsonb_array_length(NEW.stages)=jsonb_array_length(OLD.stages)+1
  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(OLD.stages) WITH ORDINALITY old_item(value,n)
    WHERE NEW.stages->((n-1)::integer) IS DISTINCT FROM old_item.value)
  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.stages) WITH ORDINALITY added(value,n)
    WHERE n>jsonb_array_length(OLD.stages)
     AND (jsonb_typeof(added.value) IS DISTINCT FROM 'object' OR
       (added.value->>'stage' IN ('azure_provider_ack','azure_provider_terminal','azure_worker_exited')) IS NOT TRUE))
 THEN RETURN NEW; END IF;
 IF TG_OP='DELETE' AND public.personal_agent_erasure_archived(owner_id,reservation) IS TRUE
 THEN RETURN OLD; END IF;
 IF TG_OP='UPDATE'
   AND to_jsonb(NEW)-ARRAY['status','error_code','error_message','updated_at'] =
       to_jsonb(OLD)-ARRAY['status','error_code','error_message','updated_at']
   AND (NEW.status=OLD.status OR (OLD.status='running' AND NEW.status='failed'))
 THEN RETURN NEW; END IF;
 RAISE EXCEPTION 'Azure setup is fenced for erasure' USING ERRCODE='42501';
END;
$$;
DROP TRIGGER IF EXISTS zw_byoc_azure_erasure ON public.byoc_setup_jobs;
CREATE TRIGGER zw_byoc_azure_erasure BEFORE INSERT OR UPDATE OR DELETE ON public.byoc_setup_jobs
FOR EACH ROW EXECUTE FUNCTION public.guard_byoc_azure_erasure_job();

CREATE OR REPLACE FUNCTION public.byoc_azure_setup_guards_ready()
RETURNS boolean LANGUAGE sql STABLE SET search_path=public AS $$
 SELECT count(*)=2 FROM pg_trigger WHERE tgenabled IN ('O','A') AND tgnargs=0
 AND tgqual IS NULL AND (
   (tgrelid='public.byoc_setup_jobs'::regclass AND tgname='zw_byoc_azure_erasure'
    AND tgfoid='public.guard_byoc_azure_erasure_job()'::regprocedure AND tgtype=31)
   OR (tgrelid='public.personal_agent_registry'::regclass
    AND tgname='zz_personal_agent_erasure_registry'
    AND tgfoid='public.guard_personal_agent_erasure_registry()'::regprocedure AND tgtype=27));
$$;

COMMIT;
