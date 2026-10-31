-- Dev-only bucket final deletion receipts; retained objects remain incomplete.
BEGIN;
CREATE OR REPLACE FUNCTION public.valid_erasure_bucket_receipt(reservation jsonb, stage text, receipt jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $$
DECLARE inventory jsonb; identity jsonb; admission jsonb;
BEGIN
 IF public.valid_erasure_writer_receipt(reservation,'writerDisabled',reservation->'writerDisabled') IS DISTINCT FROM true
    OR stage IS NULL OR stage NOT IN ('bucketAdmission','bucketAcknowledgement','bucketDeletion')
    OR jsonb_typeof(receipt) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 inventory := reservation->'substrateInventory'; identity := receipt->'bucketIdentity';
 IF receipt->>'ownerId' IS DISTINCT FROM reservation->>'ownerId'
    OR receipt->>'attemptId' IS DISTINCT FROM reservation->>'attemptId'
    OR receipt - ARRAY['ownerId','attemptId','bucketIdentity','metageneration','status'] <> '{}'::jsonb
    OR jsonb_typeof(identity) IS DISTINCT FROM 'object'
    OR jsonb_typeof(receipt->'metageneration') IS DISTINCT FROM 'string'
    OR receipt->>'metageneration' !~ '^[1-9][0-9]{0,19}$'
    OR identity - ARRAY['name','generation','projectNumber','timeCreated'] <> '{}'::jsonb
    OR identity->>'name' IS NULL OR identity->>'name' = ''
    OR identity->>'generation' IS NULL OR identity->>'generation' !~ '^[1-9][0-9]{0,19}$'
    OR identity->>'projectNumber' IS NULL OR identity->>'projectNumber' !~ '^[1-9][0-9]{0,19}$'
    OR identity->>'timeCreated' IS NULL OR identity->>'timeCreated' = '' THEN RETURN false; END IF;
 IF (SELECT count(*) FROM jsonb_array_elements(inventory->'resourceObservations') AS r
     WHERE r->>'type'='gcs_bucket' AND r->>'disposition'='created'
       AND r->>'id'=identity->>'name' AND r->'identity'=identity) <> 1
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(inventory->'plannedResources') AS r
                   WHERE r->>'type'='gcs_bucket' AND r->>'id'=identity->>'name') THEN RETURN false; END IF;
 IF stage='bucketAdmission' THEN RETURN receipt->>'status'='admitted'; END IF;
 admission := reservation->'bucketAdmission';
 IF public.valid_erasure_bucket_receipt(reservation,'bucketAdmission',admission) IS DISTINCT FROM true
    OR receipt - 'status' IS DISTINCT FROM admission - 'status' THEN RETURN false; END IF;
 IF stage='bucketAcknowledgement' THEN RETURN receipt->>'status'='acknowledged'; END IF;
 RETURN receipt->>'status'='deleted'
    AND public.valid_erasure_bucket_receipt(reservation,'bucketAcknowledgement',reservation->'bucketAcknowledgement');
END;
$$;
CREATE OR REPLACE FUNCTION public.valid_erasure_bucket_append(before_record jsonb, after_record jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $$
DECLARE stage text;
BEGIN
 FOREACH stage IN ARRAY ARRAY['bucketAdmission','bucketAcknowledgement','bucketDeletion'] LOOP
  IF NOT (before_record ? stage) AND after_record ? stage
     AND after_record-stage=before_record
     AND public.valid_erasure_bucket_receipt(before_record,stage,after_record->stage) IS TRUE THEN RETURN true; END IF;
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
    RAISE EXCEPTION 'personal agent erasure reserved' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;


CREATE OR REPLACE FUNCTION public.retain_erasure_bucket_receipt(
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
    OR public.valid_erasure_bucket_receipt(reservation,stage,receipt) IS DISTINCT FROM true THEN RETURN false; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_registry'::regclass
    AND tgname='zz_personal_agent_erasure_registry' AND tgenabled IN ('O','A')
    AND tgtype=27 AND tgnargs=0 AND tgqual IS NULL
    AND tgfoid='public.guard_personal_agent_erasure_registry()'::regprocedure) THEN RETURN false; END IF;
 IF reservation ? stage THEN
   RETURN stage <> 'bucketAdmission' AND reservation->stage=receipt;
 END IF;
 IF reservation IS DISTINCT FROM expected THEN RETURN false; END IF;
 UPDATE public.personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata,ARRAY['erasure',stage],receipt,true)
 WHERE user_id=owner_id;
 RETURN true;
END;
$$;
CREATE OR REPLACE FUNCTION public.verify_erasure_bucket_preflight(owner_id text, attempt_id text, expected jsonb)
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
COMMIT;
