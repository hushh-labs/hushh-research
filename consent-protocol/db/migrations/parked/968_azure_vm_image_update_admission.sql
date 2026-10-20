-- Dev only. Extend the existing setup journal for one exact VM image update.
-- No host migration, standing permission, executor or new mutation ledger.
-- Unknown provider outcomes remain fenced; this does not authorize replay.
BEGIN;

CREATE OR REPLACE FUNCTION public.azure_vm_upgrade_registry_binding(agent jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
 SELECT jsonb_build_object(
  'user_id',agent->'user_id','hushh_id',agent->'hushh_id','backend',agent->'backend',
  'external_agent_id',agent->'external_agent_id','deployment_target',agent->'deployment_target',
  'pod_pubkey',agent->'pod_pubkey','pod_key_id',agent->'pod_key_id',
  'model_credential_mode',agent->'model_credential_mode','placement_epoch',agent->'placement_epoch',
  'pod_signing_key_id',agent->'pod_signing_key_id','pod_signing_pubkey',agent->'pod_signing_pubkey',
  'serviceUid',agent->'backend_metadata'->'serviceUid',
  'setupNonce',agent->'backend_metadata'->'setupNonce',
  'runtime_principal_id',agent->'backend_metadata'->'runtime_principal_id',
  'runtime_client_id',agent->'backend_metadata'->'runtime_client_id',
  'image',agent->'backend_metadata'->'image','image_digest',agent->'backend_metadata'->'image_digest',
  'hostKind',agent->'backend_metadata'->'hostKind','vmHost',agent->'backend_metadata'->'vmHost',
  'url',agent->'backend_metadata'->'url',
  'vmConfigurationSha256',agent->'backend_metadata'->'vmConfigurationSha256',
  'vmUpdateModuleSha256',agent->'backend_metadata'->'vmUpdateModuleSha256',
  'vmPower',CASE WHEN jsonb_typeof(agent->'backend_metadata'->'vmPower')='object' THEN
   jsonb_build_object('operationId',agent->'backend_metadata'->'vmPower'->'operationId',
    'phase',agent->'backend_metadata'->'vmPower'->'phase',
    'binding',agent->'backend_metadata'->'vmPower'->'binding') ELSE 'null'::jsonb END);
$$;

CREATE OR REPLACE FUNCTION public.valid_pod_upgrade_cursor(cursor_value jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
 IF jsonb_typeof(cursor_value) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 RETURN coalesce(cursor_value-ARRAY['seq','sha']='{}'::jsonb
  AND jsonb_typeof(cursor_value->'seq')='number'
  AND cursor_value->>'seq' ~ '^[1-9][0-9]{0,18}$'
  AND jsonb_typeof(cursor_value->'sha')='string'
  AND cursor_value->>'sha' ~ '^[a-f0-9]{64}$',false);
END;
$$;

CREATE OR REPLACE FUNCTION public.valid_byoc_azure_vm_upgrade_intent(
 owner_id text, job_id text, target text, hushh_id text, intent jsonb
) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $$
DECLARE extra text[]:=ARRAY['kind','binding','sourceImage','allowedRequests','attemptId',
 'operationId','releaseId','idempotencyKey','capabilityPlanDigest','idleRecord','hostRequestSha256'];
 binding jsonb:=intent->'binding'; host jsonb:=binding->'vmHost';
 vm text:=host->'installation'->>'resource_id'; registry text; call jsonb; expected jsonb;
BEGIN
 IF jsonb_typeof(intent) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 IF intent->'version' IS DISTINCT FROM '3'::jsonb OR intent->>'kind' IS DISTINCT FROM 'vm_upgrade'
 OR intent->'capabilityPlanDigest' IS DISTINCT FROM 'null'::jsonb
 OR public.valid_byoc_azure_setup_intent(owner_id,job_id,target,hushh_id,
   jsonb_set(intent-extra,'{version}','1'::jsonb)) IS NOT TRUE
 OR NOT intent ?& extra OR octet_length(intent::text)>32768
 OR jsonb_typeof(binding) IS DISTINCT FROM 'object'
 OR binding->>'hostKind' IS DISTINCT FROM 'azure_vm'
 OR starts_with(vm,target||'/providers/Microsoft.Compute/virtualMachines/') IS NOT TRUE
 OR (substring(vm FROM length(target||'/providers/Microsoft.Compute/virtualMachines/')+1)
   ~ '^[A-Za-z0-9_-]{1,64}$') IS NOT TRUE
 OR binding->>'external_agent_id' IS DISTINCT FROM vm
 OR host->'installation'->>'hushh_id' IS DISTINCT FROM hushh_id
 OR host->'installation'->>'generation' IS DISTINCT FROM binding->>'serviceUid'
 OR binding->>'image_digest' IS DISTINCT FROM host->'installation'->>'image_digest'
 OR (binding->>'image' ~ '^[a-z0-9]{5,50}[.]azurecr[.]io/pod@sha256:[a-f0-9]{64}$') IS NOT TRUE
 OR right(binding->>'image',71) IS DISTINCT FROM binding->>'image_digest'
 OR (intent->>'sourceImage' ~ '^[A-Za-z0-9./_:-]+@sha256:[a-f0-9]{64}$') IS NOT TRUE
 OR (intent->>'attemptId' ~ '^[a-f0-9]{64}$') IS NOT TRUE
 OR EXISTS(SELECT 1 FROM unnest(ARRAY['operationId','releaseId','idempotencyKey']) k
   WHERE jsonb_typeof(intent->k) IS DISTINCT FROM 'string' OR length(intent->>k) NOT BETWEEN 1 AND 256)
 OR (intent->>'hostRequestSha256' ~ '^[a-f0-9]{64}$') IS NOT TRUE
 OR public.valid_pod_upgrade_cursor(intent->'idleRecord') IS NOT TRUE
 OR EXISTS(SELECT 1 FROM unnest(ARRAY['vmConfigurationSha256','vmUpdateModuleSha256']) k
   WHERE (binding->>k ~ '^[a-f0-9]{64}$') IS NOT TRUE)
 OR jsonb_typeof(intent->'allowedRequests') IS DISTINCT FROM 'array'
 THEN RETURN false; END IF;
 IF jsonb_array_length(intent->'allowedRequests')<>3 THEN RETURN false; END IF;
 registry:=target||'/providers/Microsoft.ContainerRegistry/registries/'||split_part(binding->>'image','.',1);
 FOR n IN 0..2 LOOP
  call:=intent->'allowedRequests'->n;
  IF jsonb_typeof(call) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  expected:=CASE n
   WHEN 0 THEN jsonb_build_object('method','POST','path',registry||'/importImage',
     'apiVersion','2023-07-01','purpose','vm_image_import')
   WHEN 1 THEN jsonb_build_object('method','POST','path',vm||'/runCommand',
     'apiVersion','2024-03-01','purpose','vm_image_replace')
   ELSE jsonb_build_object('method','PATCH','path',vm||'/providers/Microsoft.Resources/tags/default',
     'apiVersion','2021-04-01','purpose','vm_image_tag') END;
  IF call-'bodySha256' IS DISTINCT FROM expected
   OR jsonb_typeof(call->'bodySha256') IS DISTINCT FROM 'string'
   OR (call->>'bodySha256' ~ '^[a-f0-9]{64}$') IS NOT TRUE THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.byoc_azure_vm_upgrade_admitted(
 agent public.personal_agent_registry, job public.byoc_setup_jobs, intent jsonb
) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=public AS $$
DECLARE metadata jsonb:=agent.backend_metadata; approval jsonb:=metadata->'upgradeApproval';
 cursor_value jsonb:=approval->'handoffCommittedCursor'; marker jsonb:=approval->'handoffIdleRecord';
 host jsonb:=metadata->'vmHost'; installation jsonb:=host->'installation';
BEGIN
 IF jsonb_typeof(job.stages) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 IF agent.user_id IS DISTINCT FROM job.user_id OR job.status IS DISTINCT FROM 'running'
 OR agent.user_cloud_authorized_at IS NULL
 OR agent.status IS DISTINCT FROM 'provisioned' OR agent.backend IS DISTINCT FROM 'user_azure'
 OR agent.deployment_target IS DISTINCT FROM 'user_azure'
 OR nullif(agent.user_cloud_project,'') IS NOT NULL OR metadata ? 'erasure'
 OR public.valid_byoc_azure_vm_upgrade_intent(agent.user_id,job.job_id,job.project_id,
   agent.hushh_id,intent) IS NOT TRUE
 OR intent->'binding' IS DISTINCT FROM public.azure_vm_upgrade_registry_binding(to_jsonb(agent))
 OR agent.user_cloud_tenant_id IS DISTINCT FROM intent->>'tenantId'
 OR agent.user_cloud_subscription_id IS DISTINCT FROM intent->>'subscriptionId'
 OR agent.user_cloud_resource_group IS DISTINCT FROM intent->>'resourceGroup'
 OR agent.user_cloud_region IS DISTINCT FROM intent->>'location'
 OR host->>'location' IS DISTINCT FROM agent.user_cloud_region
 OR metadata->>'setupNonce' IS DISTINCT FROM intent->>'setupNonce'
 OR host->>'principalId' IS DISTINCT FROM metadata->>'runtime_principal_id'
 OR installation->>'client_id' IS DISTINCT FROM metadata->>'runtime_client_id'
 OR EXISTS(SELECT 1 FROM unnest(ARRAY['serviceUid','runtime_principal_id','runtime_client_id']) k
   WHERE coalesce(metadata->>k,'')='')
 OR coalesce(agent.pod_key_id,'')='' OR coalesce(agent.pod_pubkey,'')=''
 OR coalesce(agent.pod_signing_key_id,'')='' OR coalesce(agent.pod_signing_pubkey,'')=''
 OR jsonb_typeof(to_jsonb(agent.placement_epoch)) IS DISTINCT FROM 'number' OR agent.placement_epoch<0
 OR public.azure_vm_power_pending(metadata) IS TRUE
 -- A setup retry may archive a completed journal, but cannot install this
 -- durable owner operation again under a new job/worker identifier.
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(job.stages) h
   WHERE h->>'stage' IN ('azure_setup_intent','azure_setup_prior_intent')
   AND h->'intent'->'version'='3'::jsonb
   AND h->'intent'->>'operationId'=intent->>'operationId'
   AND h->'intent'->>'jobId' IS DISTINCT FROM job.job_id)
 OR EXISTS(SELECT 1 FROM personal_agent_deletion_tombstones WHERE hushh_id=agent.hushh_id)
 OR EXISTS(SELECT 1 FROM account_deletion_tombstones WHERE cleanup_intent_kind='full_account'
   AND user_id_hash='sha256:'||encode(sha256(convert_to(agent.user_id,'UTF8')),'hex'))
 OR EXISTS(SELECT 1 FROM pod_migration_jobs WHERE user_id=agent.user_id)
 OR EXISTS(SELECT 1 FROM personal_agent_standby_placements WHERE user_id=agent.user_id)
 OR coalesce(metadata->>'upgradeLease','')=''
 OR intent->>'attemptId' IS DISTINCT FROM encode(sha256(convert_to(metadata->>'upgradeLease','UTF8')),'hex')
 OR approval->'version' IS DISTINCT FROM '1'::jsonb
 OR approval->>'ownerId' IS DISTINCT FROM agent.user_id OR approval->>'hushhId' IS DISTINCT FROM agent.hushh_id
 OR approval->>'podIncarnation' IS DISTINCT FROM metadata->>'serviceUid'
 OR (approval->>'status' IN ('approved','scheduled','updating')) IS NOT TRUE
 OR approval->>'targetImage' IS DISTINCT FROM intent->>'sourceImage'
 OR approval->>'operationId' IS DISTINCT FROM intent->>'operationId'
 OR approval->>'releaseId' IS DISTINCT FROM intent->>'releaseId'
 OR approval->>'idempotencyKey' IS DISTINCT FROM intent->>'idempotencyKey'
 OR coalesce(approval->'capabilityPlanDigest','null'::jsonb)<>'null'::jsonb
 OR approval->>'handoffIncarnation' IS DISTINCT FROM metadata->>'serviceUid'
 OR (approval->>'handoffRuntimeEpoch' ~ '^[A-Za-z0-9_-]+$') IS NOT TRUE
 OR length(approval->>'handoffRuntimeEpoch')>256
 OR marker IS DISTINCT FROM intent->'idleRecord'
 OR public.valid_pod_upgrade_cursor(cursor_value) IS NOT TRUE
 OR public.valid_pod_upgrade_cursor(marker) IS NOT TRUE
 THEN RETURN false; END IF;
 RETURN (marker->>'seq')::numeric>(cursor_value->>'seq')::numeric
  AND approval->>'handoffCommittedState'=encode(sha256(convert_to(
    (intent->>'operationId')||'|'||(approval->>'handoffIncarnation')||'|'||
    (cursor_value->>'seq')||'|'||(cursor_value->>'sha')||'|active=0','UTF8')),'hex');
END;
$$;

-- A v3 request is sequential and cannot duplicate an admitted/uncertain effect.
-- Only a proven local not_dispatched receipt permits another dispatch attempt.
CREATE OR REPLACE FUNCTION public.byoc_azure_vm_upgrade_request_ready(
 intent jsonb, event jsonb, history jsonb
) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $$
DECLARE call jsonb; previous jsonb; index_value integer;
BEGIN
 SELECT value,ordinality::integer-1 INTO call,index_value
 FROM jsonb_array_elements(intent->'allowedRequests') WITH ORDINALITY
 WHERE value=event-ARRAY['stage','jobId','executionId','requestId'];
 IF call IS NULL THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(history) r
   WHERE r->>'stage'='azure_provider_request' AND r->>'jobId'=intent->>'jobId'
   AND r->>'purpose'=call->>'purpose'
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(history) t
     WHERE t->>'stage'='azure_provider_terminal' AND t->>'requestId'=r->>'requestId'
     AND t->>'outcome'='not_dispatched')) THEN RETURN false; END IF;
 IF index_value=0 THEN RETURN true; END IF;
 FOR n IN 0..index_value-1 LOOP
  previous:=intent->'allowedRequests'->n;
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(history) r
    JOIN jsonb_array_elements(history) t ON t->>'requestId'=r->>'requestId'
    WHERE r->>'stage'='azure_provider_request' AND r->>'jobId'=intent->>'jobId'
    AND r->>'purpose'=previous->>'purpose'
    AND t->>'stage'='azure_provider_terminal' AND t->>'outcome'='succeeded')
  THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END;
$$;

-- The following original entrypoints keep their OIDs and legacy behavior.
-- Their new branches delegate only v3 requests to the bounded VM contracts above.
CREATE OR REPLACE FUNCTION public.valid_byoc_azure_setup_intent(
  owner_id text, job_id text, target text, hushh_id text, intent jsonb
) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $$
BEGIN
 IF intent->'version'='3'::jsonb THEN
  RETURN public.valid_byoc_azure_vm_upgrade_intent(owner_id,job_id,target,hushh_id,intent);
 END IF;
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

CREATE OR REPLACE FUNCTION public.byoc_azure_intent_admitted(
 agent public.personal_agent_registry, job public.byoc_setup_jobs, intent jsonb,
 allow_unbound boolean DEFAULT false
) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=public AS $$
DECLARE metadata jsonb:=coalesce(agent.backend_metadata,'{}'::jsonb);
 approval jsonb:=metadata->'upgradeApproval'; binding jsonb;
BEGIN
 IF intent->'version'='3'::jsonb THEN
  RETURN public.byoc_azure_vm_upgrade_admitted(agent,job,intent);
 END IF;
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
    AND event-(ARRAY['stage','jobId','executionId','requestId','method','path','apiVersion','purpose']||
      CASE WHEN intent->'version'='3'::jsonb THEN ARRAY['bodySha256'] ELSE ARRAY[]::text[] END)='{}'::jsonb
    AND (event->>'method' IN ('PUT','POST') OR (intent->'version'='3'::jsonb AND event->>'method'='PATCH'))
    AND (event->>'apiVersion' ~ '^\d{4}-\d{2}-\d{2}(-preview)?$') IS TRUE
    AND ((intent->'version'='3'::jsonb AND public.byoc_azure_vm_upgrade_request_ready(intent,event,history))
     OR (intent->'version'='2'::jsonb AND EXISTS (
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

CREATE OR REPLACE FUNCTION public.begin_byoc_azure_worker(
 owner_id text, expected_job text, execution_id text, intent jsonb
) RETURNS boolean LANGUAGE plpgsql VOLATILE SET search_path=public AS $$
DECLARE result boolean;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 IF NOT pg_try_advisory_lock(hashtextextended(owner_id,206)) THEN RETURN false; END IF;
 result:=intent->'version' IN ('2'::jsonb,'3'::jsonb) AND
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

-- Rollback is application refusal; retained exact mutation obligations survive.
-- Publication follows joined worker exit, not an active mutation session. Only
-- the existing immutable intent/request journal can prove provider settlement.
CREATE OR REPLACE FUNCTION public.azure_vm_upgrade_dispatch_settled(intent jsonb,history jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $$
DECLARE call jsonb; matched integer;
BEGIN
 IF jsonb_typeof(history) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(history) r
   WHERE r->>'jobId'=intent->>'jobId' AND (
    (r->>'stage'='azure_worker_started' AND NOT EXISTS(
      SELECT 1 FROM jsonb_array_elements(history) e WHERE e->>'stage'='azure_worker_exited'
      AND e->>'jobId'=r->>'jobId' AND e->>'executionId'=r->>'executionId'))
    OR (r->>'stage'='azure_provider_request' AND NOT EXISTS(
      SELECT 1 FROM jsonb_array_elements(history) t WHERE t->>'stage'='azure_provider_terminal'
      AND t->>'jobId'=r->>'jobId' AND t->>'executionId'=r->>'executionId'
      AND t->>'requestId'=r->>'requestId' AND t->>'outcome' IN ('succeeded','not_dispatched')))))
 THEN RETURN false; END IF;
 FOR call IN SELECT value FROM jsonb_array_elements(intent->'allowedRequests') LOOP
  SELECT count(*) INTO matched FROM jsonb_array_elements(history) r
  WHERE r->>'stage'='azure_provider_request' AND r->>'jobId'=intent->>'jobId'
   AND r-ARRAY['stage','jobId','executionId','requestId']=call
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(history) a WHERE a->>'stage'='azure_provider_ack'
     AND a->>'requestId'=r->>'requestId' AND a->>'executionId'=r->>'executionId'
     AND a->>'jobId'=r->>'jobId' AND (a->>'status')::integer BETWEEN 200 AND 299)
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(history) t WHERE t->>'stage'='azure_provider_terminal'
     AND t->>'requestId'=r->>'requestId' AND t->>'executionId'=r->>'executionId'
     AND t->>'jobId'=r->>'jobId' AND t->>'outcome'='succeeded');
  IF matched<>1 THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.block_unattempted_azure_vm_upgrade(
 owner_id text,job_id text,operation_id text,attempt_id text,expected_binding jsonb
) RETURNS jsonb LANGUAGE plpgsql SET search_path=public AS $$
DECLARE agent public.personal_agent_registry; job public.byoc_setup_jobs; m jsonb; approval jsonb;
BEGIN
 IF NOT pg_try_advisory_xact_lock(hashtextextended(owner_id,171))
 OR NOT pg_try_advisory_xact_lock(hashtextextended(owner_id,198))
 OR NOT pg_try_advisory_xact_lock(hashtextextended(owner_id,206)) THEN RETURN NULL; END IF;
 SELECT * INTO agent FROM personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 SELECT * INTO job FROM byoc_setup_jobs WHERE user_id=owner_id FOR UPDATE;
 m:=agent.backend_metadata; approval:=m->'upgradeApproval';
 IF agent.status IS DISTINCT FROM 'provisioned' OR agent.backend IS DISTINCT FROM 'user_azure'
 OR agent.user_cloud_authorized_at IS NULL
 OR agent.deployment_target IS DISTINCT FROM 'user_azure' OR m->>'hostKind' IS DISTINCT FROM 'azure_vm'
 OR public.azure_vm_upgrade_registry_binding(to_jsonb(agent)) IS DISTINCT FROM expected_binding
 OR m ? 'erasure' OR public.azure_vm_power_pending(m) IS TRUE
 OR EXISTS(SELECT 1 FROM personal_agent_deletion_tombstones WHERE hushh_id=agent.hushh_id)
 OR EXISTS(SELECT 1 FROM account_deletion_tombstones WHERE cleanup_intent_kind='full_account'
   AND user_id_hash='sha256:'||encode(sha256(convert_to(owner_id,'UTF8')),'hex'))
 OR EXISTS(SELECT 1 FROM pod_migration_jobs WHERE user_id=owner_id)
 OR EXISTS(SELECT 1 FROM personal_agent_standby_placements WHERE user_id=owner_id)
 OR job.job_id IS DISTINCT FROM job_id OR job.status IS DISTINCT FROM 'running'
 OR jsonb_typeof(job.stages) IS DISTINCT FROM 'array'
 OR approval->>'operationId' IS DISTINCT FROM operation_id
 OR approval->>'ownerId' IS DISTINCT FROM owner_id OR approval->>'hushhId' IS DISTINCT FROM agent.hushh_id
 OR (approval->>'status' IN ('approved','scheduled','updating','blocked')) IS NOT TRUE
 OR coalesce(m->>'upgradeLease','')=''
 OR encode(sha256(convert_to(m->>'upgradeLease','UTF8')),'hex') IS DISTINCT FROM attempt_id
 -- Unknown older work cannot be declared harmless. The current job, and every
 -- prior use of this operation, must have no possibly-dispatched request.
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(job.stages) r WHERE r->>'stage'='azure_provider_request'
   AND (NOT EXISTS(SELECT 1 FROM jsonb_array_elements(job.stages) t
     WHERE t->>'stage'='azure_provider_terminal' AND t->>'requestId'=r->>'requestId')
    OR ((r->>'jobId'=job_id OR EXISTS(SELECT 1 FROM jsonb_array_elements(job.stages) i
      WHERE i->>'stage' IN ('azure_setup_intent','azure_setup_prior_intent')
      AND i->'intent'->>'operationId'=operation_id AND i->'intent'->>'jobId'=r->>'jobId'))
     AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(job.stages) t
       WHERE t->>'stage'='azure_provider_terminal' AND t->>'requestId'=r->>'requestId'
       AND t->>'outcome'='not_dispatched'))))
 THEN RETURN NULL; END IF;
 UPDATE personal_agent_registry SET backend_metadata=jsonb_set(m,'{upgradeApproval}',
   approval||jsonb_build_object('status','blocked','operationState','blocked',
    'presentationPhase','blocked','failureCode','VM_UPDATE_NOT_DISPATCHED'))
 WHERE user_id=owner_id RETURNING * INTO agent;
 RETURN to_jsonb(agent);
END;
$$;

CREATE OR REPLACE FUNCTION public.azure_vm_upgrade_recovery_intent(agent public.personal_agent_registry)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=public AS $$
DECLARE job public.byoc_setup_jobs; intents jsonb; intent jsonb;
 approval jsonb:=agent.backend_metadata->'upgradeApproval';
BEGIN
 SELECT * INTO job FROM public.byoc_setup_jobs WHERE user_id=agent.user_id;
 IF job IS NULL OR jsonb_typeof(job.stages) IS DISTINCT FROM 'array' THEN RETURN NULL; END IF;
 SELECT jsonb_agg(e->'intent') INTO intents FROM jsonb_array_elements(job.stages) e
 WHERE e->>'stage' IN ('azure_setup_intent','azure_setup_prior_intent')
 AND e->'intent'->'version'='3'::jsonb AND e->'intent'->>'operationId'=approval->>'operationId';
 IF jsonb_array_length(intents) IS DISTINCT FROM 1 THEN RETURN NULL; END IF;
 intent:=intents->0;
 IF agent.status IS DISTINCT FROM 'provisioned' OR agent.backend IS DISTINCT FROM 'user_azure'
 OR agent.deployment_target IS DISTINCT FROM 'user_azure' OR agent.user_cloud_authorized_at IS NULL
 OR agent.backend_metadata ? 'erasure' OR public.azure_vm_power_pending(agent.backend_metadata) IS TRUE
 OR EXISTS(SELECT 1 FROM personal_agent_deletion_tombstones WHERE hushh_id=agent.hushh_id)
 OR EXISTS(SELECT 1 FROM account_deletion_tombstones WHERE cleanup_intent_kind='full_account'
   AND user_id_hash='sha256:'||encode(sha256(convert_to(agent.user_id,'UTF8')),'hex'))
 OR EXISTS(SELECT 1 FROM pod_migration_jobs WHERE user_id=agent.user_id)
 OR EXISTS(SELECT 1 FROM personal_agent_standby_placements WHERE user_id=agent.user_id)
 OR agent.user_cloud_tenant_id IS DISTINCT FROM intent->>'tenantId'
 OR agent.user_cloud_subscription_id IS DISTINCT FROM intent->>'subscriptionId'
 OR agent.user_cloud_resource_group IS DISTINCT FROM intent->>'resourceGroup'
 OR agent.user_cloud_region IS DISTINCT FROM intent->>'location'
 OR (approval->>'status' IN ('approved','scheduled','updating','blocked')) IS NOT TRUE
 OR approval->>'targetImage' IS DISTINCT FROM intent->>'sourceImage'
 OR EXISTS(SELECT 1 FROM unnest(ARRAY['operationId','releaseId','idempotencyKey']) k
   WHERE approval->k IS DISTINCT FROM intent->k)
 OR intent->'binding' IS DISTINCT FROM public.azure_vm_upgrade_registry_binding(to_jsonb(agent))
 OR public.valid_byoc_azure_vm_upgrade_intent(agent.user_id,intent->>'jobId',job.project_id,agent.hushh_id,intent) IS NOT TRUE
 OR intent->>'attemptId' IS DISTINCT FROM encode(sha256(convert_to(agent.backend_metadata->>'upgradeLease','UTF8')),'hex')
 OR public.azure_vm_upgrade_dispatch_settled(intent,job.stages) IS NOT TRUE
 THEN RETURN NULL; END IF;
 RETURN intent;
END;
$$;

CREATE OR REPLACE FUNCTION public.azure_vm_image_publication_proven(
 prior public.personal_agent_registry, incoming public.personal_agent_registry
) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=public AS $$
DECLARE old_m jsonb:=prior.backend_metadata; new_m jsonb:=incoming.backend_metadata;
 approval jsonb:=old_m->'upgradeApproval'; ack jsonb:=old_m->'upgradeAcknowledgement';
 proof jsonb:=new_m->'vmUpdateVerification'; host_ack jsonb:=proof->'host';
 recovery jsonb:=proof->'recovery'; released jsonb:=proof->'released';
 job public.byoc_setup_jobs; intent jsonb; intents jsonb; target text; digest_value text;
 mutable text[]:=ARRAY['image','image_digest','vmHost','vmConfigurationSha256','vmPower',
  'upgradeLease','vmUpdateVerification','upgradeAcknowledgement','upgradeApproval',
  'installedRelease','source_image','previous_image','upgraded','observed','imageSetByRevision','upgrade'];
BEGIN
 SELECT * INTO job FROM public.byoc_setup_jobs WHERE user_id=prior.user_id;
 IF job IS NULL OR jsonb_typeof(job.stages) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 SELECT jsonb_agg(e->'intent') INTO intents FROM jsonb_array_elements(job.stages) e
 WHERE e->>'stage' IN ('azure_setup_intent','azure_setup_prior_intent')
  AND e->'intent'->'version'='3'::jsonb
  AND e->'intent'->>'operationId'=approval->>'operationId';
 IF jsonb_array_length(intents) IS DISTINCT FROM 1 THEN RETURN false; END IF;
 intent:=intents->0;
 digest_value:=right(intent->>'sourceImage',71);
 target:=split_part(old_m->>'image','@',1)||'@'||digest_value;
 IF prior.status IS DISTINCT FROM 'provisioned' OR prior.backend IS DISTINCT FROM 'user_azure'
 OR prior.deployment_target IS DISTINCT FROM 'user_azure' OR old_m->>'hostKind' IS DISTINCT FROM 'azure_vm'
 OR old_m ? 'erasure' OR new_m ?| ARRAY['erasure','upgradeLease','vmPower']
 OR public.azure_vm_power_pending(old_m) IS TRUE
 OR (old_m ? 'vmPower' AND old_m->'vmPower'->'binding' IS DISTINCT FROM public.azure_vm_power_binding(to_jsonb(prior)))
 OR (to_jsonb(prior)-ARRAY['backend_metadata','updated_at']) IS DISTINCT FROM
    (to_jsonb(incoming)-ARRAY['backend_metadata','updated_at'])
 OR old_m-mutable IS DISTINCT FROM new_m-mutable
 OR intent->'binding' IS DISTINCT FROM public.azure_vm_upgrade_registry_binding(to_jsonb(prior))
 OR public.valid_byoc_azure_vm_upgrade_intent(prior.user_id,intent->>'jobId',job.project_id,prior.hushh_id,intent) IS NOT TRUE
 OR intent->>'attemptId' IS DISTINCT FROM encode(sha256(convert_to(old_m->>'upgradeLease','UTF8')),'hex')
 OR intent->>'sourceImage' IS DISTINCT FROM approval->>'targetImage'
 OR EXISTS(SELECT 1 FROM unnest(ARRAY['operationId','releaseId','idempotencyKey']) k
    WHERE intent->k IS DISTINCT FROM approval->k)
 OR approval->>'ownerId' IS DISTINCT FROM prior.user_id OR approval->>'hushhId' IS DISTINCT FROM prior.hushh_id
 OR approval->>'podIncarnation' IS DISTINCT FROM old_m->>'serviceUid'
 OR approval->'version' IS DISTINCT FROM '1'::jsonb
 OR coalesce(approval->'capabilityPlanDigest','null'::jsonb)<>'null'::jsonb
 OR (approval->>'status' IN ('approved','scheduled','updating','blocked')) IS NOT TRUE
 OR (new_m->'upgradeApproval')-ARRAY['status','operationState','presentationPhase','verifiedAt']
    IS DISTINCT FROM approval-ARRAY['status','operationState','presentationPhase','verifiedAt']
 OR new_m->'upgradeApproval'->>'status' IS DISTINCT FROM 'succeeded'
 OR new_m->'upgradeApproval'->>'operationState' IS DISTINCT FROM 'succeeded'
 OR new_m->'upgradeApproval'->>'presentationPhase' IS DISTINCT FROM 'verified'
 OR new_m->>'source_image' IS DISTINCT FROM intent->>'sourceImage'
 OR new_m->>'image' IS DISTINCT FROM target OR new_m->>'image_digest' IS DISTINCT FROM digest_value
 OR new_m->>'previous_image' IS DISTINCT FROM old_m->>'image'
 OR new_m->'vmHost' IS DISTINCT FROM jsonb_set(old_m->'vmHost','{installation,image_digest}',to_jsonb(digest_value))
 OR proof-ARRAY['operationId','attemptId','host','recovery','released','previousPower']<>'{}'::jsonb
 OR proof->'previousPower' IS DISTINCT FROM old_m->'vmPower'
 OR proof->'operationId' IS DISTINCT FROM intent->'operationId'
 OR proof->'attemptId' IS DISTINCT FROM intent->'attemptId'
 OR ack->'vmHostAck' IS DISTINCT FROM host_ack
 OR new_m->'upgradeAcknowledgement' IS DISTINCT FROM (ack||jsonb_build_object('outcome','ready'))
 OR ack->'attemptId' IS DISTINCT FROM intent->'attemptId'
 OR ack->'operationId' IS DISTINCT FROM intent->'operationId'
 OR ack->'releaseId' IS DISTINCT FROM intent->'releaseId'
 OR ack->>'externalAgentId' IS DISTINCT FROM prior.external_agent_id
 OR ack->>'service' IS DISTINCT FROM prior.external_agent_id
 OR ack->'serviceUid' IS DISTINCT FROM old_m->'serviceUid'
 OR ack->>'hostKind' IS DISTINCT FROM 'azure_vm' OR ack->'version' IS DISTINCT FROM '1'::jsonb
 OR ack->>'image' IS DISTINCT FROM target OR ack->>'targetImage' IS DISTINCT FROM intent->>'sourceImage'
 OR approval->'handoffIdleRecord' IS DISTINCT FROM intent->'idleRecord'
 OR public.valid_pod_upgrade_cursor(approval->'handoffCommittedCursor') IS NOT TRUE
 OR ack->'idleReceipt'->'operationId' IS DISTINCT FROM intent->'operationId'
 OR ack->'idleReceipt'->'incarnation' IS DISTINCT FROM old_m->'serviceUid'
 OR ack->'idleReceipt'->'runtimeEpoch' IS DISTINCT FROM approval->'handoffRuntimeEpoch'
 OR ack->'idleReceipt'->'activeWork' IS DISTINCT FROM '0'::jsonb
 OR ack->'idleReceipt'->'committedCursor' IS DISTINCT FROM approval->'handoffCommittedCursor'
 OR ack->'idleReceipt'->'committedState' IS DISTINCT FROM approval->'handoffCommittedState'
 OR ack->'idleReceipt'->'idleRecord' IS DISTINCT FROM intent->'idleRecord'
 OR (intent->'idleRecord'->>'seq')::numeric<=(approval->'handoffCommittedCursor'->>'seq')::numeric
 OR approval->>'handoffCommittedState' IS DISTINCT FROM encode(sha256(convert_to(
    (intent->>'operationId')||'|'||(old_m->>'serviceUid')||'|'||
    (approval->'handoffCommittedCursor'->>'seq')||'|'||
    (approval->'handoffCommittedCursor'->>'sha')||'|active=0','UTF8')),'hex')
 OR host_ack-ARRAY['version','operation_id','request_sha256','configuration_sha256','image','stage','application_verified']<>'{}'::jsonb
 OR host_ack->'version' IS DISTINCT FROM '1'::jsonb
 OR host_ack->'operation_id' IS DISTINCT FROM intent->'operationId'
 OR host_ack->'request_sha256' IS DISTINCT FROM intent->'hostRequestSha256'
 OR host_ack->>'image' IS DISTINCT FROM target OR host_ack->>'stage' IS DISTINCT FROM 'restart_requested'
 OR host_ack->'application_verified' IS DISTINCT FROM 'false'::jsonb
 OR host_ack->'configuration_sha256' IS DISTINCT FROM new_m->'vmConfigurationSha256'
 OR (new_m->>'vmConfigurationSha256' ~ '^[a-f0-9]{64}$') IS NOT TRUE
 OR new_m->'vmConfigurationSha256' IS NOT DISTINCT FROM old_m->'vmConfigurationSha256'
 OR recovery->>'kind' IS DISTINCT FROM 'recovery'
 OR recovery->'incarnation' IS DISTINCT FROM old_m->'serviceUid'
 OR recovery->>'podKeyId' IS DISTINCT FROM prior.pod_key_id
 OR recovery->>'imageDigest' IS DISTINCT FROM digest_value
 OR (recovery->>'runtimeEpoch' ~ '^[A-Za-z0-9_-]+$') IS NOT TRUE
 OR length(recovery->>'runtimeEpoch')>256
 OR recovery->'runtimeEpoch' IS NOT DISTINCT FROM approval->'handoffRuntimeEpoch'
 OR recovery->'retainedIdleRecord' IS DISTINCT FROM intent->'idleRecord'
 OR released->>'kind' IS DISTINCT FROM 'released'
 OR released->'operationId' IS DISTINCT FROM intent->'operationId'
 OR released->'incarnation' IS DISTINCT FROM recovery->'incarnation'
 OR released->'runtimeEpoch' IS DISTINCT FROM recovery->'runtimeEpoch'
 OR public.valid_pod_upgrade_cursor(released->'releaseRecord') IS NOT TRUE
 OR (released->'releaseRecord'->>'seq')::numeric<=(intent->'idleRecord'->>'seq')::numeric
 OR public.azure_vm_upgrade_dispatch_settled(intent,job.stages) IS NOT TRUE
 THEN RETURN false; END IF;
 RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_azure_vm_power_registry()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
DECLARE prior jsonb; incoming jsonb; binding jsonb;
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.backend_metadata ? 'vmPower' THEN
   RAISE EXCEPTION 'VM power requires an existing installation' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
 END IF;
 prior:=OLD.backend_metadata->'vmPower';
 -- Image/configuration publication is a distinct terminal transition. Check it
 -- before absent/unchanged power shortcuts, so stale ready markers cannot pass.
 IF TG_OP='UPDATE' AND OLD.backend_metadata->>'hostKind'='azure_vm' AND (
   OLD.backend_metadata->'image' IS DISTINCT FROM NEW.backend_metadata->'image'
   OR OLD.backend_metadata->'image_digest' IS DISTINCT FROM NEW.backend_metadata->'image_digest'
   OR OLD.backend_metadata->'vmHost' IS DISTINCT FROM NEW.backend_metadata->'vmHost'
   OR OLD.backend_metadata->'vmConfigurationSha256' IS DISTINCT FROM NEW.backend_metadata->'vmConfigurationSha256'
   OR (prior IS NOT NULL AND public.azure_vm_power_binding(to_jsonb(NEW)) IS DISTINCT FROM prior->'binding')
 ) THEN
  IF current_setting('transaction_isolation') NOT IN ('read committed','read uncommitted')
   OR NOT pg_try_advisory_xact_lock(hashtextextended(OLD.user_id,171))
   OR NOT pg_try_advisory_xact_lock(hashtextextended(OLD.user_id,198))
   OR NOT pg_try_advisory_xact_lock(hashtextextended(OLD.user_id,206))
   OR public.azure_vm_image_publication_proven(OLD,NEW) IS NOT TRUE
  THEN RAISE EXCEPTION 'VM image publication requires verified recovery' USING ERRCODE='42501'; END IF;
  RETURN NEW;
 END IF;
 IF prior IS NULL AND (TG_OP='DELETE' OR NOT coalesce(NEW.backend_metadata ? 'vmPower',false)) THEN
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
 END IF;
 IF current_setting('transaction_isolation') NOT IN ('read committed','read uncommitted') THEN
  RAISE EXCEPTION 'VM power requires a current snapshot' USING ERRCODE='42501';
 END IF;
 IF TG_OP='DELETE' THEN
  IF public.azure_vm_power_pending(OLD.backend_metadata) THEN
   RAISE EXCEPTION 'VM power requires reconciliation' USING ERRCODE='42501';
  END IF;
  RETURN OLD;
 END IF;
 incoming:=NEW.backend_metadata->'vmPower';
 IF public.azure_vm_power_pending(OLD.backend_metadata) AND (
   public.azure_vm_power_binding(to_jsonb(NEW)) IS DISTINCT FROM prior->'binding'
   OR NEW.backend_metadata ?| ARRAY['erasure','upgradeLease','provisionAttempt']
 ) THEN RAISE EXCEPTION 'VM power fences this installation' USING ERRCODE='42501'; END IF;
 IF incoming IS NOT DISTINCT FROM prior THEN RETURN NEW; END IF;
 IF NOT public.byoc_azure_worker_session_held(OLD.user_id)
 OR NOT pg_try_advisory_xact_lock(hashtextextended(OLD.user_id,171))
 OR NOT pg_try_advisory_xact_lock(hashtextextended(OLD.user_id,198)) THEN
  RAISE EXCEPTION 'VM power worker is not admitted' USING ERRCODE='42501';
 END IF;
 binding:=public.azure_vm_power_binding(to_jsonb(OLD));
 IF public.azure_vm_power_eligible(to_jsonb(OLD)) IS NOT TRUE
 OR public.azure_vm_power_binding(to_jsonb(NEW)) IS DISTINCT FROM binding
 OR (to_jsonb(NEW)-ARRAY['backend_metadata','updated_at'])
    IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['backend_metadata','updated_at'])
 OR NEW.backend_metadata-'vmPower' IS DISTINCT FROM OLD.backend_metadata-'vmPower'
 OR jsonb_typeof(incoming) IS DISTINCT FROM 'object'
 OR incoming-ARRAY['version','operationId','binding','phase','events','previousOperationId']<>'{}'::jsonb
 OR incoming->'version' IS DISTINCT FROM '1'::jsonb
 OR (incoming->>'phase' IN ('preparing','drained','deallocated','starting','recovered','ready')) IS NOT TRUE
 OR incoming->'binding' IS DISTINCT FROM binding
 OR coalesce(incoming->>'operationId','') !~ '^[a-f0-9]{32}$'
 OR jsonb_typeof(incoming->'events') IS DISTINCT FROM 'array'
 OR jsonb_array_length(incoming->'events')>16
 THEN RAISE EXCEPTION 'VM power transition refused' USING ERRCODE='42501'; END IF;
 IF prior IS NULL OR prior->>'phase'='ready' THEN
  IF incoming->>'phase' IS DISTINCT FROM 'preparing'
   OR incoming->'events' IS DISTINCT FROM '[]'::jsonb
   OR incoming->>'operationId'=prior->>'operationId'
   OR incoming->'previousOperationId' IS DISTINCT FROM prior->'operationId'
  THEN RAISE EXCEPTION 'VM power claim refused' USING ERRCODE='42501'; END IF;
 ELSE
  IF incoming-ARRAY['phase','events'] IS DISTINCT FROM prior-ARRAY['phase','events']
   OR (SELECT coalesce(jsonb_agg(value ORDER BY ordinal),'[]'::jsonb)
       FROM jsonb_array_elements(incoming->'events') WITH ORDINALITY e(value,ordinal)
       WHERE ordinal<=jsonb_array_length(prior->'events')) IS DISTINCT FROM prior->'events'
   OR (
     (incoming->>'phase'=prior->>'phase'
       AND jsonb_array_length(incoming->'events')=jsonb_array_length(prior->'events')+1
       AND public.valid_azure_vm_power_event(prior,incoming->'events'->-1))
     OR (incoming->'events'=prior->'events'
       AND public.azure_vm_power_phase_proven(prior,incoming->>'phase') AND (
       (prior->>'phase'='preparing' AND incoming->>'phase'='drained')
       OR (prior->>'phase'='drained' AND incoming->>'phase'='deallocated')
       OR (prior->>'phase'='deallocated' AND incoming->>'phase'='starting')
       OR (prior->>'phase'='starting' AND incoming->>'phase'='recovered')
       OR (prior->>'phase'='recovered' AND incoming->>'phase'='ready')))) IS NOT TRUE
  THEN RAISE EXCEPTION 'VM power receipt cannot be replaced' USING ERRCODE='42501'; END IF;
 END IF;
 RETURN NEW;
END;
$$;

COMMIT;
