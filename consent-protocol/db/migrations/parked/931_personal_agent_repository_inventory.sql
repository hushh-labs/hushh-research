-- Dev-only unresolved image observation; never cleanup completion authority.
BEGIN;
CREATE OR REPLACE FUNCTION public.valid_erasure_repository_inventory(r jsonb, receipt jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $$
DECLARE ident jsonb; image jsonb; prefix text; name_prefix text; admitted jsonb; deleted jsonb;
BEGIN
 -- The immutable predecessor was validated on its original guarded append.
 -- This unresolved observation adds no cleanup authority; do not recursively
 -- revalidate every earlier KMS/mail/account checkpoint for an inventory read.
 admitted:=r->'repositoryGrantErasure'->'admission'; deleted:=r->'repositoryGrantErasure'->'deletion';
 IF jsonb_typeof(admitted) IS DISTINCT FROM 'object' OR jsonb_typeof(deleted) IS DISTINCT FROM 'object'
 OR admitted->>'ownerId' IS DISTINCT FROM r->>'ownerId' OR admitted->>'attemptId' IS DISTINCT FROM r->>'attemptId'
 OR admitted->>'status' IS DISTINCT FROM 'admitted' OR deleted->>'status' IS DISTINCT FROM 'observed_absent'
 OR deleted - 'status' IS DISTINCT FROM admitted - 'status'
 OR jsonb_typeof(r->'substrateInventory'->'resourceObservations') IS DISTINCT FROM 'array'
 OR jsonb_typeof(receipt) IS DISTINCT FROM 'object' 
 OR receipt - ARRAY['ownerId','attemptId','repositoryIdentity','images','paginationComplete','classification']<>'{}'::jsonb
 OR receipt->>'ownerId' IS DISTINCT FROM r->>'ownerId'
 OR receipt->>'attemptId' IS DISTINCT FROM r->>'attemptId'
 OR receipt->'paginationComplete' IS DISTINCT FROM 'true'::jsonb
 OR receipt->>'classification' IS DISTINCT FROM 'unresolved'
 OR receipt->'repositoryIdentity' IS DISTINCT FROM r->'repositoryGrantErasure'->'deletion'->'repositoryIdentity'
 OR jsonb_typeof(receipt->'images') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 ident:=receipt->'repositoryIdentity';
 IF jsonb_typeof(ident) IS DISTINCT FROM 'object'
 OR ident->>'name' IS DISTINCT FROM 'projects/'||(r->'registrySnapshot'->>'user_cloud_project')||'/locations/'||(r->'registrySnapshot'->>'user_cloud_region')||'/repositories/one-pod'
 OR (SELECT count(*) FROM jsonb_array_elements(r->'substrateInventory'->'resourceObservations') o
     WHERE o=jsonb_build_object('type','artifact_repository','id','one-pod','disposition','created','identity',ident))<>1 THEN RETURN false; END IF;
 prefix:=(r->'registrySnapshot'->>'user_cloud_region')||'-docker.pkg.dev/'||(r->'grantRelease'->>'project')||'/one-pod/';
 name_prefix:=(ident->>'name')||'/dockerImages/';
 IF jsonb_array_length(receipt->'images')>10000 THEN RETURN false; END IF;
 FOR image IN SELECT * FROM jsonb_array_elements(receipt->'images') LOOP
  IF jsonb_typeof(image) IS DISTINCT FROM 'object' OR image - ARRAY['name','uri']<>'{}'::jsonb
  OR jsonb_typeof(image->'name') IS DISTINCT FROM 'string' OR jsonb_typeof(image->'uri') IS DISTINCT FROM 'string'
  OR length(image->>'name') NOT BETWEEN 1 AND 2048 OR length(image->>'uri') NOT BETWEEN 1 AND 2048
  OR left(image->>'name',length(name_prefix)) IS DISTINCT FROM name_prefix
  OR left(image->>'uri',length(prefix)) IS DISTINCT FROM prefix
  OR (substring(image->>'uri' FROM length(prefix)+1) ~ '^[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$') IS DISTINCT FROM true
  OR substring(image->>'name' FROM length(name_prefix)+1) IS DISTINCT FROM substring(image->>'uri' FROM length(prefix)+1) THEN RETURN false; END IF;
 END LOOP;
 RETURN (SELECT count(*)=count(DISTINCT x->>'name') AND count(*)=count(DISTINCT x->>'uri') FROM jsonb_array_elements(receipt->'images') x);
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
    RAISE EXCEPTION 'personal agent erasure reserved' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.retain_erasure_repository_inventory(owner_id text, attempt_id text, expected jsonb, receipt jsonb)
RETURNS boolean LANGUAGE plpgsql SET search_path=public AS $$
DECLARE current_row public.personal_agent_registry%ROWTYPE; r jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 SELECT * INTO current_row FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 IF NOT FOUND OR current_row.status IS DISTINCT FROM 'suspended' THEN RETURN false; END IF;
 r:=current_row.backend_metadata->'erasure';
 IF r->>'ownerId' IS DISTINCT FROM owner_id OR r->>'attemptId' IS DISTINCT FROM attempt_id
 OR public.valid_erasure_repository_inventory(r,receipt) IS DISTINCT FROM true THEN RETURN false; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_registry'::regclass
 AND tgname='zz_personal_agent_erasure_registry' AND tgenabled IN ('O','A') AND tgtype=27 AND tgnargs=0 AND tgqual IS NULL
 AND tgfoid='public.guard_personal_agent_erasure_registry()'::regprocedure) THEN RETURN false; END IF;
 IF public.project_grant_release_is_exclusive(owner_id,r->'grantRelease'->>'project') IS DISTINCT FROM true THEN RETURN false; END IF;
 IF r ? 'repositoryInventory' THEN RETURN r->'repositoryInventory'=receipt; END IF;
 IF r IS DISTINCT FROM expected THEN RETURN false; END IF;
 UPDATE public.personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata,'{erasure,repositoryInventory}',receipt,true) WHERE user_id=owner_id;
 RETURN true;
END;
$$;
COMMIT;
