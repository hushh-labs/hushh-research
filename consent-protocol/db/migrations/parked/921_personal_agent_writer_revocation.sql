-- Dev-only runtime credential revocation; never certifies upload drainage or erasure.
BEGIN;
CREATE OR REPLACE FUNCTION public.valid_erasure_writer_receipt(reservation jsonb, stage text, receipt jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $$
DECLARE snapshot jsonb; inventory jsonb; runtime_identity jsonb; bootstrap_identity jsonb; project text; bootstrap_ref text;
BEGIN
 snapshot := reservation->'registrySnapshot'; inventory := reservation->'substrateInventory';
 IF public.valid_erasure_substrate_inventory(reservation,inventory) IS DISTINCT FROM true
    OR stage NOT IN ('writerAdmission','writerDisabled') OR stage IS NULL
    OR jsonb_typeof(receipt) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 runtime_identity := receipt->'runtimeIdentity'; bootstrap_identity := receipt->'bootstrapIdentity';
 project := snapshot->>'user_cloud_project';
 bootstrap_ref := regexp_replace(snapshot->>'user_cloud_bootstrap_sa','^serviceAccount:','');
 IF project IS NULL OR project !~ '^[a-z][a-z0-9-]{4,61}[a-z0-9]$'
    OR receipt->>'ownerId' IS DISTINCT FROM reservation->>'ownerId'
    OR receipt->>'attemptId' IS DISTINCT FROM reservation->>'attemptId'
    OR receipt - ARRAY['ownerId','attemptId','runtimeIdentity','bootstrapIdentity','status'] <> '{}'::jsonb
    OR jsonb_typeof(runtime_identity) IS DISTINCT FROM 'object'
    OR jsonb_typeof(bootstrap_identity) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 IF runtime_identity->>'projectId' IS DISTINCT FROM project
    OR bootstrap_identity->>'projectId' IS DISTINCT FROM project
    OR runtime_identity->>'email' IS DISTINCT FROM snapshot->'backend_metadata'->>'runtime_service_account'
    OR runtime_identity->>'uniqueId' IS NULL OR runtime_identity->>'uniqueId' !~ '^[1-9][0-9]{0,31}$'
    OR bootstrap_identity->>'uniqueId' IS NULL OR bootstrap_identity->>'uniqueId' !~ '^[1-9][0-9]{0,31}$'
    OR runtime_identity->>'uniqueId' = bootstrap_identity->>'uniqueId'
    OR bootstrap_ref IS NULL
    OR bootstrap_ref NOT IN (bootstrap_identity->>'email',bootstrap_identity->>'uniqueId') THEN RETURN false; END IF;
 IF bootstrap_identity - ARRAY['name','email','projectId','uniqueId'] <> '{}'::jsonb
    OR bootstrap_identity->>'email' IS NULL
    OR bootstrap_identity->>'email' NOT LIKE '%@' || project || '.iam.gserviceaccount.com'
    OR bootstrap_identity->>'name' IS NULL
    OR bootstrap_identity->>'name' NOT IN ('projects/' || project || '/serviceAccounts/' || (bootstrap_identity->>'email'),
                                         'projects/' || project || '/serviceAccounts/' || (bootstrap_identity->>'uniqueId')) THEN RETURN false; END IF;
 IF jsonb_typeof(inventory->'resourceObservations') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 IF (SELECT count(*) FROM jsonb_array_elements(inventory->'resourceObservations') AS r
     WHERE r->>'type'='service_account' AND r->>'disposition'='created'
       AND r->>'id'=runtime_identity->>'email' AND r->'identity'=runtime_identity) <> 1
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(inventory->'plannedResources') AS r
                   WHERE r->>'type'='service_account' AND r->>'id'=runtime_identity->>'email') THEN RETURN false; END IF;
 IF stage='writerAdmission' THEN RETURN receipt->>'status'='admitted'; END IF;
 RETURN receipt->>'status'='disabled'
    AND public.valid_erasure_writer_receipt(reservation,'writerAdmission',reservation->'writerAdmission')
    AND receipt - 'status' = (reservation->'writerAdmission') - 'status';
END;
$$;
CREATE OR REPLACE FUNCTION public.valid_erasure_writer_append(before_record jsonb, after_record jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $$
DECLARE stage text;
BEGIN
 FOREACH stage IN ARRAY ARRAY['writerAdmission','writerDisabled'] LOOP
  IF NOT (before_record ? stage) AND after_record ? stage
     AND after_record-stage=before_record
     AND public.valid_erasure_writer_receipt(before_record,stage,after_record->stage) IS TRUE THEN RETURN true; END IF;
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
    RAISE EXCEPTION 'personal agent erasure reserved' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;


CREATE OR REPLACE FUNCTION public.retain_erasure_writer_receipt(
 owner_id text, attempt_id text, expected jsonb, stage text, receipt jsonb
) RETURNS boolean LANGUAGE plpgsql SET search_path=public AS $$
DECLARE current_row public.personal_agent_registry%ROWTYPE; reservation jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 SELECT * INTO current_row FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 IF NOT FOUND OR current_row.status IS DISTINCT FROM 'suspended' THEN RETURN false; END IF;
 reservation := current_row.backend_metadata->'erasure';
 IF reservation->>'ownerId' IS DISTINCT FROM owner_id OR reservation->>'attemptId' IS DISTINCT FROM attempt_id
    OR public.valid_erasure_writer_receipt(reservation,stage,receipt) IS DISTINCT FROM true THEN RETURN false; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_registry'::regclass
    AND tgname='zz_personal_agent_erasure_registry' AND tgenabled IN ('O','A')
    AND tgtype=27 AND tgnargs=0 AND tgqual IS NULL
    AND tgfoid='public.guard_personal_agent_erasure_registry()'::regprocedure) THEN RETURN false; END IF;
 IF reservation ? stage THEN
   RETURN stage <> 'writerAdmission' AND reservation->stage=receipt;
 END IF;
 IF reservation IS DISTINCT FROM expected THEN RETURN false; END IF;
 UPDATE public.personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata,ARRAY['erasure',stage],receipt,true)
 WHERE user_id=owner_id;
 RETURN true;
END;
$$;
COMMIT;
