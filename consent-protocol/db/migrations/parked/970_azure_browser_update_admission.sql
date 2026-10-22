-- Dev only. Config-only ACA Browser approval reuses existing owner Files delivery.
-- No queue, identity, scaler or IAM creation; legacy and VM admission stay intact.
BEGIN;

CREATE OR REPLACE FUNCTION public.valid_azure_browser_update_approval(agent jsonb, approval jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $$
DECLARE plan jsonb:=approval->'browserPlan'; installed jsonb:=plan->'installation';
 metadata jsonb:=agent->'backend_metadata'; expected_release text; group_path text;
BEGIN
 IF jsonb_typeof(approval) IS DISTINCT FROM 'object' OR jsonb_typeof(plan) IS DISTINCT FROM 'object'
 OR jsonb_typeof(installed) IS DISTINCT FROM 'object' OR octet_length(approval::text)>65536
 OR approval->'version' IS DISTINCT FROM '2'::jsonb OR approval->>'capability' IS DISTINCT FROM 'browser'
 OR approval->'capabilityPlan' IS NOT NULL OR approval->'capabilityPlanDigest' IS NOT NULL
 OR agent->>'deployment_target' IS DISTINCT FROM 'user_azure' OR agent->>'backend' IS DISTINCT FROM 'user_azure'
 OR agent->>'status' IS DISTINCT FROM 'provisioned' OR metadata ? 'erasure'
 OR metadata ? 'hostKind' OR metadata ? 'vmHost'
 OR coalesce(agent->>'pod_pubkey','')='' OR coalesce(agent->>'pod_key_id','')=''
 OR nullif(agent->>'user_cloud_authorized_at','') IS NULL
 OR approval->>'ownerId' IS DISTINCT FROM agent->>'user_id'
 OR approval->>'hushhId' IS DISTINCT FROM agent->>'hushh_id'
 OR approval->>'podIncarnation' IS DISTINCT FROM metadata->>'serviceUid'
 OR plan->'version' IS DISTINCT FROM '2'::jsonb OR plan->>'capability' IS DISTINCT FROM 'browser'
 OR plan->>'hostKind' IS DISTINCT FROM 'azure_container_apps'
 OR plan->>'ownerId' IS DISTINCT FROM agent->>'user_id'
 OR plan->>'hushhId' IS DISTINCT FROM agent->>'hushh_id'
 OR plan->>'podKeyId' IS DISTINCT FROM agent->>'pod_key_id'
 OR plan->'placementEpoch' IS DISTINCT FROM agent->'placement_epoch'
 OR plan->>'serviceUid' IS DISTINCT FROM metadata->>'serviceUid'
 OR plan->>'targetImage' IS DISTINCT FROM approval->>'targetImage'
 OR coalesce(approval->>'targetImage','') !~ '^.+@sha256:[a-f0-9]{64}$'
 OR coalesce(approval->>'browserPlanDigest','') !~ '^[a-f0-9]{64}$'
 OR coalesce(plan->>'qualificationDigest','') !~ '^[a-f0-9]{64}$'
 OR jsonb_typeof(plan->'publicPolicy') IS DISTINCT FROM 'object'
 OR jsonb_typeof(plan->'resourceLimits') IS DISTINCT FROM 'object'
 OR installed->'version' IS DISTINCT FROM '2'::jsonb OR installed->>'capability' IS DISTINCT FROM 'files'
 OR installed->>'provider' IS DISTINCT FROM 'user_azure'
 OR installed->>'ownerId' IS DISTINCT FROM agent->>'user_id'
 OR installed->>'hushhId' IS DISTINCT FROM agent->>'hushh_id'
 OR installed->>'serviceUid' IS DISTINCT FROM metadata->>'serviceUid'
 OR installed->>'service' IS DISTINCT FROM agent->>'external_agent_id'
 OR installed->>'targetImage' IS DISTINCT FROM approval->>'targetImage'
 OR installed->>'tenantId' IS DISTINCT FROM agent->>'user_cloud_tenant_id'
 OR installed->>'subscriptionId' IS DISTINCT FROM agent->>'user_cloud_subscription_id'
 OR installed->>'resourceGroup' IS DISTINCT FROM agent->>'user_cloud_resource_group'
 OR installed->>'location' IS DISTINCT FROM agent->>'user_cloud_region'
 OR installed->>'setupNonce' IS DISTINCT FROM metadata->>'setupNonce'
 OR installed->>'principalId' IS DISTINCT FROM metadata->>'runtime_principal_id'
 OR installed->>'clientId' IS DISTINCT FROM metadata->>'runtime_client_id'
 OR coalesce(installed->>'templateDigest','') !~ '^[a-f0-9]{64}$'
 OR coalesce(installed->>'createdAt','')='' OR coalesce(installed->>'readyRevision','')=''
 THEN RETURN false; END IF;
 group_path:='/subscriptions/'||(agent->>'user_cloud_subscription_id')||'/resourceGroups/'||(agent->>'user_cloud_resource_group');
 IF installed->>'service' IS DISTINCT FROM group_path||'/providers/Microsoft.App/containerApps/ca-hussh-one-pod'
 OR installed->>'identityId' IS DISTINCT FROM group_path||'/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-hussh-one-pod'
 OR coalesce(installed->>'storageId','') !~ ('^'||group_path||'/providers/Microsoft.Storage/storageAccounts/sthussh[a-f0-9]{16}$')
 THEN RETURN false; END IF;
 expected_release:='rel_'||left(encode(sha256(convert_to(concat_ws('|',
  approval->>'hushhId',approval->>'podIncarnation',approval->>'targetImage',
  'browser.v1',approval->>'browserPlanDigest'),'UTF8')),'hex'),32);
 RETURN approval->>'releaseId'=expected_release;
END $$;

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
  AND (approval->'version'='1'::jsonb OR public.valid_azure_browser_update_approval(to_jsonb(agent),approval))
  AND approval->>'ownerId'=agent.user_id
  AND approval->>'hushhId'=agent.hushh_id AND approval->>'podIncarnation'=metadata->>'serviceUid'
  AND approval->>'status' IN ('approved','scheduled','updating')
  AND approval->>'targetImage'=intent->>'sourceImage'
  AND approval->>'operationId'=intent->>'operationId' AND approval->>'releaseId'=intent->>'releaseId'
  AND approval->>'idempotencyKey'=intent->>'idempotencyKey'
  AND coalesce(approval->'capabilityPlanDigest','null'::jsonb)=intent->'capabilityPlanDigest';
END $$;

CREATE OR REPLACE FUNCTION public.azure_browser_update_admission_ready()
RETURNS boolean LANGUAGE sql STABLE SET search_path=public AS $$
 SELECT public.byoc_azure_setup_guards_ready()
 AND position('valid_azure_browser_update_approval' IN pg_get_functiondef(
  'public.byoc_azure_intent_admitted(public.personal_agent_registry,public.byoc_setup_jobs,jsonb,boolean)'::regprocedure))>0;
$$;
COMMIT;
