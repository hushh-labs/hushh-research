-- Dev only. Owner-approved resource cleanup stays in the existing erasure record.
-- No credential or new lifecycle ledger. This does not declare physical purge.
BEGIN;

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
 OR plan->>'termsVersion' IS DISTINCT FROM 'azure-exact-parent-v1'
 OR jsonb_typeof(plan->'resources') IS DISTINCT FROM 'object'
 OR (SELECT count(*) FROM jsonb_each(plan->'resources')) NOT BETWEEN 1 AND 128
 OR octet_length(plan::text)>262144 THEN RETURN false; END IF;
 group_path:='/subscriptions/'||(context->>'subscriptionId')||
   '/resourceGroups/'||(context->>'resourceGroup');
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

CREATE OR REPLACE FUNCTION public.valid_azure_erasure_append(owner_id text, prior jsonb, incoming jsonb)
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=public AS $$
DECLARE before_state jsonb:=coalesce(prior->'azureTeardown','{}'::jsonb);
 next_state jsonb:=incoming->'azureTeardown'; item record; old_resource jsonb; new_resource jsonb;
 approval jsonb; worker jsonb; stage text; receipt jsonb; definition jsonb;
BEGIN
 IF incoming-'azureTeardown' IS DISTINCT FROM prior-'azureTeardown'
 OR jsonb_typeof(next_state) IS DISTINCT FROM 'object'
 OR octet_length(next_state::text)>1048576
 OR next_state-ARRAY['plan','approvals','resources','worker']<>'{}'::jsonb THEN RETURN false; END IF;
 IF before_state='{}'::jsonb THEN
  RETURN next_state-ARRAY['plan','approvals','resources']='{}'::jsonb
   AND next_state->'approvals'='[]'::jsonb AND next_state->'resources'='{}'::jsonb
   AND public.valid_azure_erasure_plan(owner_id,next_state->'plan') IS TRUE;
 END IF;
 IF next_state->'plan' IS DISTINCT FROM before_state->'plan'
 OR public.valid_azure_erasure_plan(owner_id,next_state->'plan') IS NOT TRUE THEN RETURN false; END IF;
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
 IF next_state-'worker'=before_state-'worker' THEN
  worker:=next_state->'worker';
  RETURN public.byoc_azure_worker_session_held(owner_id) IS TRUE
   AND worker-ARRAY['executionId','backendPid','approvalIndex']='{}'::jsonb
   AND ((approval->>'expiresAt')::bigint>extract(epoch FROM statement_timestamp())) IS TRUE
   AND public.azure_erasure_writers_drained(owner_id) IS TRUE
   AND public.erasure_provider_revocation_complete(prior) IS TRUE
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
   AND public.azure_erasure_request_retryable(old_resource) IS TRUE
   AND NOT old_resource ?| ARRAY['absence','acknowledgement']
   AND jsonb_typeof(new_resource->'providerHistory')='array'
   AND jsonb_array_length(new_resource->'providerHistory')<=8
   AND new_resource->'providerHistory'=coalesce(old_resource->'providerHistory','[]'::jsonb)||
     jsonb_build_array(old_resource-ARRAY['intent','providerHistory'])
   AND ((approval->>'expiresAt')::bigint>extract(epoch FROM statement_timestamp())) IS TRUE
   AND octet_length(next_state::text)<900000 THEN RETURN true; END IF;
  FOREACH stage IN ARRAY ARRAY['intent','provider_request','provider_ack','provider_terminal','acknowledgement','absence'] LOOP
   IF old_resource ? stage OR new_resource-stage IS DISTINCT FROM old_resource THEN CONTINUE; END IF;
   IF stage IN ('intent','provider_request') AND (public.azure_erasure_writers_drained(owner_id) IS NOT TRUE
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
 IF public.byoc_azure_worker_session_held(owner_id) IS TRUE THEN RETURN false; END IF;
 acquired:=pg_try_advisory_lock(hashtextextended(owner_id,206));
 IF NOT acquired THEN RETURN false; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
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
 AND public.valid_azure_erasure_plan(owner_id,state->'plan') IS TRUE
 AND public.azure_erasure_writers_drained(owner_id) IS TRUE
 AND public.erasure_provider_revocation_complete(r) IS TRUE
 AND state->'worker'->>'executionId'=execution_id
 AND state->'worker'->'backendPid'=to_jsonb(pg_backend_pid())
 AND state->'worker'->'approvalIndex'=to_jsonb(jsonb_array_length(state->'approvals')-1)
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

COMMIT;
