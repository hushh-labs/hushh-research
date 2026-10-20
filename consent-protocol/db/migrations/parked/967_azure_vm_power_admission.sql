-- Dev qualification only. One bounded power cycle on the existing owner registry.
-- No host is installed or migrated by this migration. Azure VM offers stay closed.
BEGIN;

CREATE OR REPLACE FUNCTION public.azure_vm_power_binding(agent jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
 SELECT jsonb_build_object(
  'ownerId',agent->'user_id','hushhId',agent->'hushh_id',
  'status',agent->'status','backend',agent->'backend',
  'deploymentTarget',agent->'deployment_target','externalAgentId',agent->'external_agent_id',
  'placementEpoch',agent->'placement_epoch','podKeyId',agent->'pod_key_id',
  'podPublicKey',agent->'pod_pubkey','signingKeyId',agent->'pod_signing_key_id',
  'signingPublicKey',agent->'pod_signing_pubkey','tenantId',agent->'user_cloud_tenant_id',
  'subscriptionId',agent->'user_cloud_subscription_id',
  'resourceGroup',agent->'user_cloud_resource_group','region',agent->'user_cloud_region',
  'hostKind',agent->'backend_metadata'->'hostKind',
  'host',agent->'backend_metadata'->'vmHost',
  'url',agent->'backend_metadata'->'url','serviceUid',agent->'backend_metadata'->'serviceUid',
  'image',agent->'backend_metadata'->'image',
  'principalId',agent->'backend_metadata'->'runtime_principal_id',
  'clientId',agent->'backend_metadata'->'runtime_client_id');
$$;

CREATE OR REPLACE FUNCTION public.azure_vm_power_pending(metadata jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT metadata ? 'vmPower' AND
   (metadata->'vmPower'->>'phase' IS DISTINCT FROM 'ready');
$$;

CREATE OR REPLACE FUNCTION public.azure_vm_power_eligible(agent jsonb)
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=public AS $$
DECLARE m jsonb:=agent->'backend_metadata'; host jsonb:=m->'vmHost'; i jsonb:=host->'installation';
BEGIN
 RETURN coalesce(agent->>'status'='provisioned'
 AND agent->>'deployment_target'='user_azure' AND agent->>'backend'='user_azure'
 AND m->>'hostKind'='azure_vm' AND jsonb_typeof(host)='object'
 AND i->'version'='1'::jsonb AND i->>'hushh_id'=agent->>'hushh_id'
 AND lower(i->>'resource_id')=lower(agent->>'external_agent_id')
 AND lower(i->>'resource_id')=lower(format(
   '/subscriptions/%s/resourceGroups/%s/providers/Microsoft.Compute/virtualMachines/%s',
   agent->>'user_cloud_subscription_id',agent->>'user_cloud_resource_group',
   split_part(agent->>'external_agent_id','/',9)))
 AND i->>'generation'=m->>'serviceUid' AND i->>'client_id'=m->>'runtime_client_id'
 AND host->>'principalId'=m->>'runtime_principal_id' AND host->>'location'=agent->>'user_cloud_region'
 AND right(m->>'image',71)=i->>'image_digest'
 AND nullif(agent->>'pod_key_id','') IS NOT NULL AND nullif(agent->>'pod_pubkey','') IS NOT NULL
 AND nullif(agent->>'pod_signing_key_id','') IS NOT NULL
 AND nullif(agent->>'pod_signing_pubkey','') IS NOT NULL
 AND NOT m ?| ARRAY['erasure','upgradeLease','provisionAttempt']
 AND NOT EXISTS(SELECT 1 FROM personal_agent_deletion_tombstones WHERE hushh_id=agent->>'hushh_id')
 AND NOT EXISTS(SELECT 1 FROM account_deletion_tombstones
   WHERE cleanup_intent_kind='full_account'
   AND user_id_hash='sha256:'||encode(sha256(convert_to(agent->>'user_id','UTF8')),'hex'))
 AND NOT EXISTS(SELECT 1 FROM pod_migration_jobs WHERE user_id=agent->>'user_id')
 AND NOT EXISTS(SELECT 1 FROM personal_agent_standby_placements WHERE user_id=agent->>'user_id')
 AND NOT EXISTS(SELECT 1 FROM byoc_setup_jobs WHERE user_id=agent->>'user_id'
   AND status NOT IN ('recorded','failed')),false);
END;
$$;

CREATE OR REPLACE FUNCTION public.valid_azure_vm_power_event(state jsonb,event jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $$
DECLARE kind text:=event->>'kind'; events jsonb:=state->'events'; request jsonb;
 resource text:=state->'binding'->>'externalAgentId'; phase text:=state->>'phase';
BEGIN
 IF jsonb_typeof(event) IS DISTINCT FROM 'object' OR length(event::text)>8192
 THEN RETURN false; END IF;
 IF kind='drain' THEN
  RETURN coalesce(phase='preparing'
   AND event-ARRAY['kind','receipt']='{}'::jsonb
   AND (event->'receipt')-ARRAY['version','operationId','incarnation','runtimeEpoch','activeWork',
     'committedState','issuedAt','committedCursor','idleRecord']='{}'::jsonb
   AND event->'receipt'->'version'='1'::jsonb
   AND event->'receipt'->>'operationId'=state->>'operationId'
   AND event->'receipt'->>'incarnation'=state->'binding'->>'serviceUid'
   AND event->'receipt'->'activeWork'='0'::jsonb
   AND event->'receipt'->>'runtimeEpoch' ~ '^[A-Za-z0-9_-]+$'
   AND length(event->'receipt'->>'runtimeEpoch')<=256
   AND event->'receipt'->>'issuedAt' ~ '^[0-9T:.+Z-]{20,40}$'
   AND event->'receipt'->>'committedState' ~ '^[a-f0-9]{64}$'
   AND jsonb_typeof(event->'receipt'->'committedCursor'->'seq')='number'
   AND event->'receipt'->'committedCursor'->>'sha' ~ '^[a-f0-9]{64}$'
   AND jsonb_typeof(event->'receipt'->'idleRecord'->'seq')='number'
   AND event->'receipt'->'idleRecord'->>'sha' ~ '^[a-f0-9]{64}$'
   AND (event->'receipt'->'committedCursor')-ARRAY['seq','sha']='{}'::jsonb
   AND (event->'receipt'->'idleRecord')-ARRAY['seq','sha']='{}'::jsonb
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(events) e WHERE e->>'kind'='drain'),false);
 ELSIF kind='request' THEN
  RETURN coalesce(event-ARRAY['kind','requestId','method','path','apiVersion','purpose']='{}'::jsonb
   AND event->>'requestId' ~ '^[a-f0-9-]{36}$' AND event->>'method'='POST'
   AND event->>'apiVersion'='2024-03-01'
   AND ((phase='drained' AND event->>'path'=resource||'/deallocate'
     AND event->>'purpose'='vm_deallocate')
    OR (phase='starting' AND event->>'path'=resource||'/start' AND event->>'purpose'='vm_start'))
   -- Reserve the remaining acknowledgement, terminal and recovery events before
   -- dispatch. Nondispatch retries must not consume the last release slots.
   AND jsonb_array_length(events)+CASE WHEN phase='drained' THEN 10 ELSE 6 END<=16
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(events) e WHERE e->>'kind'='request'
     AND (e->>'requestId'=event->>'requestId' OR (e->>'purpose'=event->>'purpose'
       AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(events) terminal
         WHERE terminal->>'kind'='terminal' AND terminal->>'requestId'=e->>'requestId'
           AND terminal->>'outcome'='not_dispatched')))),false);
 ELSIF kind IN ('ack','terminal') THEN
  SELECT e INTO request FROM jsonb_array_elements(events) e
   WHERE e->>'kind'='request' AND e->>'requestId'=event->>'requestId';
  IF request IS NULL OR EXISTS(SELECT 1 FROM jsonb_array_elements(events) e
    WHERE e->>'kind'=kind AND e->>'requestId'=event->>'requestId') THEN RETURN false; END IF;
  IF kind='ack' THEN
   RETURN coalesce(event-ARRAY['kind','requestId','status','operationUrl','operationUrlSha256','operationKind']='{}'::jsonb
    AND public.valid_azure_arm_acknowledgement(event,request->>'path'),false);
  END IF;
  RETURN coalesce(event-ARRAY['kind','requestId','outcome']='{}'::jsonb
   AND event->>'outcome' IN ('succeeded','failed','refused','not_dispatched'),false);
 ELSIF kind='power' THEN
  RETURN coalesce(event-ARRAY['kind','resourceId','vmId','state']='{}'::jsonb
   AND event->>'resourceId'=resource
   AND event->>'vmId'=state->'binding'->'host'->'installation'->>'vm_id'
   AND ((phase='drained' AND event->>'state'='deallocated')
     OR (phase='starting' AND event->>'state'='running'))
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(events) e
     WHERE e->>'kind'='power' AND e->>'state'=event->>'state'),false);
 ELSIF kind='recovery' THEN
  RETURN coalesce(phase IN ('starting','recovered')
   AND event-ARRAY['kind','incarnation','podKeyId','imageDigest','retainedIdleRecord','runtimeEpoch']='{}'::jsonb
   AND event->>'incarnation'=state->'binding'->>'serviceUid'
   AND event->>'podKeyId'=state->'binding'->>'podKeyId'
   AND event->>'imageDigest'=state->'binding'->'host'->'installation'->>'image_digest'
   AND event->>'runtimeEpoch' ~ '^[A-Za-z0-9_-]+$'
   AND length(event->>'runtimeEpoch')<=256
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(events) e WHERE e->>'kind'='drain'
     AND e->'receipt'->'idleRecord'=event->'retainedIdleRecord'
     AND e->'receipt'->>'runtimeEpoch'<>event->>'runtimeEpoch')
   AND jsonb_array_length(events)+2<=16
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(events) e WHERE e->>'kind'='released')
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(events) e WHERE e->>'kind'='recovery'
     AND e->>'runtimeEpoch'=event->>'runtimeEpoch'),false);
 ELSIF kind='released' THEN
  RETURN coalesce(phase='recovered'
   AND event-ARRAY['kind','operationId','incarnation','runtimeEpoch','releaseRecord']='{}'::jsonb
   AND event->>'operationId'=state->>'operationId'
   AND event->>'incarnation'=state->'binding'->>'serviceUid'
   AND jsonb_typeof(event->'releaseRecord'->'seq')='number'
   AND event->'releaseRecord'->>'sha' ~ '^[a-f0-9]{64}$'
   AND (event->'releaseRecord')-ARRAY['seq','sha']='{}'::jsonb
   AND event->>'runtimeEpoch'=(SELECT e->>'runtimeEpoch'
     FROM jsonb_array_elements(events) WITH ORDINALITY items(e,n)
     WHERE e->>'kind'='recovery' ORDER BY n DESC LIMIT 1)
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(events) e WHERE e->>'kind'='released'),false);
 END IF;
 RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.azure_vm_power_phase_proven(state jsonb,phase text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE phase
 WHEN 'drained' THEN EXISTS(SELECT 1 FROM jsonb_array_elements(state->'events') e WHERE e->>'kind'='drain')
 WHEN 'deallocated' THEN EXISTS(SELECT 1 FROM jsonb_array_elements(state->'events') e
   WHERE e->>'kind'='power' AND e->>'state'='deallocated')
 WHEN 'starting' THEN state->>'phase'='deallocated'
 WHEN 'recovered' THEN EXISTS(SELECT 1 FROM jsonb_array_elements(state->'events') e WHERE e->>'kind'='recovery')
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(state->'events') e WHERE e->>'kind'='power' AND e->>'state'='running')
 WHEN 'ready' THEN EXISTS(SELECT 1 FROM jsonb_array_elements(state->'events') e
   WHERE e->>'kind'='released' AND e->>'runtimeEpoch'=(SELECT r->>'runtimeEpoch'
     FROM jsonb_array_elements(state->'events') WITH ORDINALITY items(r,n)
     WHERE r->>'kind'='recovery' ORDER BY n DESC LIMIT 1))
 ELSE false END
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(state->'events') request
   WHERE request->>'kind'='request' AND NOT EXISTS(
    SELECT 1 FROM jsonb_array_elements(state->'events') terminal
    WHERE terminal->>'kind'='terminal' AND terminal->>'requestId'=request->>'requestId'));
$$;

-- Exact CAS progression is additionally validated by the typed provider adapter.
-- Direct callers cannot discard an uncertain operation or change its host.
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

DROP TRIGGER IF EXISTS zw_azure_vm_power ON public.personal_agent_registry;
CREATE TRIGGER zw_azure_vm_power BEFORE INSERT OR UPDATE OR DELETE
 ON public.personal_agent_registry FOR EACH ROW EXECUTE FUNCTION public.guard_azure_vm_power_registry();

CREATE OR REPLACE FUNCTION public.guard_azure_vm_power_standby()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
DECLARE owner_id text:=CASE WHEN TG_OP='DELETE' THEN OLD.user_id ELSE NEW.user_id END; metadata jsonb;
BEGIN
 IF NOT pg_try_advisory_xact_lock(hashtextextended(owner_id,171))
 OR NOT pg_try_advisory_xact_lock(hashtextextended(owner_id,198)) THEN
  RAISE EXCEPTION 'VM placement is busy' USING ERRCODE='42501';
 END IF;
 SELECT backend_metadata INTO metadata FROM personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 IF metadata->>'hostKind'='azure_vm'
   AND current_setting('transaction_isolation') NOT IN ('read committed','read uncommitted') THEN
  RAISE EXCEPTION 'VM placement requires a current snapshot' USING ERRCODE='42501';
 END IF;
 IF public.azure_vm_power_pending(metadata) THEN
  RAISE EXCEPTION 'VM power requires reconciliation before standby changes' USING ERRCODE='42501';
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$;
DROP TRIGGER IF EXISTS zw_azure_vm_power_standby ON public.personal_agent_standby_placements;
CREATE TRIGGER zw_azure_vm_power_standby BEFORE INSERT OR UPDATE OR DELETE
 ON public.personal_agent_standby_placements FOR EACH ROW
 EXECUTE FUNCTION public.guard_azure_vm_power_standby();

-- Preserve the exact cycle across other lifecycle admissions. These guards do
-- not replace existing erasure, setup, account or placement policies.
DROP TRIGGER IF EXISTS zv_azure_vm_power ON public.byoc_setup_jobs;
CREATE TRIGGER zv_azure_vm_power BEFORE INSERT OR UPDATE OR DELETE ON public.byoc_setup_jobs
 FOR EACH ROW EXECUTE FUNCTION public.guard_azure_vm_power_standby();
DROP TRIGGER IF EXISTS zv_azure_vm_power ON public.pod_migration_jobs;
CREATE TRIGGER zv_azure_vm_power BEFORE INSERT OR UPDATE OR DELETE ON public.pod_migration_jobs
 FOR EACH ROW EXECUTE FUNCTION public.guard_azure_vm_power_standby();

CREATE OR REPLACE FUNCTION public.guard_azure_vm_power_deletion()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
DECLARE item jsonb:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 owner_id text; metadata jsonb;
BEGIN
 SELECT user_id INTO owner_id FROM personal_agent_registry
 WHERE (TG_TABLE_NAME='personal_agent_deletion_tombstones' AND hushh_id=item->>'hushh_id')
 OR (TG_TABLE_NAME='account_deletion_tombstones' AND item->>'cleanup_intent_kind'='full_account'
   AND item->>'user_id_hash'='sha256:'||encode(sha256(convert_to(user_id,'UTF8')),'hex'));
 IF owner_id IS NOT NULL THEN
  IF NOT pg_try_advisory_xact_lock(hashtextextended(owner_id,171))
    OR NOT pg_try_advisory_xact_lock(hashtextextended(owner_id,198)) THEN
   RAISE EXCEPTION 'VM deletion is busy' USING ERRCODE='42501';
  END IF;
  SELECT backend_metadata INTO metadata FROM personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
  IF metadata->>'hostKind'='azure_vm'
   AND current_setting('transaction_isolation') NOT IN ('read committed','read uncommitted') THEN
   RAISE EXCEPTION 'VM deletion requires a current snapshot' USING ERRCODE='42501';
  END IF;
  IF public.azure_vm_power_pending(metadata) THEN
   RAISE EXCEPTION 'VM power requires reconciliation before deletion' USING ERRCODE='42501';
  END IF;
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$;
DROP TRIGGER IF EXISTS zv_azure_vm_power ON public.personal_agent_deletion_tombstones;
CREATE TRIGGER zv_azure_vm_power BEFORE INSERT OR UPDATE OR DELETE
 ON public.personal_agent_deletion_tombstones FOR EACH ROW
 EXECUTE FUNCTION public.guard_azure_vm_power_deletion();
DROP TRIGGER IF EXISTS zv_azure_vm_power ON public.account_deletion_tombstones;
CREATE TRIGGER zv_azure_vm_power BEFORE INSERT OR UPDATE OR DELETE
 ON public.account_deletion_tombstones FOR EACH ROW
 EXECUTE FUNCTION public.guard_azure_vm_power_deletion();

COMMIT;
