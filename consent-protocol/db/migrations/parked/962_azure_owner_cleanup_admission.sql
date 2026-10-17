-- Dev only. Owner-approved resource cleanup stays in the existing erasure record.
-- No credential or new lifecycle ledger. This does not declare physical purge.
BEGIN;

-- A resource-only failure needs positive original setup history, not absence of
-- registry coordinates. This grants no effects; exact ARM absence is also checked.
CREATE OR REPLACE FUNCTION public.azure_setup_predeployment_proven(owner_id text, snapshot jsonb, require_resources boolean)
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=public AS $$
DECLARE live public.personal_agent_registry%ROWTYPE; job public.byoc_setup_jobs%ROWTYPE;
 item jsonb; first_intent jsonb; intent jsonb; history jsonb; group_path text;
BEGIN
 IF public.byoc_azure_setup_guards_ready() IS NOT TRUE
 OR snapshot->>'user_id' IS DISTINCT FROM owner_id
 OR (snapshot->>'status' IN ('pending','unprovisioned')) IS NOT TRUE
 OR nullif(snapshot->>'deployment_target','') IS NOT NULL
 OR EXISTS (SELECT 1 FROM unnest(ARRAY['backend','external_agent_id','a2a_route','pod_pubkey',
   'pod_key_id','pod_key_wrapping_alg','attestation_ref','provisioned_at','user_cloud_project',
   'space_id','region','user_cloud_bootstrap_sa','user_cloud_authorized_at','user_cloud_region',
   'user_cloud_tenant_id','user_cloud_subscription_id','user_cloud_resource_group']) f
   WHERE nullif(snapshot->>f,'') IS NOT NULL)
 OR coalesce(snapshot->'backend_metadata','null'::jsonb) NOT IN ('null'::jsonb,'{}'::jsonb)
 OR EXISTS(SELECT 1 FROM public.personal_agent_deletion_tombstones
   WHERE hushh_id=snapshot->>'hushh_id')
 OR EXISTS(SELECT 1 FROM public.consent_audit WHERE user_id=owner_id
   AND agent_id='personal_agent' AND action='CONSENT_GRANTED')
 OR EXISTS(SELECT 1 FROM public.pod_migration_jobs WHERE user_id=owner_id)
 OR EXISTS(SELECT 1 FROM public.personal_agent_standby_placements WHERE user_id=owner_id)
 OR EXISTS(SELECT 1 FROM public.pod_lifecycle_events WHERE user_id=owner_id AND (
   hushh_id IS DISTINCT FROM snapshot->>'hushh_id' OR substrate_step IS NOT NULL
   OR NOT ((coalesce(event,'')='stage' AND coalesce(stage,'') IN ('registry_row','failed'))
     OR (coalesce(event,'')='terminal' AND coalesce(stage,'')='failed'))))
 THEN RETURN false; END IF;
 SELECT * INTO live FROM public.personal_agent_registry WHERE user_id=owner_id;
 IF NOT FOUND OR live.hushh_id IS DISTINCT FROM snapshot->>'hushh_id'
 OR coalesce(live.backend_metadata->'erasure'->'registrySnapshot',to_jsonb(live))
   -ARRAY['updated_at','last_heartbeat_at','health_state','liveness_failures'] IS DISTINCT FROM
   snapshot-ARRAY['updated_at','last_heartbeat_at','health_state','liveness_failures']
 THEN RETURN false; END IF;
 SELECT * INTO job FROM public.byoc_setup_jobs WHERE user_id=owner_id;
 IF NOT FOUND OR job.status IS DISTINCT FROM 'failed' OR job.authorization_attempts IS DISTINCT FROM '{}'::jsonb
 OR jsonb_typeof(job.stages) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 history:=job.stages;
 SELECT x->'intent' INTO first_intent FROM jsonb_array_elements(history) x
 WHERE x->>'stage' IN ('azure_setup_intent','azure_setup_prior_intent') LIMIT 1;
 IF first_intent IS NULL THEN RETURN false; END IF;
 group_path:=job.project_id;
 FOR item IN SELECT value FROM jsonb_array_elements(history) LOOP
  IF item->>'stage' IN ('azure_setup_intent','azure_setup_prior_intent') THEN
   intent:=item->'intent';
   IF intent->'version' IS DISTINCT FROM '1'::jsonb
   OR public.valid_byoc_azure_setup_intent(owner_id,intent->>'jobId',group_path,live.hushh_id,intent) IS NOT TRUE
   OR intent-ARRAY['jobId','groupInitiallyAbsent','setupNonce'] IS DISTINCT FROM first_intent-ARRAY['jobId','groupInitiallyAbsent','setupNonce']
   OR (require_resources IS TRUE AND intent->'setupNonce' IS DISTINCT FROM first_intent->'setupNonce')
   OR (require_resources IS FALSE AND intent->'groupInitiallyAbsent' IS DISTINCT FROM 'true'::jsonb)
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(history) w
     WHERE w->>'stage'='azure_worker_started' AND w->>'jobId'=intent->>'jobId')
   THEN RETURN false; END IF;
  ELSIF item->>'stage'='azure_worker_started' THEN
   IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(history) x WHERE x->>'stage'='azure_worker_exited'
     AND x->>'executionId'=item->>'executionId' AND x->>'jobId'=item->>'jobId')
   THEN RETURN false; END IF;
  ELSIF item->>'stage'='azure_provider_request' THEN
   IF (item->>'purpose' IN ('creating_resource_group','registering_providers','creating_identity',
      'creating_key_vault','creating_storage','creating_registry','creating_model')) IS NOT TRUE
   OR item->>'path' ~* '/Microsoft[.]App/containerApps/'
   OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(history) x WHERE x->>'stage'='azure_provider_terminal'
     AND x->>'requestId'=item->>'requestId' AND x->>'executionId'=item->>'executionId'
     AND (x->>'outcome' IN ('succeeded','failed','not_dispatched')
      OR (x->>'outcome'='refused' AND EXISTS(SELECT 1 FROM jsonb_array_elements(history) ack
       WHERE ack->>'stage'='azure_provider_ack' AND ack->>'requestId'=item->>'requestId'
       AND ack->>'executionId'=item->>'executionId'
       AND ack->>'status' IN ('400','401','403','404','405','409','412','422','429')))))
   THEN RETURN false; END IF;
  END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(history) x WHERE x->>'stage'='azure_worker_started'
   AND x->>'jobId'=job.job_id) THEN RETURN false; END IF;
 IF require_resources IS FALSE THEN
  RETURN NOT EXISTS(SELECT 1 FROM jsonb_array_elements(history) x
   WHERE x->>'stage' IN ('azure_provider_request','azure_provider_ack','azure_provider_terminal'));
 END IF;
 RETURN EXISTS(SELECT 1 FROM jsonb_array_elements(history) request
  JOIN jsonb_array_elements(history) ack ON ack->>'requestId'=request->>'requestId'
  JOIN jsonb_array_elements(history) terminal ON terminal->>'requestId'=request->>'requestId'
  WHERE request->>'stage'='azure_provider_request' AND request->>'method'='PUT'
   AND request->>'path'=group_path AND request->>'purpose'='creating_resource_group'
   AND ack->>'stage'='azure_provider_ack' AND ack->'status'='201'::jsonb
   AND terminal->>'stage'='azure_provider_terminal' AND terminal->>'outcome'='succeeded');
END;
$$;

CREATE OR REPLACE FUNCTION public.azure_setup_never_deployed(owner_id text, snapshot jsonb)
RETURNS boolean LANGUAGE sql STABLE SET search_path=public AS $$
 SELECT public.azure_setup_predeployment_proven(owner_id,snapshot,true);
$$;

CREATE OR REPLACE FUNCTION public.azure_setup_no_effects(owner_id text)
RETURNS boolean LANGUAGE sql STABLE SET search_path=public AS $$
 SELECT coalesce(public.azure_setup_predeployment_proven(owner_id,to_jsonb(p),false),false)
 FROM public.personal_agent_registry p WHERE user_id=owner_id;
$$;

CREATE OR REPLACE FUNCTION public.azure_cleanup_information_erased(owner_id text, reservation jsonb)
RETURNS boolean LANGUAGE sql STABLE SET search_path=public AS $$
 SELECT public.erasure_provider_revocation_complete(reservation) IS TRUE
 OR public.azure_setup_never_deployed(owner_id,reservation->'registrySnapshot') IS TRUE;
$$;

CREATE OR REPLACE FUNCTION public.azure_erasure_context(owner_id text)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=public AS $$
DECLARE agent public.personal_agent_registry%ROWTYPE; job public.byoc_setup_jobs%ROWTYPE;
 r jsonb; s jsonb; context jsonb; original jsonb; tenant_id text; subscription_id text;
 resource_group text; location text;
BEGIN
 SELECT * INTO agent FROM public.personal_agent_registry WHERE user_id=owner_id;
 IF NOT FOUND OR agent.status IS DISTINCT FROM 'suspended' THEN RETURN NULL; END IF;
 r:=agent.backend_metadata->'erasure'; s:=r->'registrySnapshot';
 IF r->>'ownerId' IS DISTINCT FROM owner_id OR s->>'user_id' IS DISTINCT FROM owner_id
 OR r->>'hushhId' IS DISTINCT FROM agent.hushh_id
 OR coalesce(r->>'attemptId','')=''
 OR r ?| ARRAY['lateUpgradeAcknowledgement','lateProvisionAcknowledgement']
 OR nullif(s->'backend_metadata'->>'upgradeLease','') IS NOT NULL
 OR EXISTS(SELECT 1 FROM public.pod_migration_jobs WHERE user_id=owner_id)
 OR EXISTS(SELECT 1 FROM public.personal_agent_standby_placements WHERE user_id=owner_id)
 THEN RETURN NULL; END IF;
 SELECT * INTO job FROM public.byoc_setup_jobs WHERE user_id=owner_id;
 IF NOT FOUND OR job.status NOT IN ('recorded','failed')
 OR jsonb_typeof(job.stages) IS DISTINCT FROM 'array'
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(job.stages) x
   WHERE x->>'stage'='azure_worker_started' AND NOT EXISTS(
    SELECT 1 FROM jsonb_array_elements(job.stages) y
    WHERE y->>'stage'='azure_worker_exited' AND y->>'executionId'=x->>'executionId'))
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(job.stages) x
   WHERE x->>'stage'='azure_provider_request' AND NOT EXISTS(
    SELECT 1 FROM jsonb_array_elements(job.stages) y
    WHERE y->>'stage'='azure_provider_terminal' AND y->>'requestId'=x->>'requestId'))
 THEN RETURN NULL; END IF;
 SELECT x->'intent' INTO original FROM jsonb_array_elements(job.stages) x
 WHERE x->>'stage' IN ('azure_setup_intent','azure_setup_prior_intent') LIMIT 1;
 IF original IS NOT NULL AND public.valid_byoc_azure_setup_intent(owner_id,original->>'jobId',
   job.project_id,agent.hushh_id,original) IS NOT TRUE THEN RETURN NULL; END IF;
 IF s->>'deployment_target' IS DISTINCT FROM 'user_azure'
 AND NOT (original IS NOT NULL AND nullif(s->>'backend','') IS NULL
   AND nullif(s->>'external_agent_id','') IS NULL) THEN RETURN NULL; END IF;
 tenant_id:=coalesce(nullif(s->>'user_cloud_tenant_id',''),original->>'tenantId');
 subscription_id:=coalesce(nullif(s->>'user_cloud_subscription_id',''),original->>'subscriptionId');
 resource_group:=coalesce(nullif(s->>'user_cloud_resource_group',''),original->>'resourceGroup');
 location:=coalesce(nullif(s->>'user_cloud_region',''),original->>'location');
 IF tenant_id IS NULL OR subscription_id IS NULL OR resource_group IS NULL OR location IS NULL
 OR job.project_id IS DISTINCT FROM '/subscriptions/'||subscription_id||'/resourceGroups/'||resource_group
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(job.stages) x
   WHERE x->>'stage' IN ('azure_setup_intent','azure_setup_prior_intent') AND (
    public.valid_byoc_azure_setup_intent(owner_id,x->'intent'->>'jobId',job.project_id,
      agent.hushh_id,x->'intent') IS NOT TRUE
    OR x->'intent'->>'tenantId' IS DISTINCT FROM tenant_id
    OR x->'intent'->>'subscriptionId' IS DISTINCT FROM subscription_id
    OR x->'intent'->>'resourceGroup' IS DISTINCT FROM resource_group
    OR x->'intent'->>'location' IS DISTINCT FROM location
    OR x->'intent'->>'setupNonce' IS DISTINCT FROM original->>'setupNonce'))
 THEN RETURN NULL; END IF;
 context:=jsonb_build_object('version',1,'ownerId',owner_id,'attemptId',r->>'attemptId',
  'hushhId',agent.hushh_id,'tenantId',tenant_id,'subscriptionId',subscription_id,
  'resourceGroup',resource_group,'location',location,
  'setupNonce',coalesce(s->'backend_metadata'->>'setupNonce',original->>'setupNonce'),
  'neverDeployed',public.azure_setup_never_deployed(owner_id,s),
  'snapshotSha256',encode(sha256(convert_to(s::text,'UTF8')),'hex'),
  'setupHistorySha256',encode(sha256(convert_to(job.stages::text,'UTF8')),'hex'));
 RETURN context||jsonb_build_object('digest',encode(sha256(convert_to(context::text,'UTF8')),'hex'));
END;
$$;

-- Missing historical receipts never establish writer/provider drain. Old pods
-- may be inspected, but require a separately qualified legacy maintenance path.
CREATE OR REPLACE FUNCTION public.azure_erasure_writers_drained(owner_id text)
RETURNS boolean LANGUAGE sql STABLE SET search_path=public AS $$
 WITH context AS (SELECT public.azure_erasure_context(owner_id) value), history AS (
  SELECT jsonb_array_elements(j.stages) event FROM public.byoc_setup_jobs j WHERE j.user_id=owner_id
 ) SELECT context.value IS NOT NULL AND EXISTS(
  -- A journalled original setup cannot stand in for a later unjournalled
  -- upgrade or rebuild. The current job must have its own real worker witness.
  SELECT 1 FROM public.byoc_setup_jobs current_job JOIN history worker ON
   worker.event->>'jobId'=current_job.job_id
  WHERE current_job.user_id=owner_id AND worker.event->>'stage'='azure_worker_started'
 ) AND EXISTS(
  SELECT 1 FROM history request JOIN history ack ON ack.event->>'requestId'=request.event->>'requestId'
  JOIN history terminal ON terminal.event->>'requestId'=request.event->>'requestId'
  WHERE request.event->>'stage'='azure_provider_request'
   AND request.event->>'method'='PUT' AND request.event->>'purpose'='creating_resource_group'
   AND request.event->>'path'='/subscriptions/'||(context.value->>'subscriptionId')||
     '/resourceGroups/'||(context.value->>'resourceGroup')
   AND ack.event->>'stage'='azure_provider_ack' AND ack.event->'status'='201'::jsonb
   AND terminal.event->>'stage'='azure_provider_terminal' AND terminal.event->>'outcome'='succeeded'
 ) FROM context;
$$;

CREATE OR REPLACE FUNCTION public.valid_azure_erasure_plan(owner_id text, plan jsonb)
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=public AS $$
DECLARE context jsonb:=public.azure_erasure_context(owner_id); group_path text;
 item record; resource jsonb;
BEGIN
 IF context IS NULL OR jsonb_typeof(plan) IS DISTINCT FROM 'object'
 OR plan-ARRAY['version','context','resources','termsVersion']<>'{}'::jsonb
 OR plan->'version' IS DISTINCT FROM '1'::jsonb OR plan->'context' IS DISTINCT FROM context
 OR coalesce(plan->>'termsVersion','') NOT IN ('azure-exact-parent-v1','azure-exact-parent-retention-v2')
 OR jsonb_typeof(plan->'resources') IS DISTINCT FROM 'object'
 OR (SELECT count(*) FROM jsonb_each(plan->'resources')) NOT BETWEEN 1 AND 128
 OR octet_length(plan::text)>262144 THEN RETURN false; END IF;
 group_path:='/subscriptions/'||(context->>'subscriptionId')||
   '/resourceGroups/'||(context->>'resourceGroup');
 IF context->'neverDeployed'='true'::jsonb AND (
  jsonb_typeof(plan->'resources'->(group_path||'/providers/Microsoft.App/containerApps/ca-hussh-one-pod')) IS DISTINCT FROM 'object'
  OR plan->'resources'->(group_path||'/providers/Microsoft.App/containerApps/ca-hussh-one-pod')->'identity' IS DISTINCT FROM 'null'::jsonb
  OR plan->'resources'->(group_path||'/providers/Microsoft.App/containerApps/ca-hussh-one-pod')->'coveredBy' IS DISTINCT FROM 'null'::jsonb
  OR (SELECT count(*) FROM jsonb_each(plan->'resources') x WHERE x.key ~* '/Microsoft[.]App/containerApps/[^/]+$')<>1
 ) THEN RETURN false; END IF;
 FOR item IN SELECT * FROM jsonb_each(plan->'resources') LOOP
  resource:=item.value;
  IF item.key !~ '^/subscriptions/[0-9a-f-]+/resourceGroups/[A-Za-z0-9_.()-]+'
  OR NOT (item.key=group_path OR starts_with(item.key,group_path||'/providers/'))
  OR jsonb_typeof(resource) IS DISTINCT FROM 'object'
  OR resource-ARRAY['apiVersion','kind','expected','coveredBy','identity','deletionScope']<>'{}'::jsonb
  OR (resource->>'apiVersion' ~ '^\d{4}-\d{2}-\d{2}(-preview)?$') IS NOT TRUE
  OR (resource->>'kind' IN ('resource','role_assignment','role_definition')) IS NOT TRUE
  OR jsonb_typeof(resource->'expected') IS DISTINCT FROM 'object'
  OR resource->>'deletionScope' IS DISTINCT FROM (CASE WHEN item.key=group_path THEN 'whole_group'
    WHEN resource->>'kind'='resource' THEN 'all_contents' ELSE 'resource_only' END)
  OR NOT resource ?& ARRAY['apiVersion','kind','expected','coveredBy','identity','deletionScope']
  THEN RETURN false; END IF;
  IF resource->'identity'<>'null'::jsonb AND (jsonb_typeof(resource->'identity') IS DISTINCT FROM 'object'
   OR lower(resource->'identity'->>'id') IS DISTINCT FROM lower(item.key)) THEN RETURN false; END IF;
  IF resource->'coveredBy'<>'null'::jsonb AND (jsonb_typeof(resource->'coveredBy') IS DISTINCT FROM 'string'
   OR NOT (plan->'resources' ? (resource->>'coveredBy'))
   OR NOT starts_with(item.key,(resource->>'coveredBy')||'/')) THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.azure_erasure_request_retryable(resource jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=public AS $$
 SELECT coalesce(resource->'provider_terminal'->>'outcome'='not_dispatched' OR (
  resource->'provider_terminal'->>'outcome'='refused'
  AND resource->'provider_ack'->>'status' IN ('400','401','403','405','412','422','429')),false);
$$;

CREATE OR REPLACE FUNCTION public.azure_erasure_absence_settled(resource jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=public AS $$
 SELECT NOT resource ? 'provider_request' OR public.azure_erasure_request_retryable(resource) IS TRUE
  OR coalesce(resource->'provider_terminal'->>'outcome'='succeeded' OR (
   resource->'provider_terminal'->>'outcome'='refused' AND resource->'provider_ack'->>'status'='404'),false);
$$;

-- Derive receipt content from the retained operation, never from browser claims.
-- Fresh provider reads and actual thread exit remain the trusted runtime's work.
CREATE OR REPLACE FUNCTION public.azure_erasure_execution_receipt(
 state jsonb, stage text, outcome text
) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $$
DECLARE worker jsonb:=state->'worker'; execution_id text:=worker->>'executionId'; ids jsonb;
 final_receipt jsonb:=state->'finalReadbacks'->execution_id;
BEGIN
 IF worker IS NULL OR execution_id IS NULL THEN RETURN NULL; END IF;
 IF stage='workerExits' AND outcome IN ('returned','failed','cancelled') THEN
  RETURN jsonb_build_object('worker',worker,'outcome',outcome,'finalReadbackSha256',
   CASE WHEN final_receipt IS NULL THEN NULL ELSE
    encode(sha256(convert_to(final_receipt::text,'UTF8')),'hex') END);
 END IF;
 IF stage IS DISTINCT FROM 'finalReadbacks' OR outcome IS NOT NULL
 OR jsonb_typeof(state->'resources') IS DISTINCT FROM 'object' THEN RETURN NULL; END IF;
 SELECT jsonb_agg(key ORDER BY key) INTO ids FROM jsonb_each(state->'plan'->'resources')
 WHERE value->'coveredBy'='null'::jsonb;
 IF EXISTS(SELECT 1 FROM jsonb_each(state->'plan'->'resources') item
  WHERE item.key ~ '/providers/Microsoft[.](KeyVault/vaults|Storage/storageAccounts|CognitiveServices/accounts)/[^/]+$'
   AND item.value->'coveredBy'='null'::jsonb
   AND public.valid_azure_retention_receipt(state->'plan',item.key,state->'resources'->item.key->'retention') IS NOT TRUE)
 THEN RETURN NULL; END IF;
 IF ids IS NULL OR ids IS DISTINCT FROM
  (SELECT jsonb_agg(key ORDER BY key) FROM jsonb_each(state->'resources'))
 OR EXISTS(SELECT 1 FROM jsonb_each(state->'resources') r
   WHERE public.azure_erasure_absence_settled(r.value) IS NOT TRUE
   OR r.value->'absence' IS DISTINCT FROM
     jsonb_build_object('status','active_resource_absent','id',r.key)) THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('worker',worker,'status','active_resources_absent',
  'planDigest',encode(sha256(convert_to((state->'plan')::text,'UTF8')),'hex'),
  'resourcesSha256',encode(sha256(convert_to((state->'resources')::text,'UTF8')),'hex'),
  'resourceIdsSha256',encode(sha256(convert_to(ids::text,'UTF8')),'hex'));
END;
$$;

CREATE OR REPLACE FUNCTION public.valid_azure_retention_receipt(plan jsonb,resource_id text,receipt jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $$
DECLARE context jsonb:=plan->'context'; base text; group_base text; name text; target text; kind text;
 api text; value text; deletion_time timestamptz; purge_time timestamptz;
BEGIN
 base:='/subscriptions/'||(context->>'subscriptionId')||'/providers/';
 name:=regexp_replace(resource_id,'^.*/','');
 group_base:='/subscriptions/'||(context->>'subscriptionId')||'/resourceGroups/'||(context->>'resourceGroup')||'/providers/';
 IF resource_id=group_base||'Microsoft.KeyVault/vaults/'||name THEN
  kind:='key_vault'; api:='2023-07-01'; target:=base||'Microsoft.KeyVault/locations/'||(context->>'location')||'/deletedVaults/'||name;
 ELSIF resource_id=group_base||'Microsoft.Storage/storageAccounts/'||name THEN
  kind:='storage'; api:='2023-05-01'; target:=base||'Microsoft.Storage/locations/'||(context->>'location')||'/deletedAccounts/'||name;
 ELSIF resource_id=group_base||'Microsoft.CognitiveServices/accounts/'||name THEN
  kind:='model_account'; api:='2024-10-01'; target:=base||'Microsoft.CognitiveServices/locations/'||(context->>'location')||'/resourceGroups/'||(context->>'resourceGroup')||'/deletedAccounts/'||name;
 ELSE RETURN false; END IF;
 IF NOT (plan->'resources' ? resource_id) OR plan->'resources'->resource_id->>'kind' IS DISTINCT FROM 'resource'
 OR plan->'resources'->resource_id->'coveredBy' IS DISTINCT FROM 'null'::jsonb
 OR jsonb_typeof(receipt) IS DISTINCT FROM 'object'
 OR receipt->>'id' IS DISTINCT FROM resource_id OR receipt->>'providerRecord' IS DISTINCT FROM target
 OR receipt->>'apiVersion' IS DISTINCT FROM api OR receipt->>'kind' IS DISTINCT FROM kind
 OR receipt->'physicalPurgeVerified' IS DISTINCT FROM 'false'::jsonb
 THEN RETURN false; END IF;
 IF receipt->>'status'='provider_record_absent' THEN
  RETURN receipt-ARRAY['id','providerRecord','apiVersion','kind','physicalPurgeVerified','status']='{}'::jsonb;
 END IF;
 IF receipt->>'status' IS DISTINCT FROM 'provider_retained' THEN RETURN false; END IF;
 IF kind='storage' THEN
  IF receipt-ARRAY['id','providerRecord','apiVersion','kind','physicalPurgeVerified','status','creationTime','deletionTime']<>'{}'::jsonb
   OR receipt->>'creationTime' IS DISTINCT FROM plan->'resources'->resource_id->'identity'->>'createdAt'
   OR jsonb_typeof(receipt->'creationTime') IS DISTINCT FROM 'string'
   OR jsonb_typeof(receipt->'deletionTime') IS DISTINCT FROM 'string' THEN RETURN false; END IF;
  RETURN (receipt->>'creationTime')::timestamptz<=(receipt->>'deletionTime')::timestamptz;
 END IF;
 IF receipt-ARRAY['id','providerRecord','apiVersion','kind','physicalPurgeVerified','status','deletionDate','scheduledPurgeDate','purgeProtectionEnabled']<>'{}'::jsonb
 OR jsonb_typeof(receipt->'deletionDate') IS DISTINCT FROM 'string'
 OR jsonb_typeof(receipt->'scheduledPurgeDate') IS DISTINCT FROM 'string'
 OR (kind='key_vault' AND jsonb_typeof(receipt->'purgeProtectionEnabled') IS DISTINCT FROM 'boolean')
 OR (kind='model_account' AND receipt ? 'purgeProtectionEnabled') THEN RETURN false; END IF;
 deletion_time:=(receipt->>'deletionDate')::timestamptz; purge_time:=(receipt->>'scheduledPurgeDate')::timestamptz;
 RETURN deletion_time<=purge_time;
EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.azure_erasure_setup_history(owner_id text)
RETURNS jsonb LANGUAGE sql STABLE SET search_path=public AS $$
 SELECT j.stages FROM public.byoc_setup_jobs j
 WHERE j.user_id=owner_id AND jsonb_typeof(j.stages)='array'
 AND encode(sha256(convert_to(j.stages::text,'UTF8')),'hex')=
    public.azure_erasure_context(owner_id)->>'setupHistorySha256';
$$;

CREATE OR REPLACE FUNCTION public.valid_azure_cleanup_authorization_append(owner_id text,before_state jsonb,next_state jsonb)
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=public AS $$
DECLARE item record; prior jsonb; incoming jsonb; auth jsonb; now_seconds bigint:=extract(epoch FROM statement_timestamp())::bigint;
BEGIN
 IF next_state-'authorizationAttempts' IS DISTINCT FROM before_state-'authorizationAttempts'
 OR jsonb_typeof(next_state->'authorizationAttempts') IS DISTINCT FROM 'object'
 OR (SELECT count(*) FROM jsonb_each(next_state->'authorizationAttempts'))>64 THEN RETURN false; END IF;
 FOR item IN SELECT * FROM jsonb_each(next_state->'authorizationAttempts') LOOP
  IF (next_state->'authorizationAttempts')-item.key IS DISTINCT FROM coalesce(before_state->'authorizationAttempts','{}'::jsonb)-item.key THEN CONTINUE; END IF;
  prior:=before_state->'authorizationAttempts'->item.key; incoming:=item.value;
  IF (item.key ~ '^[0-9a-f]{64}$') IS NOT TRUE OR jsonb_typeof(incoming) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  IF prior IS NULL THEN
   auth:=public.azure_erasure_authorization(owner_id,incoming->>'purpose');
   RETURN auth IS NOT NULL AND incoming=jsonb_build_object('purpose',auth->>'purpose',
    'digest',auth->>'digest','status','running','startedAt',now_seconds);
  END IF;
  RETURN prior->>'status'='running'
   AND incoming-ARRAY['status','finishedAt','code']=prior-'status'
   AND incoming->>'status' IN ('settled','attention_required')
   AND incoming->'finishedAt'=to_jsonb(now_seconds)
   AND (incoming->>'code' ~ '^[A-Z][A-Z0-9_]{0,95}$') IS TRUE;
 END LOOP;
 RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.retain_azure_cleanup_authorization_outcome(
 owner_id text,attempt_id text,nonce_sha256 text,purpose text,auth_digest text,outcome text,code text
) RETURNS boolean LANGUAGE plpgsql VOLATILE SET search_path=public AS $$
DECLARE r jsonb; state jsonb; incoming jsonb; now_seconds bigint:=extract(epoch FROM statement_timestamp())::bigint;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 SELECT backend_metadata->'erasure' INTO r FROM public.personal_agent_registry
 WHERE user_id=owner_id AND status='suspended' FOR UPDATE;
 IF r->>'attemptId' IS DISTINCT FROM attempt_id THEN RETURN false; END IF;
 state:=r->'azureTeardown';
 incoming:=state->'authorizationAttempts'->nonce_sha256;
 IF outcome='running' THEN
  incoming:=jsonb_build_object('purpose',purpose,'digest',auth_digest,'status','running','startedAt',now_seconds);
 ELSE
  IF incoming->>'purpose' IS DISTINCT FROM purpose OR incoming->>'digest' IS DISTINCT FROM auth_digest THEN RETURN false; END IF;
  incoming:=incoming||jsonb_build_object('status',outcome,'finishedAt',now_seconds,'code',code);
 END IF;
 state:=jsonb_set(state,'{authorizationAttempts}',coalesce(state->'authorizationAttempts','{}'::jsonb)||jsonb_build_object(nonce_sha256,incoming));
 RETURN public.retain_azure_erasure_state(owner_id,attempt_id,r,state);
END;
$$;

CREATE OR REPLACE FUNCTION public.valid_azure_erasure_append(owner_id text, prior jsonb, incoming jsonb)
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=public AS $$
DECLARE before_state jsonb:=coalesce(prior->'azureTeardown','{}'::jsonb);
 next_state jsonb:=incoming->'azureTeardown'; item record; old_resource jsonb; new_resource jsonb;
 approval jsonb; worker jsonb; stage text; receipt jsonb; definition jsonb; execution_id text;
BEGIN
 IF incoming-'azureTeardown' IS DISTINCT FROM prior-'azureTeardown'
 OR jsonb_typeof(next_state) IS DISTINCT FROM 'object'
 OR octet_length(next_state::text)>1048576
 OR next_state-ARRAY['plan','approvals','resources','worker','finalReadbacks','workerExits','setupHistory','authorizationAttempts']<>'{}'::jsonb THEN RETURN false; END IF;
 IF before_state='{}'::jsonb THEN
  RETURN next_state-ARRAY['plan','approvals','resources','setupHistory']='{}'::jsonb
   AND next_state->'setupHistory' IS NOT NULL
   AND next_state->'setupHistory'=public.azure_erasure_setup_history(owner_id)
   AND octet_length(next_state::text)<750000
   AND next_state->'approvals'='[]'::jsonb AND next_state->'resources'='{}'::jsonb
   AND public.valid_azure_erasure_plan(owner_id,next_state->'plan') IS TRUE;
 END IF;
 IF next_state->'setupHistory' IS DISTINCT FROM before_state->'setupHistory'
 OR next_state->'setupHistory' IS DISTINCT FROM public.azure_erasure_setup_history(owner_id)
 OR next_state->'plan' IS DISTINCT FROM before_state->'plan'
 OR public.valid_azure_erasure_plan(owner_id,next_state->'plan') IS NOT TRUE THEN RETURN false; END IF;
 IF public.valid_azure_cleanup_authorization_append(owner_id,before_state,next_state) IS TRUE THEN RETURN true; END IF;
 IF next_state-'approvals'=before_state-'approvals'
 AND jsonb_typeof(next_state->'approvals')='array'
 AND jsonb_array_length(next_state->'approvals')=jsonb_array_length(before_state->'approvals')+1
 AND (next_state->'approvals')-(jsonb_array_length(before_state->'approvals'))=before_state->'approvals'
 AND jsonb_array_length(next_state->'approvals')<=64 THEN
  approval:=(next_state->'approvals')->-1;
  RETURN approval-ARRAY['ownerId','attemptId','planDigest','issuedAt','expiresAt','scope','groupConfirmation']='{}'::jsonb
   AND approval->>'ownerId'=owner_id AND approval->>'attemptId'=prior->>'attemptId'
   AND approval->>'planDigest'=encode(sha256(convert_to((next_state->'plan')::text,'UTF8')),'hex')
   AND approval->>'scope'='exact_plan'
   AND approval->>'groupConfirmation'='/subscriptions/'||(next_state->'plan'->'context'->>'subscriptionId')||
     '/resourceGroups/'||(next_state->'plan'->'context'->>'resourceGroup')
   AND approval->'issuedAt'=to_jsonb(extract(epoch FROM statement_timestamp())::bigint)
   AND approval->'expiresAt'=to_jsonb(extract(epoch FROM statement_timestamp())::bigint+600);
 END IF;
 approval:=(before_state->'approvals')->-1;
 worker:=before_state->'worker'; execution_id:=worker->>'executionId';
 FOREACH stage IN ARRAY ARRAY['finalReadbacks','workerExits'] LOOP
  IF next_state-stage IS DISTINCT FROM before_state-stage THEN CONTINUE; END IF;
  IF public.byoc_azure_worker_session_held(owner_id) IS NOT TRUE
   OR worker->'backendPid' IS DISTINCT FROM to_jsonb(pg_backend_pid())
   OR jsonb_typeof(next_state->stage) IS DISTINCT FROM 'object'
   OR coalesce(before_state->stage,'{}'::jsonb) ? execution_id
   OR (next_state->stage)-execution_id IS DISTINCT FROM coalesce(before_state->stage,'{}'::jsonb)
   OR (SELECT count(*) FROM jsonb_each(next_state->stage))>128
   OR (before_state->'workerExits') ? execution_id THEN RETURN false; END IF;
  receipt:=(next_state->stage)->execution_id;
  RETURN receipt IS NOT NULL AND receipt=public.azure_erasure_execution_receipt(
    before_state,stage,receipt->>'outcome');
 END LOOP;
 IF next_state-'worker'=before_state-'worker' THEN
  worker:=next_state->'worker';
  RETURN public.byoc_azure_worker_session_held(owner_id) IS TRUE
   AND worker-ARRAY['executionId','backendPid','approvalIndex']='{}'::jsonb
   AND ((approval->>'expiresAt')::bigint>extract(epoch FROM statement_timestamp())) IS TRUE
   AND public.azure_erasure_writers_drained(owner_id) IS TRUE
   AND public.azure_cleanup_information_erased(owner_id,prior) IS TRUE
   AND octet_length(next_state::text)<900000
   AND (SELECT count(*) FROM jsonb_each(coalesce(before_state->'workerExits','{}'::jsonb)))<128
   AND (SELECT count(*) FROM jsonb_each(coalesce(before_state->'finalReadbacks','{}'::jsonb)))<128
   AND NOT (coalesce(before_state->'workerExits','{}'::jsonb) ? (worker->>'executionId'))
   AND NOT (coalesce(before_state->'finalReadbacks','{}'::jsonb) ? (worker->>'executionId'))
   AND (worker->>'executionId' ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$') IS TRUE
   AND worker->'backendPid'=to_jsonb(pg_backend_pid())
   AND worker->'approvalIndex'=to_jsonb(jsonb_array_length(before_state->'approvals')-1)
   AND (before_state->'worker' IS NULL OR before_state->'worker'->'backendPid' IS DISTINCT FROM to_jsonb(pg_backend_pid()));
 END IF;
 worker:=before_state->'worker';
 IF next_state-'resources' IS DISTINCT FROM before_state-'resources'
 OR public.byoc_azure_worker_session_held(owner_id) IS NOT TRUE
 OR worker->'backendPid' IS DISTINCT FROM to_jsonb(pg_backend_pid())
 OR jsonb_typeof(next_state->'resources') IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 FOR item IN SELECT * FROM jsonb_each(next_state->'resources') LOOP
  IF (next_state->'resources')-item.key IS DISTINCT FROM (before_state->'resources')-item.key THEN CONTINUE; END IF;
  definition:=next_state->'plan'->'resources'->item.key;
  IF definition IS NULL OR definition->'coveredBy'<>'null'::jsonb THEN RETURN false; END IF;
  old_resource:=coalesce(before_state->'resources'->item.key,'{}'::jsonb); new_resource:=item.value;
  IF new_resource-'providerHistory'=old_resource-ARRAY['providerHistory','provider_request','provider_ack','provider_terminal']
   AND NOT (coalesce(before_state->'finalReadbacks','{}'::jsonb) ? execution_id)
   AND NOT (coalesce(before_state->'workerExits','{}'::jsonb) ? execution_id)
   AND public.azure_erasure_request_retryable(old_resource) IS TRUE
   AND NOT old_resource ?| ARRAY['absence','acknowledgement']
   AND jsonb_typeof(new_resource->'providerHistory')='array'
   AND jsonb_array_length(new_resource->'providerHistory')<=8
   AND new_resource->'providerHistory'=coalesce(old_resource->'providerHistory','[]'::jsonb)||
     jsonb_build_array(old_resource-ARRAY['intent','providerHistory'])
   AND ((approval->>'expiresAt')::bigint>extract(epoch FROM statement_timestamp())) IS TRUE
   AND octet_length(next_state::text)<900000 THEN RETURN true; END IF;
  FOREACH stage IN ARRAY ARRAY['intent','provider_request','provider_ack','provider_terminal','acknowledgement','absence','retention'] LOOP
   IF old_resource ? stage OR new_resource-stage IS DISTINCT FROM old_resource THEN CONTINUE; END IF;
   IF stage IN ('intent','provider_request') AND (public.azure_erasure_writers_drained(owner_id) IS NOT TRUE
    OR coalesce(before_state->'finalReadbacks','{}'::jsonb) ? execution_id
    OR coalesce(before_state->'workerExits','{}'::jsonb) ? execution_id
    OR ((approval->>'expiresAt')::bigint>extract(epoch FROM statement_timestamp())) IS NOT TRUE) THEN RETURN false; END IF;
   receipt:=new_resource->stage;
   IF jsonb_typeof(receipt) IS DISTINCT FROM 'object' OR octet_length(receipt::text)>24576 THEN RETURN false; END IF;
   IF stage='intent' THEN
    RETURN definition->'identity'<>'null'::jsonb AND receipt=jsonb_build_object('identity',definition->'identity')
     AND octet_length(next_state::text)<900000;
   ELSIF stage='provider_request' THEN
    RETURN old_resource ? 'intent' AND receipt-ARRAY['requestId','method','path','apiVersion']='{}'::jsonb
     AND (receipt->>'requestId' ~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$') IS TRUE
     AND receipt->>'method'='DELETE' AND receipt->>'path'=item.key
     AND receipt->'apiVersion'=definition->'apiVersion' AND octet_length(next_state::text)<900000;
   ELSIF stage='provider_ack' THEN
    RETURN old_resource ? 'provider_request'
     AND receipt-ARRAY['requestId','status','operationUrl','operationUrlSha256','operationKind']='{}'::jsonb
     AND receipt->'requestId'=old_resource->'provider_request'->'requestId'
     AND public.valid_azure_arm_acknowledgement(receipt, '/subscriptions/'||
       (next_state->'plan'->'context'->>'subscriptionId')||'/resourceGroups/'||
       (next_state->'plan'->'context'->>'resourceGroup')) IS TRUE;
   ELSIF stage='provider_terminal' THEN
    RETURN old_resource ? 'provider_request' AND receipt-ARRAY['requestId','outcome']='{}'::jsonb
     AND receipt->'requestId'=old_resource->'provider_request'->'requestId'
     AND receipt->>'outcome' IN ('not_dispatched','refused','failed','succeeded')
     AND (receipt->>'outcome'='not_dispatched' OR old_resource ? 'provider_ack')
     AND (receipt->>'outcome'<>'succeeded' OR old_resource->'provider_ack'->>'status' IN ('200','201','202','204'));
   ELSIF stage='acknowledgement' THEN
    RETURN old_resource ? 'provider_request' AND public.azure_erasure_absence_settled(old_resource) IS TRUE
     AND receipt=jsonb_build_object('status','provider_completed','id',item.key);
   ELSIF stage='retention' THEN
    RETURN old_resource ? 'absence' AND public.valid_azure_retention_receipt(next_state->'plan',item.key,receipt) IS TRUE;
   ELSIF stage='absence' THEN
    RETURN public.azure_erasure_absence_settled(old_resource) IS TRUE
     AND receipt=jsonb_build_object('status','active_resource_absent','id',item.key);
   END IF;
  END LOOP;
 END LOOP;
 RETURN false;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.retain_azure_erasure_state(
 owner_id text, attempt_id text, expected jsonb, next_state jsonb
) RETURNS boolean LANGUAGE plpgsql VOLATILE SET search_path=public AS $$
DECLARE agent public.personal_agent_registry%ROWTYPE; r jsonb; candidate jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 SELECT * INTO agent FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 IF NOT FOUND OR agent.status IS DISTINCT FROM 'suspended' THEN RETURN false; END IF;
 r:=agent.backend_metadata->'erasure';
 IF r->>'ownerId' IS DISTINCT FROM owner_id OR r->>'attemptId' IS DISTINCT FROM attempt_id THEN RETURN false; END IF;
 IF r->'azureTeardown'=next_state THEN RETURN true; END IF;
 IF r IS DISTINCT FROM expected THEN RETURN false; END IF;
 candidate:=r||jsonb_build_object('azureTeardown',next_state);
 IF public.valid_azure_erasure_append(owner_id,r,candidate) IS NOT TRUE THEN RETURN false; END IF;
 UPDATE public.personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata,'{erasure}',candidate)
 WHERE user_id=owner_id;
 RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.retain_azure_erasure_execution_receipt(
 owner_id text, attempt_id text, execution_id text, stage text, outcome text, observed_ids jsonb
) RETURNS boolean LANGUAGE plpgsql VOLATILE SET search_path=public AS $$
DECLARE r jsonb; state jsonb; receipt jsonb; ids jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 SELECT backend_metadata->'erasure' INTO r FROM public.personal_agent_registry
 WHERE user_id=owner_id AND status='suspended' FOR UPDATE;
 state:=r->'azureTeardown';
 IF r->>'attemptId' IS DISTINCT FROM attempt_id
 OR state->'worker'->>'executionId' IS DISTINCT FROM execution_id
 OR public.byoc_azure_worker_session_held(owner_id) IS NOT TRUE
 OR state->'worker'->'backendPid' IS DISTINCT FROM to_jsonb(pg_backend_pid())
 OR (stage IN ('finalReadbacks','workerExits')) IS NOT TRUE THEN RETURN false; END IF;
 IF stage='finalReadbacks' THEN
  IF jsonb_typeof(observed_ids) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(observed_ids) NOT BETWEEN 1 AND 128 THEN RETURN false; END IF;
  SELECT jsonb_agg(value ORDER BY value) INTO ids FROM jsonb_array_elements_text(observed_ids);
  IF ids IS DISTINCT FROM (SELECT jsonb_agg(key ORDER BY key)
   FROM jsonb_each(state->'plan'->'resources') WHERE value->'coveredBy'='null'::jsonb)
  THEN RETURN false; END IF;
 ELSIF observed_ids IS NOT NULL THEN RETURN false; END IF;
 receipt:=public.azure_erasure_execution_receipt(state,stage,outcome);
 IF receipt IS NULL THEN RETURN false; END IF;
 state:=jsonb_set(state,ARRAY[stage],coalesce(state->stage,'{}'::jsonb)||
   jsonb_build_object(execution_id,receipt));
 RETURN public.retain_azure_erasure_state(owner_id,attempt_id,r,state);
END;
$$;

CREATE OR REPLACE FUNCTION public.approve_azure_erasure_plan(
 owner_id text, attempt_id text, expected_digest text, group_confirmation text
) RETURNS jsonb LANGUAGE plpgsql VOLATILE SET search_path=public AS $$
DECLARE agent public.personal_agent_registry%ROWTYPE; r jsonb; state jsonb; approval jsonb;
 now_seconds bigint:=extract(epoch FROM statement_timestamp())::bigint;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 SELECT * INTO agent FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 r:=agent.backend_metadata->'erasure'; state:=r->'azureTeardown';
 IF r->>'attemptId' IS DISTINCT FROM attempt_id OR public.valid_azure_erasure_plan(owner_id,state->'plan') IS NOT TRUE
 OR state->'plan'->>'termsVersion' IS DISTINCT FROM 'azure-exact-parent-retention-v2'
 OR group_confirmation IS DISTINCT FROM '/subscriptions/'||(state->'plan'->'context'->>'subscriptionId')||
    '/resourceGroups/'||(state->'plan'->'context'->>'resourceGroup')
 OR expected_digest IS DISTINCT FROM encode(sha256(convert_to((state->'plan')::text,'UTF8')),'hex') THEN RETURN NULL; END IF;
 approval:=state->'approvals'->-1;
 IF (approval->>'expiresAt')::bigint>now_seconds THEN RETURN approval; END IF;
 approval:=jsonb_build_object('ownerId',owner_id,'attemptId',attempt_id,'planDigest',expected_digest,
  'issuedAt',now_seconds,'expiresAt',now_seconds+600,'scope','exact_plan','groupConfirmation',group_confirmation);
 state:=jsonb_set(state,'{approvals}',(state->'approvals')||jsonb_build_array(approval));
 IF public.retain_azure_erasure_state(owner_id,attempt_id,r,state) IS NOT TRUE THEN RETURN NULL; END IF;
 RETURN approval;
END;
$$;

CREATE OR REPLACE FUNCTION public.begin_azure_erasure_worker(
 owner_id text, attempt_id text, execution_id text
) RETURNS boolean LANGUAGE plpgsql VOLATILE SET search_path=public AS $$
DECLARE agent public.personal_agent_registry%ROWTYPE; r jsonb; state jsonb; acquired boolean;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 IF public.byoc_azure_worker_session_held(owner_id) IS TRUE THEN RETURN false; END IF;
 acquired:=pg_try_advisory_lock(hashtextextended(owner_id,206));
 IF NOT acquired THEN RETURN false; END IF;
 SELECT * INTO agent FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 r:=agent.backend_metadata->'erasure'; state:=r->'azureTeardown';
 state:=state||jsonb_build_object('worker',jsonb_build_object('executionId',execution_id,
  'backendPid',pg_backend_pid(),'approvalIndex',jsonb_array_length(state->'approvals')-1));
 IF public.retain_azure_erasure_state(owner_id,attempt_id,r,state) IS NOT TRUE THEN
  PERFORM pg_advisory_unlock(hashtextextended(owner_id,206)); RETURN false;
 END IF;
 RETURN true;
EXCEPTION WHEN OTHERS THEN
 -- Closing the dedicated connection is also mandatory for the caller.
 IF acquired THEN PERFORM pg_advisory_unlock(hashtextextended(owner_id,206)); END IF;
 RAISE;
END;
$$;

CREATE OR REPLACE FUNCTION public.assert_azure_erasure_worker(
 owner_id text, attempt_id text, execution_id text
) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=public AS $$
DECLARE r jsonb; state jsonb; approval jsonb;
BEGIN
 SELECT backend_metadata->'erasure' INTO r FROM public.personal_agent_registry
 WHERE user_id=owner_id AND status='suspended';
 state:=r->'azureTeardown'; approval:=state->'approvals'->-1;
 RETURN r->>'attemptId'=attempt_id
 AND public.byoc_azure_worker_session_held(owner_id) IS TRUE
 AND public.azure_account_cleanup_ready() IS TRUE
 AND public.valid_azure_erasure_plan(owner_id,state->'plan') IS TRUE
 AND public.azure_erasure_writers_drained(owner_id) IS TRUE
 AND public.azure_cleanup_information_erased(owner_id,r) IS TRUE
 AND state->'worker'->>'executionId'=execution_id
 AND state->'worker'->'backendPid'=to_jsonb(pg_backend_pid())
 AND state->'worker'->'approvalIndex'=to_jsonb(jsonb_array_length(state->'approvals')-1)
 AND NOT (coalesce(state->'finalReadbacks','{}'::jsonb) ? execution_id)
 AND NOT (coalesce(state->'workerExits','{}'::jsonb) ? execution_id)
 AND (approval->>'expiresAt')::bigint>extract(epoch FROM statement_timestamp());
END;
$$;


CREATE OR REPLACE FUNCTION public.azure_erasure_authorization(owner_id text, purpose text)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=public AS $$
DECLARE context jsonb:=public.azure_erasure_context(owner_id); state jsonb; value jsonb; approval jsonb;
BEGIN
 IF context IS NULL OR (purpose IN ('inspect','execute')) IS NOT TRUE THEN RETURN NULL; END IF;
 value:=jsonb_build_object('purpose',purpose,'context',context);
 IF purpose='execute' THEN
  IF public.azure_erasure_writers_drained(owner_id) IS NOT TRUE THEN RETURN NULL; END IF;
  SELECT backend_metadata->'erasure'->'azureTeardown' INTO state
  FROM public.personal_agent_registry WHERE user_id=owner_id AND status='suspended';
  approval:=state->'approvals'->-1;
  IF public.valid_azure_erasure_plan(owner_id,state->'plan') IS NOT TRUE
  OR ((approval->>'expiresAt')::bigint>extract(epoch FROM statement_timestamp())) IS NOT TRUE
  OR approval->>'ownerId' IS DISTINCT FROM owner_id
  OR approval->>'attemptId' IS DISTINCT FROM context->>'attemptId'
  OR approval->>'scope' IS DISTINCT FROM 'exact_plan'
  OR approval->>'planDigest' IS DISTINCT FROM encode(sha256(convert_to((state->'plan')::text,'UTF8')),'hex')
  THEN RETURN NULL; END IF;
  value:=value||jsonb_build_object('approval',approval);
 END IF;
 RETURN value||jsonb_build_object('digest',encode(sha256(convert_to(value::text,'UTF8')),'hex'));
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_personal_agent_erasure_registry()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE reservation jsonb; snapshot jsonb;
BEGIN
  IF TG_OP='DELETE' AND public.personal_agent_erasure_archived(OLD.user_id,OLD.backend_metadata->'erasure') IS TRUE THEN RETURN OLD; END IF;
  IF OLD.backend_metadata ? 'erasure' THEN
    reservation := OLD.backend_metadata->'erasure';
    snapshot := reservation->'registrySnapshot';

    -- 962: one validated append to the existing owner resource-cleanup receipt.
    IF TG_OP='UPDATE' AND to_jsonb(NEW)-'backend_metadata'=to_jsonb(OLD)-'backend_metadata'
       AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
       AND public.valid_azure_erasure_append(OLD.user_id,OLD.backend_metadata->'erasure',
           NEW.backend_metadata->'erasure') IS TRUE THEN RETURN NEW; END IF;

    -- 956: one qualified receipt for the exact notification mutation frozen by erasure.
    IF TG_OP='UPDATE' AND to_jsonb(NEW)-'backend_metadata'=to_jsonb(OLD)-'backend_metadata'
       AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
       AND (NEW.backend_metadata->'erasure')-'lateNotificationObservation'=OLD.backend_metadata->'erasure'
       AND NOT (OLD.backend_metadata->'erasure' ? 'lateNotificationObservation')
       AND NOT (OLD.backend_metadata->'erasure' ? 'substrateInventory')
       AND public.valid_erasure_notification_observation(OLD.backend_metadata->'erasure',
           NEW.backend_metadata->'erasure'->'lateNotificationObservation') IS TRUE THEN RETURN NEW; END IF;

    IF TG_OP='UPDATE'
       AND to_jsonb(NEW)-'backend_metadata'=to_jsonb(OLD)-'backend_metadata'
       AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
       AND (NEW.backend_metadata->'erasure')-'lateFilesUpgradeObservation'=OLD.backend_metadata->'erasure'
       AND NOT (OLD.backend_metadata->'erasure' ? 'lateFilesUpgradeObservation')
       AND NOT (OLD.backend_metadata->'erasure' ? 'substrateInventory')
       AND public.valid_erasure_files_upgrade_observation(OLD.backend_metadata->'erasure',
           NEW.backend_metadata->'erasure'->'lateFilesUpgradeObservation') IS TRUE THEN RETURN NEW;
    END IF;

    -- The transaction-local marker coordinates the restore, but is caller-settable.
    -- Independently enforce the identity, tombstone and setup barriers here.
    IF TG_OP = 'UPDATE'
       AND current_setting('hussh.erasure_restore_attempt', true) = reservation->>'attemptId'
       AND reservation - ARRAY['version','ownerId','attemptId','hushhId','phase','registrySnapshot'] = '{}'::jsonb
       AND reservation->>'ownerId' = OLD.user_id
       AND OLD.status = 'suspended'
       AND snapshot->>'user_id' = OLD.user_id
       AND snapshot->>'hushh_id' = OLD.hushh_id
       AND reservation->>'phase' = 'reserved'
       AND snapshot->>'status' = 'provisioned'
       AND jsonb_typeof(snapshot->'backend_metadata') = 'object'
       AND NOT (snapshot->'backend_metadata' ? 'erasure')
       AND to_jsonb(NEW) - 'updated_at' = snapshot - 'updated_at'
    THEN
      IF current_setting('transaction_isolation') NOT IN ('read committed','read uncommitted') THEN
        RAISE EXCEPTION 'erasure restore requires a current snapshot' USING ERRCODE='42501';
      END IF;
      -- Match account erasure's owner-lock order. A direct writer holding the row
      -- must refuse a lock conflict rather than invert that order and deadlock.
      IF NOT pg_try_advisory_xact_lock(hashtextextended(OLD.user_id,171))
         OR NOT pg_try_advisory_xact_lock(hashtextextended(OLD.user_id,198)) THEN
        RAISE EXCEPTION 'erasure restore owner busy' USING ERRCODE='42501';
      END IF;
      IF EXISTS (SELECT 1 FROM public.personal_agent_deletion_tombstones WHERE hushh_id=OLD.hushh_id)
         OR EXISTS (SELECT 1 FROM public.account_deletion_tombstones
            WHERE user_id_hash='sha256:'||encode(sha256(convert_to(OLD.user_id,'UTF8')),'hex'))
         OR NOT EXISTS (SELECT 1 FROM public.byoc_setup_jobs
            WHERE user_id=OLD.user_id AND status='recorded' AND authorization_attempts='{}'::jsonb) THEN
        RAISE EXCEPTION 'erasure restore authority unavailable' USING ERRCODE='42501';
      END IF;
      RETURN NEW;
    END IF;

    IF TG_OP='UPDATE' AND to_jsonb(NEW)-'backend_metadata'=to_jsonb(OLD)-'backend_metadata'
       AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
       AND public.valid_erasure_files_append(OLD.backend_metadata->'erasure',NEW.backend_metadata->'erasure') IS TRUE THEN RETURN NEW; END IF;
    -- Only a bound late acknowledgement may be appended. It is not a terminal
    -- cleanup result and cannot alter identity, custody, status or the reservation.
    IF TG_OP = 'UPDATE'
       AND to_jsonb(NEW) - 'backend_metadata' = to_jsonb(OLD) - 'backend_metadata'
       AND NEW.backend_metadata - 'erasure' = OLD.backend_metadata - 'erasure'
       AND (NEW.backend_metadata->'erasure') - 'lateUpgradeAcknowledgement' =
           (OLD.backend_metadata->'erasure') - 'lateUpgradeAcknowledgement'
       AND NOT ((OLD.backend_metadata->'erasure') ? 'lateUpgradeAcknowledgement')
       AND public.valid_erasure_upgrade_ack(
           OLD.backend_metadata->'erasure', NEW.backend_metadata->'erasure'->'lateUpgradeAcknowledgement') THEN
      RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE'
       AND to_jsonb(NEW) - 'backend_metadata' = to_jsonb(OLD) - 'backend_metadata'
       AND NEW.backend_metadata - 'erasure' = OLD.backend_metadata - 'erasure'
       AND (NEW.backend_metadata->'erasure') - 'lateProvisionAcknowledgement' =
           (OLD.backend_metadata->'erasure') - 'lateProvisionAcknowledgement'
       AND NOT ((OLD.backend_metadata->'erasure') ? 'lateProvisionAcknowledgement')
       AND public.valid_erasure_provision_ack(OLD.backend_metadata->'erasure',
           NEW.backend_metadata->'erasure'->'lateProvisionAcknowledgement') THEN
      RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE'
       AND to_jsonb(NEW) - 'backend_metadata' = to_jsonb(OLD) - 'backend_metadata'
       AND NEW.backend_metadata - 'erasure' = OLD.backend_metadata - 'erasure'
       AND (NEW.backend_metadata->'erasure') - 'memoryBinding' =
           (OLD.backend_metadata->'erasure') - 'memoryBinding'
       AND NOT ((OLD.backend_metadata->'erasure') ? 'memoryBinding')
       AND public.valid_erasure_memory_binding(OLD.backend_metadata->'erasure',
           NEW.backend_metadata->'erasure'->'memoryBinding') THEN
      RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE'
       AND to_jsonb(NEW) - 'backend_metadata' = to_jsonb(OLD) - 'backend_metadata'
       AND NEW.backend_metadata - 'erasure' = OLD.backend_metadata - 'erasure'
       AND (NEW.backend_metadata->'erasure') - 'memoryDeletion' = (OLD.backend_metadata->'erasure') - 'memoryDeletion'
       AND NOT ((OLD.backend_metadata->'erasure') ? 'memoryDeletion')
       AND public.valid_erasure_memory_deletion(OLD.backend_metadata->'erasure',
           NEW.backend_metadata->'erasure'->'memoryDeletion') THEN RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE'
       AND to_jsonb(NEW) - 'backend_metadata' = to_jsonb(OLD) - 'backend_metadata'
       AND NEW.backend_metadata - 'erasure' = OLD.backend_metadata - 'erasure'
       AND public.valid_erasure_compute_append(OLD.backend_metadata->'erasure',NEW.backend_metadata->'erasure') THEN
      RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE'
       AND to_jsonb(NEW) - 'backend_metadata' = to_jsonb(OLD) - 'backend_metadata'
       AND NEW.backend_metadata - 'erasure' = OLD.backend_metadata - 'erasure'
       AND NOT (OLD.backend_metadata->'erasure' ? 'substrateInventory')
       AND (NEW.backend_metadata->'erasure') - 'substrateInventory' = OLD.backend_metadata->'erasure'
       AND public.valid_erasure_substrate_inventory(OLD.backend_metadata->'erasure',
           NEW.backend_metadata->'erasure'->'substrateInventory') THEN RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE'
       AND to_jsonb(NEW) - 'backend_metadata' = to_jsonb(OLD) - 'backend_metadata'
       AND NEW.backend_metadata - 'erasure' = OLD.backend_metadata - 'erasure'
       AND public.valid_erasure_writer_append(OLD.backend_metadata->'erasure',NEW.backend_metadata->'erasure') THEN
      RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE'
       AND to_jsonb(NEW) - 'backend_metadata' = to_jsonb(OLD) - 'backend_metadata'
       AND NEW.backend_metadata - 'erasure' = OLD.backend_metadata - 'erasure'
       AND public.valid_erasure_bucket_append(OLD.backend_metadata->'erasure',NEW.backend_metadata->'erasure') THEN
      RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE'
       AND to_jsonb(NEW) - 'backend_metadata' = to_jsonb(OLD) - 'backend_metadata'
       AND NEW.backend_metadata - 'erasure' = OLD.backend_metadata - 'erasure'
       AND public.valid_erasure_mail_append(OLD.backend_metadata->'erasure',NEW.backend_metadata->'erasure') THEN RETURN NEW; END IF;
    IF TG_OP = 'UPDATE'
       AND to_jsonb(NEW) - 'backend_metadata' = to_jsonb(OLD) - 'backend_metadata'
       AND NEW.backend_metadata - 'erasure' = OLD.backend_metadata - 'erasure'
       AND public.valid_erasure_kms_append(OLD.backend_metadata->'erasure',NEW.backend_metadata->'erasure') THEN RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE'
       AND to_jsonb(NEW) - 'backend_metadata' = to_jsonb(OLD) - 'backend_metadata'
       AND NEW.backend_metadata - 'erasure' = OLD.backend_metadata - 'erasure'
       AND public.valid_erasure_secret_append(OLD.backend_metadata->'erasure',NEW.backend_metadata->'erasure') THEN RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE'
       AND to_jsonb(NEW) - 'backend_metadata' = to_jsonb(OLD) - 'backend_metadata'
       AND NEW.backend_metadata - 'erasure' = OLD.backend_metadata - 'erasure'
       AND public.valid_erasure_account_append(OLD.backend_metadata->'erasure',NEW.backend_metadata->'erasure') THEN RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE'
       AND to_jsonb(NEW) - 'backend_metadata' = to_jsonb(OLD) - 'backend_metadata'
       AND NEW.backend_metadata - 'erasure' = OLD.backend_metadata - 'erasure'
       AND NOT (OLD.backend_metadata->'erasure' ? 'grantRelease')
       AND (NEW.backend_metadata->'erasure') - 'grantRelease'=OLD.backend_metadata->'erasure'
       AND public.valid_erasure_grant_release(OLD.backend_metadata->'erasure',NEW.backend_metadata->'erasure'->'grantRelease') IS TRUE
       AND public.project_grant_release_is_exclusive(OLD.user_id,NEW.backend_metadata->'erasure'->'grantRelease'->>'project') IS TRUE THEN RETURN NEW;
    END IF;
    IF TG_OP='UPDATE' AND to_jsonb(NEW)-'backend_metadata'=to_jsonb(OLD)-'backend_metadata'
       AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
       AND public.valid_erasure_runtime_grant_append(OLD.backend_metadata->'erasure',NEW.backend_metadata->'erasure') IS TRUE
       AND public.project_grant_release_is_exclusive(OLD.user_id,OLD.backend_metadata->'erasure'->'grantRelease'->>'project') IS TRUE THEN RETURN NEW; END IF;
    IF TG_OP = 'UPDATE'
       AND to_jsonb(NEW) - 'backend_metadata' = to_jsonb(OLD) - 'backend_metadata'
       AND NEW.backend_metadata - 'erasure' = OLD.backend_metadata - 'erasure'
       AND public.valid_erasure_repository_grant_append(OLD.backend_metadata->'erasure',NEW.backend_metadata->'erasure') IS TRUE
       AND public.project_grant_release_is_exclusive(OLD.user_id,OLD.backend_metadata->'erasure'->'grantRelease'->>'project') IS TRUE THEN RETURN NEW; END IF;
    IF TG_OP='UPDATE' AND to_jsonb(NEW)-'backend_metadata'=to_jsonb(OLD)-'backend_metadata'
       AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
       AND NOT (OLD.backend_metadata->'erasure' ? 'repositoryInventory')
       AND (NEW.backend_metadata->'erasure')-'repositoryInventory'=OLD.backend_metadata->'erasure'
       AND public.valid_erasure_repository_inventory(OLD.backend_metadata->'erasure',NEW.backend_metadata->'erasure'->'repositoryInventory') IS TRUE
       AND public.project_grant_release_is_exclusive(OLD.user_id,OLD.backend_metadata->'erasure'->'grantRelease'->>'project') IS TRUE THEN RETURN NEW; END IF;
    IF TG_OP='UPDATE' AND to_jsonb(NEW)-'backend_metadata'=to_jsonb(OLD)-'backend_metadata'
       AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
       AND NOT (OLD.backend_metadata->'erasure' ? 'repositoryRetention')
       AND (NEW.backend_metadata->'erasure')-'repositoryRetention'=OLD.backend_metadata->'erasure'
       AND public.valid_erasure_repository_retention(OLD.backend_metadata->'erasure',NEW.backend_metadata->'erasure'->'repositoryRetention') IS TRUE
       AND public.project_grant_release_is_exclusive(OLD.user_id,OLD.backend_metadata->'erasure'->'grantRelease'->>'project') IS TRUE THEN RETURN NEW; END IF;
    IF TG_OP='UPDATE' AND to_jsonb(NEW)-'backend_metadata'=to_jsonb(OLD)-'backend_metadata'
       AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
       AND NOT (OLD.backend_metadata->'erasure' ? 'bootstrapGrantRelease')
       AND (NEW.backend_metadata->'erasure')-'bootstrapGrantRelease'=OLD.backend_metadata->'erasure'
       AND NEW.backend_metadata->'erasure'->'bootstrapGrantRelease'=public.expected_erasure_bootstrap_release(OLD.user_id,OLD.backend_metadata->'erasure',NEW.backend_metadata->'erasure'->'bootstrapGrantRelease'->>'recoveryMember')
       AND public.project_grant_release_is_exclusive(OLD.user_id,OLD.backend_metadata->'erasure'->'grantRelease'->>'project') IS TRUE THEN RETURN NEW; END IF;
    IF TG_OP='UPDATE' AND to_jsonb(NEW)-'backend_metadata'=to_jsonb(OLD)-'backend_metadata'
       AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
       AND public.valid_erasure_bootstrap_append(OLD.backend_metadata->'erasure',NEW.backend_metadata->'erasure') IS TRUE
       AND public.project_grant_release_is_exclusive(OLD.user_id,OLD.backend_metadata->'erasure'->'grantRelease'->>'project') IS TRUE THEN RETURN NEW; END IF;
    -- Owner-access erasure (949): the pod's confirmation, once, before any revocation.
    IF TG_OP='UPDATE' AND to_jsonb(NEW)-'backend_metadata'=to_jsonb(OLD)-'backend_metadata'
       AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
       AND NOT (OLD.backend_metadata->'erasure' ? 'agentCryptoErase')
       AND NOT (OLD.backend_metadata->'erasure' ? 'ownerAccessErasure')
       AND (NEW.backend_metadata->'erasure')-'agentCryptoErase'=OLD.backend_metadata->'erasure'
       AND public.valid_erasure_owner_access_checkpoint(OLD.backend_metadata->'erasure',
           NEW.backend_metadata->'erasure'->'agentCryptoErase') IS TRUE THEN RETURN NEW; END IF;
    -- Owner-access erasure (949): one receipt, once, validated against the snapshot.
    IF TG_OP='UPDATE' AND to_jsonb(NEW)-'backend_metadata'=to_jsonb(OLD)-'backend_metadata'
       AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
       AND NOT (OLD.backend_metadata->'erasure' ? 'ownerAccessErasure')
       AND (NEW.backend_metadata->'erasure')-'ownerAccessErasure'=OLD.backend_metadata->'erasure'
       AND public.valid_erasure_owner_access(OLD.backend_metadata->'erasure',
           NEW.backend_metadata->'erasure'->'ownerAccessErasure') IS TRUE THEN RETURN NEW; END IF;
    -- Never-hosted erasure (954): the derived receipt and the project fence, once.
    IF TG_OP='UPDATE' AND to_jsonb(NEW)-'backend_metadata'=to_jsonb(OLD)-'backend_metadata'
       AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
       AND public.valid_erasure_never_hosted_append(OLD.user_id,OLD.backend_metadata->'erasure',
           NEW.backend_metadata->'erasure') IS TRUE
       AND public.project_grant_release_is_exclusive(OLD.user_id,
           NEW.backend_metadata->'erasure'->'grantRelease'->>'project') IS TRUE THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'personal agent erasure reserved' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;


-- Read-only status never substitutes for the common transaction's owner locks,
-- identity barriers, worker drain and archival checks.
CREATE OR REPLACE FUNCTION public.azure_erasure_resources_complete(owner_id text, r jsonb)
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=public AS $$
DECLARE state jsonb:=r->'azureTeardown'; context jsonb:=public.azure_erasure_context(owner_id);
 plan jsonb:=state->'plan'; worker jsonb:=state->'worker'; approval jsonb;
 final_receipt jsonb; exited jsonb; group_path text; parent_pattern text; item record;
BEGIN
 IF context IS NULL OR ((r->'registrySnapshot'->>'backend' IS DISTINCT FROM 'user_azure'
 OR r->'registrySnapshot'->>'deployment_target' IS DISTINCT FROM 'user_azure')
 AND public.azure_setup_never_deployed(owner_id,r->'registrySnapshot') IS NOT TRUE)
 OR nullif(r->'registrySnapshot'->>'user_cloud_project','') IS NOT NULL
 OR public.valid_azure_erasure_plan(owner_id,plan) IS NOT TRUE
 OR plan->>'termsVersion' IS DISTINCT FROM 'azure-exact-parent-retention-v2'
 OR public.azure_erasure_writers_drained(owner_id) IS NOT TRUE
 OR state->'setupHistory' IS DISTINCT FROM public.azure_erasure_setup_history(owner_id)
 OR public.azure_cleanup_information_erased(owner_id,r) IS NOT TRUE
 OR (r ? 'ownerAccessErasure' AND public.valid_erasure_owner_access(r,r->'ownerAccessErasure') IS NOT TRUE)
 OR nullif(worker->>'executionId','') IS NULL THEN RETURN false; END IF;
 group_path:='/subscriptions/'||(context->>'subscriptionId')||'/resourceGroups/'||(context->>'resourceGroup');
 IF plan->'resources'->group_path->>'deletionScope' IS DISTINCT FROM 'whole_group'
 OR plan->'resources'->group_path->'coveredBy' IS DISTINCT FROM 'null'::jsonb
 THEN RETURN false; END IF;
 -- Each cost/custody parent must have independent active-absence evidence.
 -- Runtime reconstruction additionally checks the complete canonical plan.
 FOREACH parent_pattern IN ARRAY ARRAY[
  '/Microsoft[.]App/containerApps/[^/]+$', '/Microsoft[.]App/managedEnvironments/[^/]+$',
  '/Microsoft[.]ManagedIdentity/userAssignedIdentities/[^/]+$', '/Microsoft[.]KeyVault/vaults/[^/]+$',
  '/Microsoft[.]Storage/storageAccounts/[^/]+$', '/Microsoft[.]ContainerRegistry/registries/[^/]+$',
  '/Microsoft[.]CognitiveServices/accounts/[^/]+$', '/Microsoft[.]CognitiveServices/accounts/[^/]+/deployments/one-chat$'
 ] LOOP
  IF (SELECT count(*) FROM jsonb_each(plan->'resources') x WHERE x.key ~ parent_pattern
    AND x.value->>'kind'='resource' AND x.value->'coveredBy'='null'::jsonb)<>1
  THEN RETURN false; END IF;
 END LOOP;
 -- An older setup may not hide writes to another group or another cloud.
 FOR item IN SELECT value FROM jsonb_array_elements(state->'setupHistory')
   WHERE value->>'stage'='azure_provider_request' LOOP
  IF NOT (item.value->>'path'=group_path OR starts_with(item.value->>'path',group_path||'/'))
   AND NOT (item.value->>'method'='POST' AND item.value->>'path' IN (
    '/subscriptions/'||(context->>'subscriptionId')||'/providers/Microsoft.App/register',
    '/subscriptions/'||(context->>'subscriptionId')||'/providers/Microsoft.ManagedIdentity/register',
    '/subscriptions/'||(context->>'subscriptionId')||'/providers/Microsoft.KeyVault/register',
    '/subscriptions/'||(context->>'subscriptionId')||'/providers/Microsoft.Storage/register',
    '/subscriptions/'||(context->>'subscriptionId')||'/providers/Microsoft.ContainerRegistry/register',
    '/subscriptions/'||(context->>'subscriptionId')||'/providers/Microsoft.CognitiveServices/register'))
  THEN RETURN false; END IF;
 END LOOP;
 approval:=state->'approvals'->((worker->>'approvalIndex')::integer);
 IF approval->>'ownerId' IS DISTINCT FROM owner_id
 OR approval->>'attemptId' IS DISTINCT FROM r->>'attemptId'
 OR approval->>'scope' IS DISTINCT FROM 'exact_plan'
 OR approval->>'groupConfirmation' IS DISTINCT FROM group_path
 OR approval->>'planDigest' IS DISTINCT FROM encode(sha256(convert_to(plan::text,'UTF8')),'hex')
 THEN RETURN false; END IF;
 -- Expiry governs new effects, not evidence of a completed authorized effect.
 final_receipt:=public.azure_erasure_execution_receipt(state,'finalReadbacks',NULL);
 exited:=public.azure_erasure_execution_receipt(state,'workerExits','returned');
 RETURN final_receipt IS NOT NULL AND exited IS NOT NULL
 AND state->'finalReadbacks'->(worker->>'executionId')=final_receipt
 AND state->'workerExits'->(worker->>'executionId')=exited;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.azure_cleanup_candidate_digest(snapshot jsonb)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path=public AS $$
 SELECT encode(sha256(convert_to((snapshot-ARRAY['last_heartbeat_at','health_state','liveness_failures'])::text,'UTF8')),'hex');
$$;

CREATE OR REPLACE FUNCTION public.reserve_azure_account_cleanup(owner_id text, expected_snapshot_sha256 text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SET search_path=public AS $$
DECLARE agent public.personal_agent_registry%ROWTYPE; snapshot jsonb; r jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 SELECT * INTO agent FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF (agent.backend_metadata ? 'erasure') IS NOT TRUE AND (expected_snapshot_sha256 IS NULL
  OR expected_snapshot_sha256 IS DISTINCT FROM public.azure_cleanup_candidate_digest(to_jsonb(agent))) THEN RETURN NULL; END IF;
 PERFORM 1 FROM public.byoc_setup_jobs WHERE user_id=owner_id FOR UPDATE;
 IF NOT pg_try_advisory_xact_lock(hashtextextended(owner_id,206)) THEN RETURN NULL; END IF;
 snapshot:=coalesce(agent.backend_metadata->'erasure'->'registrySnapshot',to_jsonb(agent));
 IF (snapshot->>'deployment_target' IS DISTINCT FROM 'user_azure'
 OR snapshot->>'backend' IS DISTINCT FROM 'user_azure'
 OR snapshot->>'status' IS DISTINCT FROM 'provisioned')
 AND public.azure_setup_never_deployed(owner_id,snapshot) IS NOT TRUE THEN RETURN NULL; END IF;
 r:=public.reserve_personal_agent_erasure(owner_id,replace(gen_random_uuid()::text,'-',''));
 IF r IS NULL OR public.azure_erasure_context(owner_id) IS NULL THEN
  RAISE EXCEPTION 'Azure cleanup reservation cannot be qualified';
 END IF;
 RETURN r;
END;
$$;

CREATE OR REPLACE FUNCTION public.personal_agent_erasure_complete(owner_id text)
RETURNS boolean LANGUAGE plpgsql VOLATILE SET search_path=public AS $$
DECLARE row_state public.personal_agent_registry%ROWTYPE; setup public.byoc_setup_jobs%ROWTYPE;
 r jsonb; release jsonb; expected_release jsonb; item record; stages jsonb; wanted jsonb;
 archive jsonb; table_name text; never_hosted boolean; azure_hosted boolean; group_scope text;
BEGIN
 IF owner_id IS NULL OR btrim(owner_id)='' OR current_setting('transaction_isolation')<>'read committed' THEN RETURN false; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 SELECT * INTO row_state FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 IF NOT FOUND OR row_state.status IS DISTINCT FROM 'suspended' THEN RETURN false; END IF;
 -- Own setup writers acquire their tuple before project205. Prelock it here,
 -- before project exclusivity, because finalization will delete it later.
 SELECT * INTO setup FROM public.byoc_setup_jobs WHERE user_id=owner_id FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 r:=row_state.backend_metadata->'erasure'; release:=r->'bootstrapGrantRelease';
 azure_hosted:=coalesce(r->'registrySnapshot'->>'deployment_target'='user_azure',false)
  OR public.azure_setup_never_deployed(owner_id,r->'registrySnapshot') IS TRUE;
 IF (NOT azure_hosted AND setup.status IS DISTINCT FROM 'recorded')
 OR (azure_hosted AND setup.status NOT IN ('recorded','failed')) THEN RETURN false; END IF;
 -- 954: a never-hosted reservation completes only on its SQL-re-derived evidence.
 never_hosted:=coalesce(r ? 'neverHosted',false);
 IF never_hosted AND public.erasure_never_hosted_admitted(owner_id,r) IS DISTINCT FROM true THEN RETURN false; END IF;
 IF r->>'ownerId' IS DISTINCT FROM owner_id OR r->'registrySnapshot'->>'user_id' IS DISTINCT FROM owner_id
 OR r->>'hushhId' IS DISTINCT FROM row_state.hushh_id OR row_state.hushh_id IS NULL OR row_state.hushh_id=''
 OR r->>'attemptId' IS NULL OR r->>'attemptId'=''
 OR (NOT azure_hosted AND jsonb_typeof(release) IS DISTINCT FROM 'object')
 OR r ?| ARRAY['lateUpgradeAcknowledgement','lateProvisionAcknowledgement']
 OR nullif(r->'registrySnapshot'->'backend_metadata'->>'upgradeLease','') IS NOT NULL
 OR (NOT azure_hosted AND NOT never_hosted AND r->'registrySnapshot'->'backend_metadata'->'provisionAttempt'->>'phase' IS DISTINCT FROM 'provisioned')
 OR (NOT azure_hosted AND setup.project_id IS DISTINCT FROM r->'registrySnapshot'->>'user_cloud_project') THEN RETURN false; END IF;
 IF azure_hosted THEN
  -- Nonblocking: actual workers hold206 until their real thread and exit persistence finish.
  IF (public.byoc_azure_worker_session_held(owner_id) IS TRUE
    AND r->'azureTeardown'->'worker'->'backendPid'=to_jsonb(pg_backend_pid()))
   OR NOT pg_try_advisory_xact_lock(hashtextextended(owner_id,206))
   OR public.azure_erasure_resources_complete(owner_id,r) IS NOT TRUE THEN RETURN false; END IF;
  group_scope:=setup.project_id;
  PERFORM pg_advisory_xact_lock(hashtextextended(group_scope,205));
  IF EXISTS(SELECT 1 FROM public.byoc_setup_jobs WHERE user_id<>owner_id AND project_id=group_scope)
   OR EXISTS(SELECT 1 FROM public.personal_agent_registry WHERE user_id<>owner_id
    AND '/subscriptions/'||user_cloud_subscription_id||'/resourceGroups/'||user_cloud_resource_group=group_scope)
  THEN RETURN false; END IF;
 ELSE
  IF public.project_grant_release_is_exclusive(owner_id,r->'grantRelease'->>'project') IS DISTINCT FROM true THEN RETURN false; END IF;
 END IF;
 -- The canonical identity barrier must cover late registry/setup/log/migration insertion.
 FOREACH table_name IN ARRAY ARRAY['personal_agent_registry','byoc_setup_jobs','pod_lifecycle_events','pod_migration_jobs'] LOOP
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||table_name)::regclass
   AND tgname='trg_reject_deleted_account_insert' AND tgtype=7 AND tgenabled IN ('O','A')
   AND tgfoid='public.reject_deleted_account_identity_write()'::regprocedure
   AND tgnargs=1 AND tgargs=decode('757365725f696400','hex') AND tgqual IS NULL) THEN RETURN false; END IF;
 END LOOP;
 IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_deletion_tombstones'::regclass
  AND tgname='zz_personal_agent_erasure_archive' AND tgtype=31 AND tgenabled IN ('O','A')
  AND tgfoid='public.guard_personal_agent_erasure_archive()'::regprocedure AND tgqual IS NULL AND tgnargs=0) THEN RETURN false; END IF;
 IF EXISTS (SELECT 1 FROM public.pod_migration_jobs WHERE user_id=owner_id)
 OR EXISTS (SELECT 1 FROM public.pod_lifecycle_events WHERE user_id=owner_id AND hushh_id IS NOT NULL AND hushh_id<>row_state.hushh_id)
 OR jsonb_typeof(setup.authorization_attempts) IS DISTINCT FROM 'object'
 OR EXISTS (SELECT 1 FROM jsonb_each(setup.authorization_attempts) h
   WHERE h.value->'intent'->>'project' IS DISTINCT FROM setup.project_id OR NOT h.value ? 'receipt') THEN RETURN false; END IF;
 IF NOT azure_hosted THEN
 IF NOT never_hosted AND (public.erasure_planned_resources_covered(r) IS DISTINCT FROM true
 OR public.valid_erasure_repository_grant_receipt(r,'deletion',r->'repositoryGrantErasure'->'deletion') IS DISTINCT FROM true
 OR public.valid_erasure_repository_retention(r,r->'repositoryRetention') IS DISTINCT FROM true) THEN RETURN false; END IF;
 expected_release:=public.expected_erasure_bootstrap_release(owner_id,r,release->>'recoveryMember');
 IF expected_release IS NULL OR release IS DISTINCT FROM expected_release
 OR jsonb_typeof(r->'bootstrapGrantErasure') IS DISTINCT FROM 'object'
 OR (SELECT array_agg(key ORDER BY key) FROM jsonb_each(r->'bootstrapGrantErasure')) IS DISTINCT FROM
    (SELECT array_agg(key ORDER BY key) FROM jsonb_each(release->'groups')) THEN RETURN false; END IF;
 FOR item IN SELECT * FROM jsonb_each(release->'groups') LOOP
  stages:=r->'bootstrapGrantErasure'->item.key;
  wanted:=jsonb_build_object('ownerId',owner_id,'attemptId',r->>'attemptId',
   'bootstrapIdentity',item.value->'bootstrapIdentity','bindingObservation',item.value->'bindingObservation');
  IF jsonb_typeof(stages) IS DISTINCT FROM 'object' OR stages-ARRAY['admission','acknowledgement','deletion']<>'{}'::jsonb
   OR stages->'admission' IS DISTINCT FROM wanted||jsonb_build_object('status','admitted')
   OR stages->'deletion' IS DISTINCT FROM wanted||jsonb_build_object('status','observed_absent')
   OR (stages ? 'acknowledgement' AND stages->'acknowledgement' IS DISTINCT FROM wanted||jsonb_build_object('status','acknowledged')) THEN RETURN false; END IF;
 END LOOP;
 END IF;
 archive:=public.personal_agent_erasure_archive(r,setup.authorization_attempts);
 IF octet_length(archive::text)>2097152 THEN RETURN false; END IF;
 IF EXISTS (SELECT 1 FROM public.personal_agent_deletion_tombstones t WHERE
  (t.hushh_id=row_state.hushh_id OR t.metadata->>'ownerId'=owner_id OR t.metadata->>'user_id'=owner_id)
  AND (t.status IS DISTINCT FROM 'erasure_completed' OR t.metadata IS DISTINCT FROM archive
       OR t.external_agent_id IS DISTINCT FROM row_state.external_agent_id)) THEN RETURN false; END IF;
 RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.azure_account_cleanup_ready()
RETURNS boolean LANGUAGE sql STABLE SET search_path=public AS $$
 SELECT (to_regprocedure('public.azure_erasure_resources_complete(text,jsonb)') IS NOT NULL
 AND to_regprocedure('public.reserve_azure_account_cleanup(text,text)') IS NOT NULL
 AND (SELECT value->'receipts'->'azureCleanup'=probe->'azureTeardown'
  AND value->'receipts'->'agentCryptoErase'=probe->'agentCryptoErase'
  AND value->'receipts'->'ownerAccessErasure'=probe->'ownerAccessErasure'
  FROM (SELECT jsonb_build_object('azureTeardown',jsonb_build_object('probe',true),
    'agentCryptoErase',jsonb_build_object('probe',true),
    'ownerAccessErasure',jsonb_build_object('probe',true)) probe) fixture
  CROSS JOIN LATERAL (SELECT public.personal_agent_erasure_archive(probe,'{}'::jsonb) value) checked)
 AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='trg_block_account_deletion_during_release'
  AND tgrelid IN ('public.actor_profiles'::regclass,'public.vault_keys'::regclass)
  AND tgenabled IN ('O','A'))) IS TRUE;
$$;

COMMIT;
