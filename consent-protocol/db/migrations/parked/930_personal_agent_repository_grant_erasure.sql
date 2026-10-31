-- Dev-only repository writer receipts in the existing erasure authority.
BEGIN;
CREATE OR REPLACE FUNCTION public.valid_erasure_repository_grant_receipt(r jsonb, stage text, receipt jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $$
DECLARE binding jsonb; identity jsonb; admitted jsonb;
BEGIN
 IF stage IS NULL OR stage NOT IN ('admission','acknowledgement','deletion') OR jsonb_typeof(receipt) IS DISTINCT FROM 'object'
 OR public.valid_erasure_grant_release(r,r->'grantRelease') IS DISTINCT FROM true THEN RETURN false; END IF;
 IF public.valid_erasure_runtime_grant_receipt(r,'deletion',r->'runtimeGrantErasure'->'deletion') IS DISTINCT FROM true THEN RETURN false; END IF;
 identity:=receipt->'repositoryIdentity'; binding:=receipt->'bindingObservation';
 IF jsonb_typeof(identity) IS DISTINCT FROM 'object'
 OR identity - ARRAY['name','format','createTime']<>'{}'::jsonb
 OR identity->>'name' IS DISTINCT FROM 'projects/'||(r->'grantRelease'->>'project')||'/locations/'||(r->'registrySnapshot'->>'user_cloud_region')||'/repositories/one-pod'
 OR identity->>'format' IS DISTINCT FROM 'DOCKER'
 OR (identity->>'createTime' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$') IS DISTINCT FROM true
 OR (SELECT count(*) FROM jsonb_array_elements(r->'substrateInventory'->'plannedResources') p WHERE p->>'type'='artifact_repository' AND p->>'id'='one-pod')<>1
 OR (SELECT count(*) FROM jsonb_array_elements(r->'substrateInventory'->'resourceObservations') o WHERE o=jsonb_build_object('type','artifact_repository','id','one-pod','disposition','created','identity',identity))<>1 THEN RETURN false; END IF;
 IF receipt - ARRAY['ownerId','attemptId','repositoryIdentity','bindingObservation','status']<>'{}'::jsonb
 OR receipt->>'ownerId' IS DISTINCT FROM r->>'ownerId' OR receipt->>'attemptId' IS DISTINCT FROM r->>'attemptId'
 OR receipt->'repositoryIdentity' IS DISTINCT FROM identity OR jsonb_typeof(binding) IS DISTINCT FROM 'object'
 OR binding - ARRAY['step','policyResource','role','member','disposition','beforeEtag','afterEtag']<>'{}'::jsonb
 OR binding->>'step' IS DISTINCT FROM 'artifact_repo_grant_copy_writer' OR binding->>'role' IS DISTINCT FROM 'roles/artifactregistry.writer'
 OR binding->>'disposition' IS DISTINCT FROM 'added'
 OR (binding->>'member' ~ '^serviceAccount:[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.gserviceaccount\.com$') IS DISTINCT FROM true
 OR binding->>'policyResource' IS DISTINCT FROM 'https://artifactregistry.googleapis.com/v1/'||(identity->>'name')||':getIamPolicy'
 OR coalesce(length(binding->>'beforeEtag'),0) NOT BETWEEN 1 AND 512 OR coalesce(length(binding->>'afterEtag'),0) NOT BETWEEN 1 AND 512
 OR (SELECT count(*) FROM jsonb_array_elements(r->'substrateInventory'->'bindingObservations') b WHERE b=binding)<>1 THEN RETURN false; END IF;
 IF stage='admission' THEN RETURN receipt->>'status'='admitted'; END IF;
 admitted:=r->'repositoryGrantErasure'->'admission';
 IF public.valid_erasure_repository_grant_receipt(r,'admission',admitted) IS DISTINCT FROM true OR receipt - 'status' IS DISTINCT FROM admitted - 'status' THEN RETURN false; END IF;
 IF stage='acknowledgement' THEN RETURN receipt->>'status'='acknowledged'; END IF;
 -- Fresh observed absence may reconcile a lost write acknowledgement; never fabricate it.
 RETURN receipt->>'status'='observed_absent';
END;
$$;
CREATE OR REPLACE FUNCTION public.valid_erasure_repository_grant_append(old_r jsonb,new_r jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $$
DECLARE old_s jsonb; new_s jsonb; stage text;
BEGIN
 old_s:=coalesce(old_r->'repositoryGrantErasure','{}'::jsonb); new_s:=new_r->'repositoryGrantErasure';
 IF new_r - 'repositoryGrantErasure' IS DISTINCT FROM old_r - 'repositoryGrantErasure' OR jsonb_typeof(new_s) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 FOREACH stage IN ARRAY ARRAY['admission','acknowledgement','deletion'] LOOP
  IF NOT (old_s ? stage) AND new_s - stage=old_s AND public.valid_erasure_repository_grant_receipt(old_r,stage,new_s->stage) IS TRUE THEN RETURN true; END IF;
 END LOOP;
 RETURN false;
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
    RAISE EXCEPTION 'personal agent erasure reserved' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;


CREATE OR REPLACE FUNCTION public.retain_erasure_repository_grant_receipt(owner_id text, attempt_id text, expected jsonb, stage text, receipt jsonb)
RETURNS boolean LANGUAGE plpgsql SET search_path=public AS $$
DECLARE current_row public.personal_agent_registry%ROWTYPE; r jsonb; s jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 SELECT * INTO current_row FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 IF NOT FOUND OR current_row.status IS DISTINCT FROM 'suspended' THEN RETURN false; END IF;
 r:=current_row.backend_metadata->'erasure';
 IF r->>'ownerId' IS DISTINCT FROM owner_id OR r->>'attemptId' IS DISTINCT FROM attempt_id
 OR public.valid_erasure_repository_grant_receipt(r,stage,receipt) IS DISTINCT FROM true THEN RETURN false; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_registry'::regclass
 AND tgname='zz_personal_agent_erasure_registry' AND tgenabled IN ('O','A') AND tgtype=27 AND tgnargs=0 AND tgqual IS NULL
 AND tgfoid='public.guard_personal_agent_erasure_registry()'::regprocedure) THEN RETURN false; END IF;
 IF public.project_grant_release_is_exclusive(owner_id,r->'grantRelease'->>'project') IS DISTINCT FROM true THEN RETURN false; END IF;
 s:=coalesce(r->'repositoryGrantErasure','{}'::jsonb);
 IF s ? stage THEN RETURN stage <> 'admission' AND s->stage=receipt; END IF;
 IF r IS DISTINCT FROM expected THEN RETURN false; END IF;
 UPDATE public.personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata,ARRAY['erasure','repositoryGrantErasure'],s || jsonb_build_object(stage,receipt),true) WHERE user_id=owner_id;
 RETURN true;
END;
$$;
COMMIT;
