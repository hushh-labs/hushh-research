-- Refuse removing Browser admission while an owner retains its active offer.
BEGIN;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.personal_agent_registry WHERE deployment_target='user_azure'
  AND (backend_metadata->'upgradeApproval'->>'capability'='browser'
   OR backend_metadata->'browserCapability'->>'status'='configured')) THEN
  RAISE EXCEPTION 'Azure Browser owner configuration must be reconciled before rollback';
 END IF;
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
  AND approval->'version'='1'::jsonb AND approval->>'ownerId'=agent.user_id
  AND approval->>'hushhId'=agent.hushh_id AND approval->>'podIncarnation'=metadata->>'serviceUid'
  AND approval->>'status' IN ('approved','scheduled','updating')
  AND approval->>'targetImage'=intent->>'sourceImage'
  AND approval->>'operationId'=intent->>'operationId' AND approval->>'releaseId'=intent->>'releaseId'
  AND approval->>'idempotencyKey'=intent->>'idempotencyKey'
  AND coalesce(approval->'capabilityPlanDigest','null'::jsonb)=intent->'capabilityPlanDigest';
END $$;
DROP FUNCTION IF EXISTS public.azure_browser_update_admission_ready();
DROP FUNCTION IF EXISTS public.valid_azure_browser_update_approval(jsonb,jsonb);
COMMIT;
