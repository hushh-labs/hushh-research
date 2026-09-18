-- Dev-only compute receipts extend the existing immutable erasure reservation.
-- Admission is exclusive: a lost response never authorizes another DELETE.
BEGIN;
CREATE OR REPLACE FUNCTION public.valid_erasure_compute_receipt(reservation jsonb, stage text, receipt jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $$
DECLARE
 snapshot jsonb := reservation->'registrySnapshot';
 attempt jsonb := snapshot->'backend_metadata'->'provisionAttempt';
 creation jsonb := attempt->'evidence'->'host_requested'->'creationAcknowledgement';
 admission jsonb := reservation->'computeAdmission';
 acknowledgement jsonb := reservation->'computeAcknowledgement';
 key text;
BEGIN
 IF jsonb_typeof(receipt) IS DISTINCT FROM 'object'
    OR NOT public.valid_erasure_memory_deletion(reservation,reservation->'memoryDeletion')
    OR attempt->'version' IS DISTINCT FROM '1'::jsonb
    OR attempt->>'ownerId' IS DISTINCT FROM reservation->>'ownerId'
    OR attempt->>'phase' IS DISTINCT FROM 'provisioned'
    OR creation->'initialGeneration' IS DISTINCT FROM '1'::jsonb
    OR creation->>'serviceUid' IS DISTINCT FROM snapshot->'backend_metadata'->>'serviceUid'
    OR creation->>'service' IS DISTINCT FROM reservation->'memoryBinding'->>'service'
    OR creation->>'backend' IS DISTINCT FROM snapshot->>'backend' THEN RETURN false; END IF;
 IF stage='computeAdmission' THEN
   IF receipt - ARRAY['serviceName','serviceUid','etag','generation','image'] <> '{}'::jsonb
      OR receipt->>'serviceName' IS DISTINCT FROM 'projects/' || (creation->>'project') || '/locations/' || (creation->>'region') || '/services/' || (creation->>'service')
      OR receipt->>'serviceUid' IS DISTINCT FROM creation->>'serviceUid'
      OR receipt->'generation' IS DISTINCT FROM '1'::jsonb
      OR receipt->>'image' IS DISTINCT FROM creation->>'initialImage'
      OR coalesce(receipt->>'image','') !~ '^.+@sha256:[a-f0-9]{64}$'
      OR coalesce(receipt->>'serviceName','') !~ '^projects/[A-Za-z0-9_-]+/locations/[A-Za-z0-9_-]+/services/[a-z0-9-]+$' THEN RETURN false; END IF;
   FOREACH key IN ARRAY ARRAY['serviceName','serviceUid','etag','image'] LOOP
     IF jsonb_typeof(receipt->key) IS DISTINCT FROM 'string'
        OR length(receipt->>key) NOT BETWEEN 1 AND 1024
        OR receipt->>key <> btrim(receipt->>key)
        OR receipt->>key ~ '[[:cntrl:]]' THEN RETURN false; END IF;
   END LOOP;
   RETURN true;
 ELSIF stage='computeAcknowledgement' THEN
   RETURN coalesce(public.valid_erasure_compute_receipt(reservation,'computeAdmission',admission)
      AND receipt - 'operationName' = admission
      AND jsonb_typeof(receipt->'operationName')='string'
      AND length(receipt->>'operationName') BETWEEN 1 AND 1024
      AND receipt->>'operationName' ~ '^projects/[A-Za-z0-9_-]+/locations/[A-Za-z0-9_-]+/operations/[A-Za-z0-9_-]+$'
      AND split_part(receipt->>'operationName','/',2)=creation->>'project'
      AND split_part(receipt->>'operationName','/',4)=creation->>'region',false);
 ELSIF stage='computeDeletion' THEN
   RETURN coalesce(public.valid_erasure_compute_receipt(reservation,'computeAcknowledgement',acknowledgement)
      AND receipt - 'status' = acknowledgement AND receipt->>'status'='compute_deleted',false);
 END IF;
 RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.valid_erasure_compute_append(previous jsonb, candidate jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $$
DECLARE stage text;
BEGIN
 FOREACH stage IN ARRAY ARRAY['computeAdmission','computeAcknowledgement','computeDeletion'] LOOP
   IF NOT (previous ? stage) AND candidate ? stage
      AND candidate - stage = previous
      AND public.valid_erasure_compute_receipt(previous,stage,candidate->stage) THEN RETURN true; END IF;
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
    RAISE EXCEPTION 'personal agent erasure reserved' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;


CREATE OR REPLACE FUNCTION public.retain_erasure_compute_receipt(
 owner_id text, attempt_id text, expected jsonb, stage text, receipt jsonb
) RETURNS boolean LANGUAGE plpgsql SET search_path=public AS $$
DECLARE current_row public.personal_agent_registry%ROWTYPE; reservation jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 SELECT * INTO current_row FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 IF NOT FOUND OR current_row.status IS DISTINCT FROM 'suspended' THEN RETURN false; END IF;
 reservation := current_row.backend_metadata->'erasure';
 IF reservation->>'ownerId' IS DISTINCT FROM owner_id
    OR reservation->>'attemptId' IS DISTINCT FROM attempt_id
    OR NOT public.valid_erasure_compute_receipt(reservation,stage,receipt) THEN RETURN false; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_trigger
    WHERE tgrelid='public.personal_agent_registry'::regclass
      AND tgname='zz_personal_agent_erasure_registry' AND tgenabled IN ('O','A')
      AND tgtype=27 AND tgnargs=0 AND tgqual IS NULL
      AND tgfoid='public.guard_personal_agent_erasure_registry()'::regprocedure) THEN RETURN false; END IF;
 -- A repeated admission is observation of an uncertain prior DELETE, not a lease.
 IF reservation ? stage THEN
   RETURN stage <> 'computeAdmission' AND reservation->stage=receipt;
 END IF;
 IF reservation IS DISTINCT FROM expected THEN RETURN false; END IF;
 UPDATE public.personal_agent_registry SET backend_metadata=jsonb_set(
    backend_metadata,ARRAY['erasure',stage],receipt,true) WHERE user_id=owner_id;
 RETURN true;
END;
$$;
COMMIT;
