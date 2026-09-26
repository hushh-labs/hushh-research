-- Dev-only: Files resources participate in the existing immutable erasure reservation.
-- Creation/configuration observations are not proof of universal physical deletion.
BEGIN;
CREATE OR REPLACE FUNCTION public.valid_erasure_files_receipt(r jsonb, kind text, stage text, receipt jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $$
DECLARE inv jsonb:=r->'substrateInventory'; obs jsonb:=receipt->'resourceObservation'; identity jsonb:=obs->'identity';
 project text:=r->'registrySnapshot'->>'user_cloud_project'; region text:=r->'registrySnapshot'->>'user_cloud_region';
 slug text:='one-files-'||left(encode(sha256(convert_to(r->>'hushhId','UTF8')),'hex'),20);
 rid text; rtype text; admitted jsonb;
BEGIN
 IF kind IS NULL OR kind NOT IN ('queue','worker') OR stage IS NULL OR stage NOT IN ('admission','quiescence','acknowledgement','deletion')
 OR public.valid_erasure_writer_receipt(r,'writerDisabled',r->'writerDisabled') IS DISTINCT FROM true
 OR public.valid_erasure_compute_receipt(r,'computeDeletion',r->'computeDeletion') IS DISTINCT FROM true
 OR jsonb_typeof(receipt) IS DISTINCT FROM 'object'
 OR receipt-ARRAY['ownerId','attemptId','resourceObservation','status']<>'{}'::jsonb
 OR receipt->>'ownerId' IS DISTINCT FROM r->>'ownerId' OR receipt->>'attemptId' IS DISTINCT FROM r->>'attemptId'
 OR r->'registrySnapshot'->>'deployment_target' IS DISTINCT FROM 'user_gcp'
 OR project IS NULL OR region IS NULL OR slug IS NULL
 OR jsonb_typeof(obs) IS DISTINCT FROM 'object' OR obs-ARRAY['type','id','disposition','identity']<>'{}'::jsonb
 OR obs->>'disposition' IS DISTINCT FROM 'created' THEN RETURN false; END IF;
 rtype:=CASE kind WHEN 'queue' THEN 'cloud_tasks_queue' ELSE 'service_account' END;
 rid:=CASE kind WHEN 'queue' THEN slug ELSE slug||'@'||project||'.iam.gserviceaccount.com' END;
 IF obs->>'type' IS DISTINCT FROM rtype OR obs->>'id' IS DISTINCT FROM rid
 OR (SELECT count(*) FROM jsonb_array_elements(inv->'plannedResources') x WHERE x->>'type'=rtype AND x->>'id'=rid)<>1
 OR (SELECT count(*) FROM jsonb_array_elements(inv->'resourceObservations') x WHERE x=obs)<>1 THEN RETURN false; END IF;
 IF kind='queue' THEN
   IF identity IS DISTINCT FROM jsonb_build_object('name','projects/'||project||'/locations/'||region||'/queues/'||rid,
     'rateLimits',jsonb_build_object('maxDispatchesPerSecond',1,'maxConcurrentDispatches',1),
     'retryConfig',jsonb_build_object('maxAttempts',3,'maxRetryDuration','0s','minBackoff','10s','maxBackoff','60s','maxDoublings',2)) THEN RETURN false; END IF;
 ELSE
   IF jsonb_typeof(identity) IS DISTINCT FROM 'object' OR identity-ARRAY['name','email','projectId','uniqueId']<>'{}'::jsonb
    OR (identity->>'name' IS DISTINCT FROM 'projects/'||project||'/serviceAccounts/'||rid AND identity->>'name' IS DISTINCT FROM 'projects/'||project||'/serviceAccounts/'||(identity->>'uniqueId'))
    OR identity->>'email' IS DISTINCT FROM rid OR identity->>'projectId' IS DISTINCT FROM project
    OR (coalesce(identity->>'uniqueId','') !~ '^[0-9]{1,32}$' OR identity->>'uniqueId' !~ '[1-9]')
    OR identity->>'email'=r->'writerDisabled'->'runtimeIdentity'->>'email'
    OR public.valid_erasure_files_receipt(r,'queue','deletion',r->'filesErasure'->'queue'->'deletion') IS DISTINCT FROM true THEN RETURN false; END IF;
 END IF;
 IF stage='admission' THEN RETURN receipt->>'status'='admitted'; END IF;
 admitted:=r->'filesErasure'->kind->'admission';
 IF public.valid_erasure_files_receipt(r,kind,'admission',admitted) IS DISTINCT FROM true OR receipt-'status' IS DISTINCT FROM admitted-'status' THEN RETURN false; END IF;
 IF stage='quiescence' THEN RETURN receipt->>'status'='quiesced'; END IF;
 IF public.valid_erasure_files_receipt(r,kind,'quiescence',r->'filesErasure'->kind->'quiescence') IS DISTINCT FROM true THEN RETURN false; END IF;
 IF stage='acknowledgement' THEN RETURN receipt->>'status'='acknowledged'; END IF;
 RETURN receipt->>'status'='absent' AND public.valid_erasure_files_receipt(r,kind,'acknowledgement',r->'filesErasure'->kind->'acknowledgement') IS TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION public.valid_erasure_files_append(before_record jsonb, after_record jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $$
DECLARE kind text; stage text; old_mail jsonb; new_mail jsonb; old_kind jsonb; new_kind jsonb;
BEGIN
 old_mail:=coalesce(before_record->'filesErasure','{}'::jsonb); new_mail:=after_record->'filesErasure';
 IF jsonb_typeof(new_mail) IS DISTINCT FROM 'object' OR after_record-'filesErasure' IS DISTINCT FROM before_record-'filesErasure' THEN RETURN false; END IF;
 FOREACH kind IN ARRAY ARRAY['queue','worker'] LOOP
  old_kind:=coalesce(old_mail->kind,'{}'::jsonb); new_kind:=new_mail->kind;
  FOREACH stage IN ARRAY ARRAY['admission','quiescence','acknowledgement','deletion'] LOOP
   IF NOT (old_kind ? stage) AND new_kind ? stage AND new_mail-kind=old_mail-kind
      AND new_kind-stage=old_kind AND public.valid_erasure_files_receipt(before_record,kind,stage,new_kind->stage) IS TRUE THEN RETURN true; END IF;
  END LOOP;
 END LOOP;
 RETURN false;
END;
$$;
CREATE OR REPLACE FUNCTION public.retain_erasure_files_receipt(
 owner_id text, attempt_id text, expected jsonb, kind text, stage text, receipt jsonb
) RETURNS boolean LANGUAGE plpgsql SET search_path=public AS $$
DECLARE current_row public.personal_agent_registry%ROWTYPE; reservation jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 SELECT * INTO current_row FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 IF NOT FOUND OR current_row.status IS DISTINCT FROM 'suspended' THEN RETURN false; END IF;
 reservation := current_row.backend_metadata->'erasure';
 IF reservation->>'ownerId' IS DISTINCT FROM owner_id OR reservation->>'attemptId' IS DISTINCT FROM attempt_id
    OR public.valid_erasure_files_receipt(reservation,kind,stage,receipt) IS DISTINCT FROM true THEN RETURN false; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_registry'::regclass
    AND tgname='zz_personal_agent_erasure_registry' AND tgenabled IN ('O','A')
    AND tgtype=27 AND tgnargs=0 AND tgqual IS NULL
    AND tgfoid='public.guard_personal_agent_erasure_registry()'::regprocedure) THEN RETURN false; END IF;
 IF reservation->'filesErasure'->kind ? stage THEN
   RETURN stage <> 'admission' AND reservation->'filesErasure'->kind->stage=receipt;
 END IF;
 IF reservation IS DISTINCT FROM expected THEN RETURN false; END IF;
 UPDATE public.personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata,ARRAY['erasure','filesErasure'],coalesce(reservation->'filesErasure','{}'::jsonb) || jsonb_build_object(kind,coalesce(reservation->'filesErasure'->kind,'{}'::jsonb) || jsonb_build_object(stage,receipt)),true)
 WHERE user_id=owner_id;
 RETURN true;
END;
$$;
CREATE OR REPLACE FUNCTION public.verify_erasure_files_preflight(owner_id text, attempt_id text, expected jsonb)
RETURNS boolean LANGUAGE sql STABLE SET search_path=public AS $$
 SELECT EXISTS (SELECT 1 FROM public.personal_agent_registry r
 WHERE r.user_id=owner_id AND r.status='suspended'
 AND r.backend_metadata->'erasure'=expected
 AND expected->>'ownerId'=owner_id AND expected->>'attemptId'=attempt_id
 AND public.valid_erasure_writer_receipt(expected,'writerDisabled',expected->'writerDisabled') IS TRUE
 AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_registry'::regclass
    AND tgname='zz_personal_agent_erasure_registry' AND tgenabled IN ('O','A')
    AND tgtype=27 AND tgnargs=0 AND tgqual IS NULL
    AND tgfoid='public.guard_personal_agent_erasure_registry()'::regprocedure));
$$;
CREATE OR REPLACE FUNCTION public.valid_erasure_account_receipt(r jsonb, stage text, receipt jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $$
DECLARE obs jsonb; inv jsonb; admitted jsonb;
BEGIN
 IF stage IS NULL OR stage NOT IN ('admission','acknowledgement','deletion')
 OR jsonb_typeof(receipt) IS DISTINCT FROM 'object'
 OR public.valid_erasure_secret_receipt(r,'deletion',r->'secretErasure'->'deletion') IS DISTINCT FROM true THEN RETURN false; END IF;
 obs:=receipt->'resourceObservation'; inv:=r->'substrateInventory';
 IF receipt - ARRAY['ownerId','attemptId','resourceObservation','status'] <> '{}'::jsonb
 OR receipt->>'ownerId' IS DISTINCT FROM r->>'ownerId' OR receipt->>'attemptId' IS DISTINCT FROM r->>'attemptId'
 OR jsonb_typeof(obs) IS DISTINCT FROM 'object' OR obs - ARRAY['type','id','disposition','identity'] <> '{}'::jsonb
 OR obs->>'type' IS DISTINCT FROM 'service_account' OR obs->>'disposition' IS DISTINCT FROM 'created'
 OR obs->>'id' IS DISTINCT FROM r->'writerDisabled'->'runtimeIdentity'->>'email'
 OR obs->'identity' IS DISTINCT FROM r->'writerDisabled'->'runtimeIdentity'
 OR EXISTS (SELECT 1 FROM jsonb_array_elements(inv->'plannedResources') x WHERE x->>'type'='service_account' AND x->>'id'<>obs->>'id'
   AND (x->>'id' IS DISTINCT FROM r->'filesErasure'->'worker'->'deletion'->'resourceObservation'->>'id'
     OR public.valid_erasure_files_receipt(r,'worker','deletion',r->'filesErasure'->'worker'->'deletion') IS DISTINCT FROM true))
 OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(inv->'plannedResources') x WHERE x->>'type'='service_account' AND x->>'id'=obs->>'id')
 OR (SELECT count(*) FROM jsonb_array_elements(inv->'resourceObservations') x WHERE x=obs) <> 1 THEN RETURN false; END IF;
 IF stage='admission' THEN RETURN receipt->>'status'='admitted'; END IF;
 admitted:=r->'accountErasure'->'admission';
 IF public.valid_erasure_account_receipt(r,'admission',admitted) IS DISTINCT FROM true OR receipt - 'status' IS DISTINCT FROM admitted - 'status' THEN RETURN false; END IF;
 IF stage='acknowledgement' THEN RETURN receipt->>'status'='acknowledged'; END IF;
 RETURN receipt->>'status'='absent' AND public.valid_erasure_account_receipt(r,'acknowledgement',r->'accountErasure'->'acknowledgement') IS TRUE;
END;
$$;
CREATE OR REPLACE FUNCTION public.erasure_planned_resources_covered(r jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $$
DECLARE planned jsonb:=r->'substrateInventory'->'plannedResources'; item jsonb; receipt jsonb;
 kind text; captured_id text; wanted_status text;
BEGIN
 -- Coverage supplements existing immutable receipt validation; it never grants deletion authority.
 IF jsonb_typeof(planned) IS DISTINCT FROM 'array' OR jsonb_array_length(planned) NOT BETWEEN 1 AND 1024
 OR (SELECT count(*)<>count(DISTINCT x) FROM jsonb_array_elements(planned) x) THEN RETURN false; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(planned) LOOP
  IF jsonb_typeof(item) IS DISTINCT FROM 'object' OR item-ARRAY['type','id']<>'{}'::jsonb
   OR jsonb_typeof(item->'id') IS DISTINCT FROM 'string' OR length(item->>'id')=0 THEN RETURN false; END IF;
  kind:=item->>'type'; receipt:=NULL; captured_id:=NULL; wanted_status:=NULL;
  CASE kind
   WHEN 'cloud_run_service' THEN
    receipt:=r->'computeDeletion'; captured_id:=split_part(receipt->>'serviceName','/',6); wanted_status:='compute_deleted';
   WHEN 'gcs_bucket' THEN
    receipt:=r->'bucketDeletion'; captured_id:=receipt->'bucketIdentity'->>'name'; wanted_status:='deleted';
   WHEN 'service_account' THEN
    IF item->>'id'=r->'writerDisabled'->'runtimeIdentity'->>'email' THEN
     receipt:=r->'accountErasure'->'deletion';
    ELSE
     receipt:=r->'filesErasure'->'worker'->'deletion';
     IF public.valid_erasure_files_receipt(r,'worker','deletion',receipt) IS DISTINCT FROM true THEN RETURN false; END IF;
    END IF;
    captured_id:=receipt->'resourceObservation'->>'id'; wanted_status:='absent';
   WHEN 'cloud_tasks_queue' THEN
    receipt:=r->'filesErasure'->'queue'->'deletion';
    IF public.valid_erasure_files_receipt(r,'queue','deletion',receipt) IS DISTINCT FROM true THEN RETURN false; END IF;
    captured_id:=receipt->'resourceObservation'->>'id'; wanted_status:='absent';
   WHEN 'kms_key' THEN
    receipt:=r->'kmsErasure'->'completion'; captured_id:=receipt->'resourceObservation'->>'id'; wanted_status:='destroyed';
   WHEN 'secret' THEN
    receipt:=r->'secretErasure'->'deletion'; captured_id:=receipt->'resourceObservation'->>'id'; wanted_status:='absent';
   WHEN 'artifact_repository' THEN
    receipt:=r->'repositoryRetention'; captured_id:=split_part(receipt->'repositoryIdentity'->>'name','/',6);
    IF receipt->>'disposition' IS DISTINCT FROM 'retained_shared' THEN RETURN false; END IF;
   WHEN 'cloud_scheduler_job','pubsub_subscription','pubsub_topic' THEN
    receipt:=r->'mailErasure'->kind->'deletion'; captured_id:=receipt->'resourceObservation'->>'id'; wanted_status:='absent';
   ELSE RETURN false;
  END CASE;
  IF captured_id IS DISTINCT FROM item->>'id' OR jsonb_typeof(receipt) IS DISTINCT FROM 'object'
   OR (wanted_status IS NOT NULL AND receipt->>'status' IS DISTINCT FROM wanted_status) THEN RETURN false; END IF;
  -- Compute receipts are bound through the existing compute admission contract.
  IF kind<>'cloud_run_service' AND (receipt->>'ownerId' IS DISTINCT FROM r->>'ownerId'
   OR receipt->>'attemptId' IS DISTINCT FROM r->>'attemptId') THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
END;
$$;
CREATE OR REPLACE FUNCTION public.personal_agent_erasure_archive(r jsonb, history jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=public AS $$
 SELECT jsonb_build_object(
  'version',1,'ownerId',r->>'ownerId','hushhId',r->>'hushhId','attemptId',r->>'attemptId',
  'project',r->'registrySnapshot'->>'user_cloud_project',
  'reservationSha256',encode(sha256(convert_to(r::text,'UTF8')),'hex'),
  'authorizationHistorySha256',encode(sha256(convert_to(history::text,'UTF8')),'hex'),
  'receipts',jsonb_build_object(
   'memoryDeletion',r->'memoryDeletion','computeDeletion',r->'computeDeletion',
   'writerDisabled',r->'writerDisabled','bucketDeletion',r->'bucketDeletion',
   'mailDeletion',jsonb_build_object(
    'cloud_scheduler_job',r->'mailErasure'->'cloud_scheduler_job'->'deletion',
    'pubsub_subscription',r->'mailErasure'->'pubsub_subscription'->'deletion',
    'pubsub_topic',r->'mailErasure'->'pubsub_topic'->'deletion'),
   'kmsCompletion',r->'kmsErasure'->'completion','secretDeletion',r->'secretErasure'->'deletion',
   'accountDeletion',r->'accountErasure'->'deletion',
   'runtimeGrantDeletion',r->'runtimeGrantErasure'->'deletion',
   'repositoryGrantDeletion',r->'repositoryGrantErasure'->'deletion',
   'repositoryRetention',r->'repositoryRetention',
   'bootstrapGrantRelease',r->'bootstrapGrantRelease',
   'bootstrapGrantErasure',r->'bootstrapGrantErasure') ||
   CASE WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(r->'substrateInventory'->'plannedResources') x WHERE x->>'type'='cloud_tasks_queue')
    THEN jsonb_build_object('filesErasure',r->'filesErasure') ELSE '{}'::jsonb END);
$$;
CREATE OR REPLACE FUNCTION public.guard_personal_agent_erasure_registry()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE reservation jsonb; snapshot jsonb;
BEGIN
  IF TG_OP='DELETE' AND public.personal_agent_erasure_archived(OLD.user_id,OLD.backend_metadata->'erasure') IS TRUE THEN RETURN OLD; END IF;
  IF OLD.backend_metadata ? 'erasure' THEN
    reservation := OLD.backend_metadata->'erasure';
    snapshot := reservation->'registrySnapshot';

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
COMMIT;
