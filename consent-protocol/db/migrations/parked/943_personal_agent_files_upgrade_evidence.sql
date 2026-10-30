-- Dev-only: retain the one in-flight Files result after erasure freezes an update.
-- Evidence retention never resumes provisioning or clears an unresolved lease.
BEGIN;
CREATE OR REPLACE FUNCTION public.valid_erasure_files_upgrade_observation(r jsonb, observation jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $$
DECLARE snapshot jsonb:=r->'registrySnapshot'; metadata jsonb:=snapshot->'backend_metadata';
 approval jsonb:=metadata->'upgradeApproval'; plan jsonb:=approval->'capabilityPlan';
 intent jsonb:=metadata->'filesUpgradeCheckpoint'; prefix jsonb:=intent->'completed';
 completed jsonb:=observation->'completed'; result jsonb; resource jsonb; ident jsonb; binding jsonb;
 project text:=plan->>'project'; region text:=plan->>'region'; step text:=intent->>'step';
 slug text:='one-files-'||left(encode(sha256(convert_to(r->>'hushhId','UTF8')),'hex'),20);
 worker text; queue text; expected_role text; expected_url text; expected_member text; project_number text;
 steps text[]:=ARRAY['enable_services','generate_files_task_identity','iam_files_task_identity',
  'iam_files_queue_admin','files_worker_account','files_queue','iam_files_enqueuer','iam_files_worker_actas',
  'iam_files_bucket_metadata','iam_files_invoker'];
BEGIN
 IF jsonb_typeof(observation) IS DISTINCT FROM 'object'
 OR observation-ARRAY['version','planDigest','operationId','attemptId','phase','step','completed']<>'{}'::jsonb
 OR observation->'version' IS DISTINCT FROM '1'::jsonb OR observation->>'phase' IS DISTINCT FROM 'observed'
 OR octet_length(observation::text)>65536
 OR r->>'ownerId' IS DISTINCT FROM snapshot->>'user_id'
 OR snapshot->>'deployment_target' IS DISTINCT FROM 'user_gcp'
 OR plan->>'ownerId' IS DISTINCT FROM r->>'ownerId' OR plan->>'hushhId' IS DISTINCT FROM r->>'hushhId'
 OR plan->>'serviceUid' IS DISTINCT FROM metadata->>'serviceUid'
 OR plan->>'targetImage' IS DISTINCT FROM approval->>'targetImage'
 OR plan->>'project' IS DISTINCT FROM snapshot->>'user_cloud_project'
 OR plan->>'region' IS DISTINCT FROM snapshot->>'user_cloud_region'
 OR plan->>'service' IS DISTINCT FROM snapshot->>'external_agent_id'
 OR plan->>'runtimeAccount' IS DISTINCT FROM metadata->>'runtime_service_account'
 OR plan->>'bootstrapAccount' IS DISTINCT FROM snapshot->>'user_cloud_bootstrap_sa'
 OR coalesce(metadata->>'upgradeLease','')='' OR intent->>'phase' IS DISTINCT FROM 'intent'
 OR intent->>'planDigest' IS DISTINCT FROM approval->>'capabilityPlanDigest'
 OR coalesce(intent->>'planDigest','') !~ '^[a-f0-9]{64}$'
 OR intent->>'operationId' IS DISTINCT FROM approval->>'operationId'
 OR coalesce(intent->>'operationId','')=''
 OR intent->>'attemptId' IS DISTINCT FROM encode(sha256(convert_to(metadata->>'upgradeLease','UTF8')),'hex')
 OR observation-ARRAY['phase','completed'] IS DISTINCT FROM intent-ARRAY['phase','completed']
 OR jsonb_typeof(prefix) IS DISTINCT FROM 'array' OR jsonb_typeof(completed) IS DISTINCT FROM 'array'
 THEN RETURN false; END IF;
 IF jsonb_array_length(prefix)>=cardinality(steps)
 OR step IS DISTINCT FROM steps[jsonb_array_length(prefix)+1]
 OR jsonb_array_length(completed)<>jsonb_array_length(prefix)+1
 OR completed-(jsonb_array_length(completed)-1) IS DISTINCT FROM prefix THEN RETURN false; END IF;
 result:=completed->-1;
 IF jsonb_typeof(result) IS DISTINCT FROM 'object'
 OR result-ARRAY['step','status','ok','skipped','resourceObservation','bindingObservations']<>'{}'::jsonb
 OR result->>'step' IS DISTINCT FROM step OR jsonb_typeof(result->'ok') IS DISTINCT FROM 'boolean'
 OR jsonb_typeof(result->'status') IS DISTINCT FROM 'number'
 OR coalesce(result->>'status','') !~ '^[0-9]{1,3}$'
 OR (result ? 'skipped' AND result->'skipped' IS DISTINCT FROM 'false'::jsonb)
 THEN RETURN false; END IF;
 SELECT x->'identity'->>'projectNumber' INTO project_number
 FROM jsonb_array_elements(metadata->'substrateReceipt'->'resourceObservations') x
 WHERE x->>'type'='gcs_bucket' AND x->>'id'=plan->>'bucket'
 AND x->'identity'->>'name'=plan->>'bucket';
 IF coalesce(project_number,'') !~ '^[1-9][0-9]{0,19}$' THEN RETURN false; END IF;
 worker:=slug||'@'||project||'.iam.gserviceaccount.com';
 queue:='projects/'||project||'/locations/'||region||'/queues/'||slug;
 resource:=result->'resourceObservation';
 IF resource IS NOT NULL THEN
  IF result->'ok' IS DISTINCT FROM 'true'::jsonb OR result->>'status' NOT IN ('200','201')
  OR jsonb_typeof(resource) IS DISTINCT FROM 'object'
  OR resource-ARRAY['type','id','disposition','identity']<>'{}'::jsonb
  OR resource->>'disposition' IS DISTINCT FROM 'created'
  OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(metadata->'substrateReceipt'->'plannedResources') x
     WHERE x=jsonb_build_object('type',resource->>'type','id',resource->>'id')) THEN RETURN false; END IF;
  ident:=resource->'identity';
  IF step='files_queue' THEN
   IF resource->>'type' IS DISTINCT FROM 'cloud_tasks_queue' OR resource->>'id' IS DISTINCT FROM slug
   OR ident IS DISTINCT FROM jsonb_build_object('name',queue,
    'rateLimits',jsonb_build_object('maxDispatchesPerSecond',1,'maxConcurrentDispatches',1),
    'retryConfig',jsonb_build_object('maxAttempts',3,'maxRetryDuration','0s','minBackoff','10s','maxBackoff','60s','maxDoublings',2))
   THEN RETURN false; END IF;
  ELSIF step='files_worker_account' THEN
   IF resource->>'type' IS DISTINCT FROM 'service_account' OR resource->>'id' IS DISTINCT FROM worker
   OR jsonb_typeof(ident) IS DISTINCT FROM 'object' OR ident-ARRAY['name','email','projectId','uniqueId']<>'{}'::jsonb
   OR ident->>'email' IS DISTINCT FROM worker OR ident->>'projectId' IS DISTINCT FROM project
   OR (coalesce(ident->>'uniqueId','') !~ '^[0-9]{1,32}$' OR ident->>'uniqueId' !~ '[1-9]')
   OR (ident->>'name' IS DISTINCT FROM 'projects/'||project||'/serviceAccounts/'||worker
       AND ident->>'name' IS DISTINCT FROM 'projects/'||project||'/serviceAccounts/'||(ident->>'uniqueId'))
   THEN RETURN false; END IF;
  ELSE RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(metadata->'substrateReceipt'->'resourceObservations','[]'::jsonb)) x
    WHERE x->>'type'=resource->>'type' AND x->>'id'=resource->>'id' AND x<>resource) THEN RETURN false; END IF;
 END IF;
 IF result ? 'bindingObservations' THEN
  IF jsonb_typeof(result->'bindingObservations') IS DISTINCT FROM 'array'
  OR jsonb_array_length(result->'bindingObservations')>1 THEN RETURN false; END IF;
  IF jsonb_array_length(result->'bindingObservations')>0 AND
    (result->'ok' IS DISTINCT FROM 'true'::jsonb OR result->>'status' NOT IN ('200','201')) THEN RETURN false; END IF;
  CASE step
   WHEN 'iam_files_queue_admin' THEN
    expected_role:='roles/cloudtasks.queueAdmin'; expected_member:='serviceAccount:'||(plan->>'bootstrapAccount');
    expected_url:='https://cloudresourcemanager.googleapis.com/v1/projects/'||project||':getIamPolicy';
   WHEN 'iam_files_task_identity' THEN
    expected_role:='roles/cloudtasks.serviceAgent'; expected_member:='serviceAccount:service-'||project_number||'@gcp-sa-cloudtasks.iam.gserviceaccount.com';
    expected_url:='https://cloudresourcemanager.googleapis.com/v1/projects/'||project||':getIamPolicy';
   WHEN 'iam_files_enqueuer' THEN
    expected_role:='roles/cloudtasks.enqueuer'; expected_member:='serviceAccount:'||(plan->>'runtimeAccount');
    expected_url:='https://cloudtasks.googleapis.com/v2/'||queue||':getIamPolicy';
   WHEN 'iam_files_worker_actas' THEN
    expected_role:='roles/iam.serviceAccountUser'; expected_member:='serviceAccount:'||(plan->>'runtimeAccount');
    expected_url:='https://iam.googleapis.com/v1/projects/'||project||'/serviceAccounts/'||worker||':getIamPolicy';
   WHEN 'iam_files_bucket_metadata' THEN
    expected_role:='roles/storage.legacyBucketReader'; expected_member:='serviceAccount:'||(plan->>'runtimeAccount');
    expected_url:='https://storage.googleapis.com/storage/v1/b/'||(plan->>'bucket')||'/iam';
   WHEN 'iam_files_invoker' THEN
    expected_role:='roles/run.invoker'; expected_member:='serviceAccount:'||worker;
    expected_url:='https://'||region||'-run.googleapis.com/v1/projects/'||project||'/locations/'||region||'/services/'||(plan->>'service')||':getIamPolicy';
   ELSE RETURN false;
  END CASE;
  FOR binding IN SELECT value FROM jsonb_array_elements(result->'bindingObservations') LOOP
   IF jsonb_typeof(binding) IS DISTINCT FROM 'object'
   OR binding-ARRAY['step','policyResource','role','member','disposition','beforeEtag','afterEtag']<>'{}'::jsonb
   OR binding->>'step' IS DISTINCT FROM step OR binding->>'policyResource' IS DISTINCT FROM expected_url
   OR binding->>'role' IS DISTINCT FROM expected_role
   OR coalesce(binding->>'disposition','') NOT IN ('added','already_present')
   OR jsonb_typeof(binding->'beforeEtag') IS DISTINCT FROM 'string' OR length(binding->>'beforeEtag') NOT BETWEEN 1 AND 512
   OR jsonb_typeof(binding->'afterEtag') IS DISTINCT FROM 'string' OR length(binding->>'afterEtag') NOT BETWEEN 1 AND 512
   OR (expected_member IS NOT NULL AND binding->>'member' IS DISTINCT FROM expected_member)
   OR (expected_member IS NULL AND coalesce(binding->>'member','') !~ '^serviceAccount:service-[1-9][0-9]*@gcp-sa-cloudtasks[.]iam[.]gserviceaccount[.]com$')
   THEN RETURN false; END IF;
  END LOOP;
 END IF;
 RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.effective_erasure_substrate_inventory(r jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $$
DECLARE inventory jsonb:=r->'registrySnapshot'->'backend_metadata'->'substrateReceipt';
 observation jsonb:=r->'lateFilesUpgradeObservation'; result jsonb; item jsonb; values_array jsonb;
BEGIN
 IF observation IS NULL THEN RETURN inventory; END IF;
 IF public.valid_erasure_files_upgrade_observation(r,observation) IS DISTINCT FROM true THEN RETURN NULL; END IF;
 result:=observation->'completed'->-1;
 IF result ? 'resourceObservation' THEN
  item:=result->'resourceObservation'; values_array:=coalesce(inventory->'resourceObservations','[]'::jsonb);
  IF NOT values_array @> jsonb_build_array(item) THEN values_array:=values_array||jsonb_build_array(item); END IF;
  inventory:=jsonb_set(inventory,'{resourceObservations}',values_array,true);
 END IF;
 IF result ? 'bindingObservations' THEN
  values_array:=coalesce(inventory->'bindingObservations','[]'::jsonb);
  FOR item IN SELECT value FROM jsonb_array_elements(result->'bindingObservations') LOOP
   IF NOT values_array @> jsonb_build_array(item) THEN values_array:=values_array||jsonb_build_array(item); END IF;
  END LOOP;
  inventory:=jsonb_set(inventory,'{bindingObservations}',values_array,true);
 END IF;
 RETURN inventory;
END;
$$;

CREATE OR REPLACE FUNCTION public.retain_erasure_files_upgrade_observation(owner_id text, lease text, observation jsonb)
RETURNS boolean LANGUAGE plpgsql SET search_path=public AS $$
DECLARE current_row public.personal_agent_registry%ROWTYPE; r jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 SELECT * INTO current_row FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 IF NOT FOUND OR current_row.status IS DISTINCT FROM 'suspended' THEN RETURN false; END IF;
 r:=current_row.backend_metadata->'erasure';
 IF r->>'ownerId' IS DISTINCT FROM owner_id
 OR lease IS NULL OR lease='' OR r->'registrySnapshot'->'backend_metadata'->>'upgradeLease' IS DISTINCT FROM lease
 OR public.valid_erasure_files_upgrade_observation(r,observation) IS DISTINCT FROM true THEN RETURN false; END IF;
 IF r ? 'lateFilesUpgradeObservation' THEN RETURN r->'lateFilesUpgradeObservation'=observation; END IF;
 IF r ? 'substrateInventory' THEN RETURN false; END IF;
 UPDATE public.personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata,
  ARRAY['erasure','lateFilesUpgradeObservation'],observation,true) WHERE user_id=owner_id;
 RETURN true;
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
    RAISE EXCEPTION 'personal agent erasure reserved' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.valid_erasure_substrate_inventory(reservation jsonb, inventory jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $$
BEGIN
 IF jsonb_typeof(inventory) IS DISTINCT FROM 'object'
    OR inventory IS DISTINCT FROM public.effective_erasure_substrate_inventory(reservation)
    OR inventory->>'version' IS DISTINCT FROM 'byoc.substrate.receipt.v1'
    OR jsonb_typeof(inventory->'plannedResources') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 IF jsonb_array_length(inventory->'plannedResources')=0 THEN RETURN false; END IF;
 RETURN coalesce(public.valid_erasure_compute_receipt(reservation,'computeDeletion',reservation->'computeDeletion'),false);
END;
$$;

CREATE OR REPLACE FUNCTION public.retain_erasure_substrate_inventory(
 owner_id text, attempt_id text, expected jsonb
) RETURNS boolean LANGUAGE plpgsql SET search_path=public AS $$
DECLARE current_row public.personal_agent_registry%ROWTYPE; reservation jsonb; inventory jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 SELECT * INTO current_row FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 IF NOT FOUND OR current_row.status IS DISTINCT FROM 'suspended' THEN RETURN false; END IF;
 reservation := current_row.backend_metadata->'erasure';
 -- Derive from the protected snapshot, never caller-supplied resource names.
 inventory := public.effective_erasure_substrate_inventory(reservation);
 IF reservation->>'ownerId' IS DISTINCT FROM owner_id
    OR reservation->>'attemptId' IS DISTINCT FROM attempt_id
    OR public.valid_erasure_substrate_inventory(reservation,inventory) IS DISTINCT FROM true THEN RETURN false; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_trigger
    WHERE tgrelid='public.personal_agent_registry'::regclass
      AND tgname='zz_personal_agent_erasure_registry' AND tgenabled IN ('O','A')
      AND tgtype=27 AND tgnargs=0 AND tgqual IS NULL
      AND tgfoid='public.guard_personal_agent_erasure_registry()'::regprocedure) THEN RETURN false; END IF;
 IF reservation ? 'substrateInventory' THEN RETURN reservation->'substrateInventory'=inventory; END IF;
 IF reservation IS DISTINCT FROM expected THEN RETURN false; END IF;
 UPDATE public.personal_agent_registry SET backend_metadata=jsonb_set(
    backend_metadata,ARRAY['erasure','substrateInventory'],inventory,true) WHERE user_id=owner_id;
 RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.files_upgrade_admission_ready()
RETURNS boolean LANGUAGE sql STABLE SET search_path=public AS $$
 SELECT to_regprocedure('public.retain_erasure_files_upgrade_observation(text,text,jsonb)') IS NOT NULL
 AND to_regprocedure('public.effective_erasure_substrate_inventory(jsonb)') IS NOT NULL
 AND EXISTS (SELECT 1 FROM pg_trigger
   WHERE tgrelid='public.personal_agent_registry'::regclass
   AND tgname='zz_personal_agent_erasure_registry' AND tgenabled IN ('O','A')
   AND tgtype=27 AND tgnargs=0 AND tgqual IS NULL
   AND tgfoid='public.guard_personal_agent_erasure_registry()'::regprocedure)
 AND position('valid_erasure_files_upgrade_observation' IN
   pg_get_functiondef('public.guard_personal_agent_erasure_registry()'::regprocedure))>0;
$$;
COMMIT;
