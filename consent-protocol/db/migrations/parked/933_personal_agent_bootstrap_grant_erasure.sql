-- Dev-only grouped bootstrap recovery admission. Existing owner reservation owns completion.
BEGIN;
CREATE OR REPLACE FUNCTION public.expected_erasure_bootstrap_release(owner_id text,r jsonb,recovery_member text)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=public AS $$
DECLARE history jsonb; job record; identity jsonb; binding jsonb; groups jsonb:='{}'::jsonb;
 g jsonb; k text; target_project text; recovery_key text; n integer:=0;
BEGIN
 IF public.valid_erasure_repository_retention(r,r->'repositoryRetention') IS DISTINCT FROM true THEN RETURN NULL; END IF;
 target_project:=r->'registrySnapshot'->>'user_cloud_project';
 SELECT authorization_attempts INTO history FROM public.byoc_setup_jobs WHERE user_id=owner_id;
 IF jsonb_typeof(history) IS DISTINCT FROM 'object' THEN RETURN NULL; END IF;
 FOR job IN SELECT key,value FROM jsonb_each(history) ORDER BY key LOOP
  IF job.value->'intent'->>'project' IS DISTINCT FROM target_project THEN CONTINUE; END IF;
  n:=n+1;
  IF n>1024 OR job.value->'intent'->>'ownerId' IS DISTINCT FROM owner_id
   OR job.value->'intent'->>'jobId' IS DISTINCT FROM job.key OR NOT (job.value ? 'receipt') THEN RETURN NULL; END IF;
  identity:=job.value->'receipt'->'bootstrapIdentity'; binding:=job.value->'receipt'->'bindingObservation';
  IF identity->>'projectId' IS DISTINCT FROM target_project OR binding->>'role' IS DISTINCT FROM 'roles/iam.serviceAccountTokenCreator'
   OR binding->>'member' IS DISTINCT FROM 'serviceAccount:'||(job.value->'intent'->>'callerEmail')
   OR (binding->>'disposition' IN ('added','already_present')) IS DISTINCT FROM true THEN RETURN NULL; END IF;
  k:=(identity->>'uniqueId')||'|'||(binding->>'member');
  IF k IS NULL THEN RETURN NULL; END IF;
  g:=groups->k;
  IF g IS NULL THEN g:=jsonb_build_object('jobIds','[]'::jsonb,'bootstrapIdentity',identity,'bindingObservation',NULL); END IF;
  IF g->'bootstrapIdentity' IS DISTINCT FROM identity THEN RETURN NULL; END IF;
  g:=jsonb_set(g,'{jobIds}',(g->'jobIds')||jsonb_build_array(job.key));
  IF binding->>'disposition'='added' AND g->'bindingObservation'='null'::jsonb THEN g:=jsonb_set(g,'{bindingObservation}',binding); END IF;
  groups:=jsonb_set(groups,ARRAY[k],g,true);
  IF binding->>'member'=recovery_member AND identity->>'email'=regexp_replace(r->'registrySnapshot'->>'user_cloud_bootstrap_sa','^serviceAccount:','') THEN
   IF recovery_key IS NOT NULL AND recovery_key<>k THEN RETURN NULL; END IF;
   recovery_key:=k;
  END IF;
 END LOOP;
 IF n=0 OR recovery_key IS NULL THEN RETURN NULL; END IF;
 FOR g IN SELECT value FROM jsonb_each(groups) LOOP
  IF g->'bindingObservation'='null'::jsonb THEN RETURN NULL; END IF;
 END LOOP;
 RETURN jsonb_build_object('ownerId',owner_id,'attemptId',r->>'attemptId','project',target_project,
  'groups',groups,'recoveryMember',recovery_member,'recoveryGrantKey',recovery_key,'status','reserved');
END;
$$;

CREATE OR REPLACE FUNCTION public.valid_erasure_bootstrap_append(old_r jsonb,new_r jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $$
DECLARE before_groups jsonb:=coalesce(old_r->'bootstrapGrantErasure','{}'::jsonb); after_groups jsonb:=new_r->'bootstrapGrantErasure';
 item record; stage record; original jsonb; wanted jsonb; captured_grant jsonb; changed integer:=0; additions integer; expected_status text;
BEGIN
 IF old_r-'bootstrapGrantErasure' IS DISTINCT FROM new_r-'bootstrapGrantErasure'
 OR jsonb_typeof(old_r->'bootstrapGrantRelease') IS DISTINCT FROM 'object'
 OR jsonb_typeof(after_groups) IS DISTINCT FROM 'object'
 OR NOT after_groups ?& ARRAY(SELECT jsonb_object_keys(before_groups)) THEN RETURN false; END IF;
 FOR item IN SELECT * FROM jsonb_each(after_groups) LOOP
  original:=coalesce(before_groups->item.key,'{}'::jsonb);
  IF original=item.value THEN CONTINUE; END IF;
  changed:=changed+1; additions:=0; captured_grant:=old_r->'bootstrapGrantRelease'->'groups'->item.key;
  IF captured_grant IS NULL OR jsonb_typeof(item.value) IS DISTINCT FROM 'object' OR original ? 'deletion'
   OR item.value - ARRAY['admission','acknowledgement','deletion']<>'{}'::jsonb
   OR NOT item.value ?& ARRAY(SELECT jsonb_object_keys(original)) OR NOT item.value ? 'admission' THEN RETURN false; END IF;
  FOR stage IN SELECT * FROM jsonb_each(item.value) LOOP
   IF original ? stage.key THEN IF original->stage.key IS DISTINCT FROM stage.value THEN RETURN false; END IF; CONTINUE; END IF;
   additions:=additions+1;
   expected_status:=CASE stage.key WHEN 'admission' THEN 'admitted' WHEN 'acknowledgement' THEN 'acknowledged' WHEN 'deletion' THEN 'observed_absent' END;
   wanted:=jsonb_build_object('ownerId',old_r->>'ownerId','attemptId',old_r->>'attemptId',
    'bootstrapIdentity',captured_grant->'bootstrapIdentity','bindingObservation',captured_grant->'bindingObservation','status',expected_status);
   IF stage.value IS DISTINCT FROM wanted OR (stage.key<>'admission' AND NOT original ? 'admission') THEN RETURN false; END IF;
  END LOOP;
  IF additions<>1 THEN RETURN false; END IF;
  -- The active recovery grant is admitted only after every other captured captured_grant is absent.
  IF item.key=old_r->'bootstrapGrantRelease'->>'recoveryGrantKey' AND NOT original ? 'admission' AND EXISTS (
   SELECT 1 FROM jsonb_object_keys(old_r->'bootstrapGrantRelease'->'groups') k
   WHERE k<>item.key AND before_groups->k->'deletion'->>'status' IS DISTINCT FROM 'observed_absent') THEN RETURN false; END IF;
 END LOOP;
 RETURN changed=1;
END;
$$;
CREATE OR REPLACE FUNCTION public.guard_personal_agent_erasure_registry()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF OLD.backend_metadata ? 'erasure' THEN
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

CREATE OR REPLACE FUNCTION public.reserve_erasure_bootstrap_grants(owner_id text,attempt_id text,expected jsonb,recovery_member text)
RETURNS boolean LANGUAGE plpgsql SET search_path=public AS $$
DECLARE current_row public.personal_agent_registry%ROWTYPE; r jsonb; receipt jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 SELECT * INTO current_row FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 IF NOT FOUND OR current_row.status IS DISTINCT FROM 'suspended' THEN RETURN false; END IF;
 r:=current_row.backend_metadata->'erasure';
 IF r->>'ownerId' IS DISTINCT FROM owner_id OR r->>'attemptId' IS DISTINCT FROM attempt_id THEN RETURN false; END IF;
 IF public.project_grant_release_is_exclusive(owner_id,r->'grantRelease'->>'project') IS DISTINCT FROM true THEN RETURN false; END IF;
 receipt:=public.expected_erasure_bootstrap_release(owner_id,r,recovery_member);
 IF receipt IS NULL THEN RETURN false; END IF;
 IF r ? 'bootstrapGrantRelease' THEN RETURN r->'bootstrapGrantRelease'=receipt; END IF;
 IF r IS DISTINCT FROM expected THEN RETURN false; END IF;
 UPDATE public.personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata,'{erasure,bootstrapGrantRelease}',receipt,true) WHERE user_id=owner_id;
 RETURN true;
END;
$$;
CREATE OR REPLACE FUNCTION public.retain_erasure_bootstrap_grant_receipt(owner_id text,attempt_id text,expected jsonb,grant_key text,stage text,receipt jsonb)
RETURNS boolean LANGUAGE plpgsql SET search_path=public AS $$
DECLARE current_row public.personal_agent_registry%ROWTYPE; r jsonb; candidate jsonb; groups jsonb; stages jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 SELECT * INTO current_row FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 IF NOT FOUND OR current_row.status IS DISTINCT FROM 'suspended' THEN RETURN false; END IF;
 r:=current_row.backend_metadata->'erasure';
 IF r->>'ownerId' IS DISTINCT FROM owner_id OR r->>'attemptId' IS DISTINCT FROM attempt_id THEN RETURN false; END IF;
 IF public.project_grant_release_is_exclusive(owner_id,r->'grantRelease'->>'project') IS DISTINCT FROM true THEN RETURN false; END IF;
 IF stage IS NULL OR stage NOT IN ('admission','acknowledgement','deletion') OR grant_key IS NULL OR NOT (r->'bootstrapGrantRelease'->'groups' ? grant_key) THEN RETURN false; END IF;
 IF r->'bootstrapGrantErasure'->grant_key ? stage THEN RETURN stage<>'admission' AND r->'bootstrapGrantErasure'->grant_key->stage=receipt; END IF;
 IF r IS DISTINCT FROM expected THEN RETURN false; END IF;
 groups:=coalesce(r->'bootstrapGrantErasure','{}'::jsonb); stages:=coalesce(groups->grant_key,'{}'::jsonb);
 stages:=jsonb_set(stages,ARRAY[stage],receipt,true); groups:=jsonb_set(groups,ARRAY[grant_key],stages,true);
 candidate:=jsonb_set(r,'{bootstrapGrantErasure}',groups,true);
 IF public.valid_erasure_bootstrap_append(r,candidate) IS DISTINCT FROM true THEN RETURN false; END IF;
 UPDATE public.personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata,'{erasure}',candidate,true) WHERE user_id=owner_id;
 RETURN true;
END;
$$;
COMMIT;
