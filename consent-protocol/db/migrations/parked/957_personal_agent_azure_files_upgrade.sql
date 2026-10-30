-- Dev only. Retain bounded Azure Files obligations under the existing update CAS.
-- This does not settle an uncertain update or permit erasure through a held lease.
BEGIN;
DO $$ BEGIN
 IF to_regprocedure('public.valid_erasure_gcp_files_upgrade_observation(jsonb,jsonb)') IS NULL THEN
  ALTER FUNCTION public.valid_erasure_files_upgrade_observation(jsonb,jsonb)
   RENAME TO valid_erasure_gcp_files_upgrade_observation;
 END IF;
END $$;

CREATE OR REPLACE FUNCTION public.valid_erasure_azure_files_upgrade_observation(r jsonb, observation jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $$
DECLARE snapshot jsonb:=r->'registrySnapshot'; metadata jsonb:=snapshot->'backend_metadata';
 approval jsonb:=metadata->'upgradeApproval'; plan jsonb:=approval->'capabilityPlan';
 intent jsonb:=metadata->'filesUpgradeCheckpoint'; prefix jsonb:=intent->'completed';
 inventory jsonb:=metadata->'azureFilesInventory'; calls jsonb:=inventory->'plannedOperations';
 completed jsonb:=observation->'completed'; result jsonb; call jsonb; props jsonb; i int;
 group_path text; storage_path text; queue_path text; role_path text;
 steps text[]:=ARRAY['files_queue','files_custody_role','iam_files_custody','iam_files_queue'];
BEGIN
 IF jsonb_typeof(observation) IS DISTINCT FROM 'object'
 OR observation-ARRAY['version','provider','planDigest','operationId','attemptId','phase','step','completed']<>'{}'::jsonb
 OR observation->'version' IS DISTINCT FROM '2'::jsonb OR observation->>'provider' IS DISTINCT FROM 'user_azure'
 OR observation->>'phase' IS DISTINCT FROM 'observed' OR octet_length(observation::text)>32768
 OR plan->'version' IS DISTINCT FROM '2'::jsonb OR plan->>'provider' IS DISTINCT FROM 'user_azure'
 OR r->>'ownerId' IS DISTINCT FROM snapshot->>'user_id'
 OR r->>'hushhId' IS DISTINCT FROM snapshot->>'hushh_id'
 OR snapshot->>'deployment_target' IS DISTINCT FROM 'user_azure'
 OR plan->>'ownerId' IS DISTINCT FROM r->>'ownerId' OR plan->>'hushhId' IS DISTINCT FROM r->>'hushhId'
 OR plan->>'serviceUid' IS DISTINCT FROM metadata->>'serviceUid'
 OR plan->>'service' IS DISTINCT FROM snapshot->>'external_agent_id'
 OR plan->>'targetImage' IS DISTINCT FROM approval->>'targetImage'
 OR plan->>'tenantId' IS DISTINCT FROM snapshot->>'user_cloud_tenant_id'
 OR plan->>'subscriptionId' IS DISTINCT FROM snapshot->>'user_cloud_subscription_id'
 OR plan->>'resourceGroup' IS DISTINCT FROM snapshot->>'user_cloud_resource_group'
 OR plan->>'location' IS DISTINCT FROM snapshot->>'user_cloud_region'
 OR plan->>'principalId' IS DISTINCT FROM metadata->>'runtime_principal_id'
 OR plan->>'clientId' IS DISTINCT FROM metadata->>'runtime_client_id'
 OR coalesce(metadata->>'upgradeLease','')='' OR intent->>'phase' IS DISTINCT FROM 'intent'
 OR intent->>'planDigest' IS DISTINCT FROM approval->>'capabilityPlanDigest'
 OR coalesce(intent->>'planDigest','') !~ '^[a-f0-9]{64}$'
 OR intent->>'operationId' IS DISTINCT FROM approval->>'operationId'
 OR coalesce(intent->>'operationId','')=''
 OR intent->>'attemptId' IS DISTINCT FROM encode(sha256(convert_to(metadata->>'upgradeLease','UTF8')),'hex')
 OR observation-ARRAY['phase','completed'] IS DISTINCT FROM intent-ARRAY['phase','completed']
 OR jsonb_typeof(prefix) IS DISTINCT FROM 'array' OR jsonb_typeof(completed) IS DISTINCT FROM 'array'
 OR inventory->>'version' IS DISTINCT FROM 'azure.files.inventory.v1'
 OR inventory->>'ownerId' IS DISTINCT FROM plan->>'ownerId'
 OR inventory->>'hushhId' IS DISTINCT FROM plan->>'hushhId'
 OR inventory->>'serviceUid' IS DISTINCT FROM plan->>'serviceUid'
 OR inventory->>'tenantId' IS DISTINCT FROM plan->>'tenantId'
 OR inventory->>'subscriptionId' IS DISTINCT FROM plan->>'subscriptionId'
 OR inventory->>'resourceGroup' IS DISTINCT FROM plan->>'resourceGroup'
 OR inventory->>'setupNonce' IS DISTINCT FROM plan->>'setupNonce'
 OR inventory->>'planDigest' IS DISTINCT FROM approval->>'capabilityPlanDigest'
 OR jsonb_typeof(calls) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 IF jsonb_array_length(calls)<>4 OR jsonb_array_length(prefix)>=4
 OR observation->>'step' IS DISTINCT FROM steps[jsonb_array_length(prefix)+1]
 OR jsonb_array_length(completed)<>jsonb_array_length(prefix)+1
 OR completed-(jsonb_array_length(completed)-1) IS DISTINCT FROM prefix THEN RETURN false; END IF;
 group_path:='/subscriptions/'||(plan->>'subscriptionId')||'/resourceGroups/'||(plan->>'resourceGroup');
 storage_path:=plan->>'storageId'; queue_path:=storage_path||'/queueServices/default/queues/files-organization';
 role_path:=calls->1->>'path';
 IF coalesce(storage_path,'') !~ ('^'||group_path||'/providers/Microsoft.Storage/storageAccounts/[a-z0-9]{3,24}$')
 OR coalesce(role_path,'') !~ ('^'||group_path||'/providers/Microsoft.Authorization/roleDefinitions/[a-f0-9-]{36}$')
 THEN RETURN false; END IF;
 FOR i IN 0..3 LOOP
  call:=calls->i; props:=call->'body'->'properties';
  IF call->>'step' IS DISTINCT FROM steps[i+1]
   OR call-ARRAY['step','path','api','kind','body']<>'{}'::jsonb
   OR (call->'body')-'properties'<>'{}'::jsonb THEN RETURN false; END IF;
  IF i=0 THEN
   IF call->>'path' IS DISTINCT FROM queue_path OR call->>'kind' IS DISTINCT FROM 'resource'
    OR call->>'api' IS DISTINCT FROM 'storage' OR props IS DISTINCT FROM '{}'::jsonb THEN RETURN false; END IF;
  ELSIF i=1 THEN
   IF call->>'kind' IS DISTINCT FROM 'role_definition' OR call->>'api' IS DISTINCT FROM 'authorization'
    OR props-ARRAY['roleName','description','type','permissions','assignableScopes']<>'{}'::jsonb
    OR props->>'type' IS DISTINCT FROM 'CustomRole'
    OR props->'assignableScopes' IS DISTINCT FROM jsonb_build_array(group_path)
    OR props->'permissions' IS DISTINCT FROM jsonb_build_array(jsonb_build_object(
      'actions',jsonb_build_array('Microsoft.Storage/storageAccounts/read',
       'Microsoft.Storage/storageAccounts/blobServices/read','Microsoft.Storage/storageAccounts/blobServices/containers/read'),
      'notActions','[]'::jsonb)) THEN RETURN false; END IF;
  ELSE
   IF call->>'kind' IS DISTINCT FROM 'role_assignment' OR call->>'api' IS DISTINCT FROM 'authorization'
    OR coalesce(call->>'path','') !~ ('^'||CASE WHEN i=2 THEN storage_path ELSE queue_path END||'/providers/Microsoft.Authorization/roleAssignments/[a-f0-9-]{36}$')
    OR props-ARRAY['principalId','principalType','roleDefinitionId']<>'{}'::jsonb
    OR props->>'principalId' IS DISTINCT FROM plan->>'principalId'
    OR props->>'principalType' IS DISTINCT FROM 'ServicePrincipal'
    OR props->>'roleDefinitionId' IS DISTINCT FROM (CASE WHEN i=2 THEN
     '/subscriptions/'||(plan->>'subscriptionId')||'/providers/Microsoft.Authorization/roleDefinitions/'||split_part(role_path,'/roleDefinitions/',2) ELSE
     '/subscriptions/'||(plan->>'subscriptionId')||'/providers/Microsoft.Authorization/roleDefinitions/974c5e8b-45b9-4653-ba55-5f855dd0fb88' END)
   THEN RETURN false; END IF;
  END IF;
 END LOOP;
 FOR i IN 0..jsonb_array_length(completed)-1 LOOP
  result:=completed->i; call:=calls->i;
  IF result-ARRAY['step','ok','status','observation']<>'{}'::jsonb
   OR result->>'step' IS DISTINCT FROM steps[i+1]
   OR jsonb_typeof(result->'ok') IS DISTINCT FROM 'boolean'
   OR jsonb_typeof(result->'status') IS DISTINCT FROM 'number'
   OR coalesce(result->>'status','') !~ '^[0-9]{1,3}$' OR (result->>'status')::int>599 THEN RETURN false; END IF;
  IF result->'ok'='true'::jsonb THEN
   IF result->>'status' NOT IN ('200','201')
    OR result->'observation' IS DISTINCT FROM jsonb_build_object('id',call->>'path','kind',call->>'kind','properties',call->'body'->'properties')
   THEN RETURN false; END IF;
  ELSIF result ? 'observation' OR i<>jsonb_array_length(completed)-1 THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.valid_erasure_files_upgrade_observation(r jsonb, observation jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $$
BEGIN
 IF observation->'version'='2'::jsonb THEN
  RETURN public.valid_erasure_azure_files_upgrade_observation(r,observation);
 END IF;
 RETURN public.valid_erasure_gcp_files_upgrade_observation(r,observation);
END $$;

CREATE OR REPLACE FUNCTION public.effective_erasure_azure_files_inventory(r jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $$
DECLARE inventory jsonb:=r->'registrySnapshot'->'backend_metadata'->'azureFilesInventory';
 observation jsonb:=r->'lateFilesUpgradeObservation'; result jsonb;
BEGIN
 IF observation IS NULL THEN RETURN inventory; END IF;
 IF public.valid_erasure_azure_files_upgrade_observation(r,observation) IS DISTINCT FROM true THEN RETURN NULL; END IF;
 result:=observation->'completed'->-1;
 IF result->'ok'='true'::jsonb THEN
  inventory:=jsonb_set(inventory,'{observations}',coalesce(inventory->'observations','[]'::jsonb)||jsonb_build_array(result->'observation'),true);
 END IF;
 RETURN inventory;
END $$;

CREATE OR REPLACE FUNCTION public.azure_files_upgrade_admission_ready()
RETURNS boolean LANGUAGE sql STABLE SET search_path=public AS $$
 SELECT public.files_upgrade_admission_ready()
 AND to_regprocedure('public.valid_erasure_azure_files_upgrade_observation(jsonb,jsonb)') IS NOT NULL
 AND to_regprocedure('public.effective_erasure_azure_files_inventory(jsonb)') IS NOT NULL
 AND position('valid_erasure_azure_files_upgrade_observation' IN
   pg_get_functiondef('public.valid_erasure_files_upgrade_observation(jsonb,jsonb)'::regprocedure))>0;
$$;
COMMIT;
