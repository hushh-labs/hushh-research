-- Dev-only shared-project admission fence, retained in the existing erasure record.
BEGIN;
CREATE OR REPLACE FUNCTION public.assert_project_grant_admission(project_id text)
RETURNS void LANGUAGE plpgsql VOLATILE SET search_path=public AS $$
BEGIN
 IF project_id IS NULL OR project_id='' THEN RETURN; END IF;
 IF project_id !~ '^[a-z][a-z0-9-]{4,61}[a-z0-9]$' OR current_setting('transaction_isolation') <> 'read committed' THEN
  RAISE EXCEPTION 'project grant admission unavailable' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(project_id,205));
 IF EXISTS (SELECT 1 FROM public.personal_agent_registry r WHERE r.backend_metadata->'erasure'->'grantRelease'->>'project'=project_id) THEN
  RAISE EXCEPTION 'project grant release reserved' USING ERRCODE='42501'; END IF;
END;
$$;
CREATE OR REPLACE FUNCTION public.guard_project_grant_registry_admission()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  -- ON CONFLICT acquires its existing row only after BEFORE INSERT. Match
  -- lifecycle admission's owner -> row -> project order before that happens.
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.user_id,171));
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.user_id,198));
  PERFORM 1 FROM public.personal_agent_registry WHERE user_id=NEW.user_id FOR UPDATE;
  PERFORM public.assert_project_grant_admission(NEW.user_cloud_project);
 ELSIF NEW.user_cloud_project IS DISTINCT FROM OLD.user_cloud_project
 OR NEW.user_cloud_bootstrap_sa IS DISTINCT FROM OLD.user_cloud_bootstrap_sa
 OR NEW.backend_metadata->'upgradeLease' IS DISTINCT FROM OLD.backend_metadata->'upgradeLease' AND NEW.backend_metadata->>'upgradeLease' IS NOT NULL
 OR NEW.backend_metadata->'provisionAttempt'->>'attemptId' IS DISTINCT FROM OLD.backend_metadata->'provisionAttempt'->>'attemptId'
 THEN PERFORM public.assert_project_grant_admission(NEW.user_cloud_project);
 END IF;
 RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS zx_project_grant_registry ON public.personal_agent_registry;
CREATE TRIGGER zx_project_grant_registry BEFORE INSERT OR UPDATE ON public.personal_agent_registry
FOR EACH ROW EXECUTE FUNCTION public.guard_project_grant_registry_admission();
CREATE OR REPLACE FUNCTION public.guard_project_grant_setup_admission()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  PERFORM public.assert_project_grant_admission(NEW.project_id);
 ELSIF NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.job_id IS DISTINCT FROM OLD.job_id
 OR NEW.status='running' AND OLD.status IS DISTINCT FROM 'running' THEN
  PERFORM public.assert_project_grant_admission(NEW.project_id);
 END IF;
 RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS zx_project_grant_setup ON public.byoc_setup_jobs;
CREATE TRIGGER zx_project_grant_setup BEFORE INSERT OR UPDATE ON public.byoc_setup_jobs
FOR EACH ROW EXECUTE FUNCTION public.guard_project_grant_setup_admission();
CREATE OR REPLACE FUNCTION public.valid_erasure_grant_release(r jsonb, receipt jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=public AS $$
 SELECT jsonb_typeof(receipt)='object'
 AND receipt - ARRAY['ownerId','attemptId','project','status']='{}'::jsonb
 AND receipt->>'ownerId'=r->>'ownerId' AND receipt->>'attemptId'=r->>'attemptId'
 AND receipt->>'project'=r->'registrySnapshot'->>'user_cloud_project'
 AND receipt->>'project' ~ '^[a-z][a-z0-9-]{4,61}[a-z0-9]$'
 AND receipt->>'status'='reserved'
 AND public.valid_erasure_account_receipt(r,'deletion',r->'accountErasure'->'deletion') IS TRUE;
$$;
CREATE OR REPLACE FUNCTION public.project_grant_release_is_exclusive(owner_id text,target_project text)
RETURNS boolean LANGUAGE plpgsql VOLATILE SET search_path=public AS $$
BEGIN
 IF target_project IS NULL OR target_project !~ '^[a-z][a-z0-9-]{4,61}[a-z0-9]$' OR current_setting('transaction_isolation') <> 'read committed' THEN RETURN false; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(target_project,205));
 IF (SELECT count(*) FROM pg_trigger WHERE
  (tgrelid='public.personal_agent_registry'::regclass AND tgname='zx_project_grant_registry' AND tgfoid='public.guard_project_grant_registry_admission()'::regprocedure AND tgtype=23)
  OR (tgrelid='public.byoc_setup_jobs'::regclass AND tgname='zx_project_grant_setup' AND tgfoid='public.guard_project_grant_setup_admission()'::regprocedure AND tgtype=23)
  OR (tgrelid='public.personal_agent_registry'::regclass AND tgname='zz_personal_agent_erasure_registry' AND tgfoid='public.guard_personal_agent_erasure_registry()'::regprocedure AND tgtype=27)) <> 3 THEN RETURN false; END IF;
 IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname IN ('zx_project_grant_registry','zx_project_grant_setup','zz_personal_agent_erasure_registry') AND tgrelid IN ('public.personal_agent_registry'::regclass,'public.byoc_setup_jobs'::regclass) AND (tgenabled NOT IN ('O','A') OR tgnargs<>0 OR tgqual IS NOT NULL)) THEN RETURN false; END IF;
 -- Never lock other owners' rows under the project lock. Unresolved users retain grants.
 IF EXISTS (SELECT 1 FROM public.personal_agent_registry x WHERE x.user_id<>owner_id AND
   (x.user_cloud_project=target_project OR x.backend_metadata->'provisionAttempt'->'intent'->>'user_cloud_project'=target_project))
 OR EXISTS (SELECT 1 FROM public.byoc_setup_jobs j WHERE j.project_id=target_project AND (j.user_id<>owner_id OR j.status IS DISTINCT FROM 'recorded')) THEN RETURN false; END IF;
 RETURN true;
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
    RAISE EXCEPTION 'personal agent erasure reserved' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;


CREATE OR REPLACE FUNCTION public.reserve_erasure_grant_release(owner_id text,attempt_id text,expected jsonb)
RETURNS boolean LANGUAGE plpgsql VOLATILE SET search_path=public AS $$
DECLARE current_row public.personal_agent_registry%ROWTYPE; r jsonb; project_id text; receipt jsonb;
BEGIN
 IF current_setting('transaction_isolation') <> 'read committed' THEN RETURN false; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 SELECT * INTO current_row FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 IF NOT FOUND OR current_row.status IS DISTINCT FROM 'suspended' THEN RETURN false; END IF;
 r:=current_row.backend_metadata->'erasure'; project_id:=r->'registrySnapshot'->>'user_cloud_project';
 receipt:=jsonb_build_object('ownerId',owner_id,'attemptId',attempt_id,'project',project_id,'status','reserved');
 IF public.valid_erasure_grant_release(r,receipt) IS DISTINCT FROM true THEN RETURN false; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(project_id,205));
 IF NOT public.project_grant_release_is_exclusive(owner_id,project_id) THEN RETURN false; END IF;
 IF r ? 'grantRelease' THEN RETURN r->'grantRelease'=receipt; END IF;
 IF r IS DISTINCT FROM expected THEN RETURN false; END IF;
 UPDATE public.personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata,ARRAY['erasure','grantRelease'],receipt,true) WHERE user_id=owner_id;
 RETURN true;
END;
$$;
COMMIT;
