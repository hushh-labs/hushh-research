-- Dev-only append-only provider binding in the existing erasure reservation.
-- This observation is not a provider deletion receipt or historical drain proof.
BEGIN;

CREATE OR REPLACE FUNCTION public.valid_erasure_memory_binding(reservation jsonb, receipt jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE
  memory jsonb := receipt->'memoryBinding';
  incarnation jsonb := memory->'engineIncarnation';
  snapshot jsonb := reservation->'registrySnapshot';
  key text;
BEGIN
  IF jsonb_typeof(receipt) IS DISTINCT FROM 'object'
     OR receipt - ARRAY['hushhId','attemptId','service','serviceUid','revision','memoryBinding'] <> '{}'::jsonb
     OR reservation->>'phase' IS DISTINCT FROM 'reserved'
     OR reservation->>'version' IS DISTINCT FROM '1'
     OR receipt->>'hushhId' IS DISTINCT FROM reservation->>'hushhId'
     OR receipt->>'attemptId' IS DISTINCT FROM reservation->>'attemptId'
     OR snapshot->>'user_id' IS DISTINCT FROM reservation->>'ownerId'
     OR snapshot->>'status' IS DISTINCT FROM 'provisioned'
     OR snapshot->'backend_metadata' ? 'upgradeLease'
     OR receipt->>'serviceUid' IS DISTINCT FROM snapshot->'backend_metadata'->>'serviceUid'
     OR receipt->>'service' IS DISTINCT FROM coalesce(snapshot->'backend_metadata'->>'service',snapshot->>'external_agent_id')
     OR jsonb_typeof(memory) IS DISTINCT FROM 'object'
     OR memory - ARRAY['project','location','engineId','engineIncarnation','generationProtocol','creationProvenance'] <> '{}'::jsonb
     OR memory->'generationProtocol' IS DISTINCT FROM '2'::jsonb
     OR jsonb_typeof(incarnation) IS DISTINCT FROM 'object'
     OR incarnation - ARRAY['name','createTime'] <> '{}'::jsonb THEN RETURN false; END IF;
  FOREACH key IN ARRAY ARRAY['hushhId','attemptId','service','serviceUid','revision'] LOOP
    IF jsonb_typeof(receipt->key) IS DISTINCT FROM 'string'
       OR length(receipt->>key) NOT BETWEEN 1 AND 128
       OR receipt->>key <> btrim(receipt->>key)
       OR receipt->>key ~ '[[:cntrl:]]' THEN RETURN false; END IF;
  END LOOP;
  IF left(receipt->>'revision',length(receipt->>'service')+1) <> (receipt->>'service') || '-' THEN RETURN false; END IF;
  FOREACH key IN ARRAY ARRAY['project','location','engineId'] LOOP
    IF jsonb_typeof(memory->key) IS DISTINCT FROM 'string'
       OR length(memory->>key) NOT BETWEEN 1 AND 256
       OR memory->>key !~ '^[A-Za-z0-9_-]+$' THEN RETURN false; END IF;
  END LOOP;
  IF jsonb_typeof(incarnation->'name') IS DISTINCT FROM 'string'
     OR length(incarnation->>'name') NOT BETWEEN 1 AND 1024
     OR incarnation->>'name' !~ '^projects/[A-Za-z0-9_-]+/locations/[A-Za-z0-9_-]+/reasoningEngines/[A-Za-z0-9_-]+$'
     OR split_part(incarnation->>'name','/',4) <> memory->>'location'
     OR split_part(incarnation->>'name','/',6) <> memory->>'engineId'
     OR jsonb_typeof(incarnation->'createTime') IS DISTINCT FROM 'string'
     OR length(incarnation->>'createTime') NOT BETWEEN 1 AND 64
     OR incarnation->>'createTime' !~ '^.+T.+(Z|[+-][0-9]{2}:[0-9]{2})$' THEN RETURN false; END IF;
  IF memory ? 'creationProvenance' AND (
     jsonb_typeof(memory->'creationProvenance') IS DISTINCT FROM 'object'
     OR (memory->'creationProvenance') - ARRAY['version','reservationGeneration','engineIncarnation'] <> '{}'::jsonb
     OR memory->'creationProvenance'->'version' IS DISTINCT FROM '1'::jsonb
     OR jsonb_typeof(memory->'creationProvenance'->'reservationGeneration') IS DISTINCT FROM 'number'
     OR coalesce(memory->'creationProvenance'->>'reservationGeneration','') !~ '^[1-9][0-9]*$'
     OR memory->'creationProvenance'->'engineIncarnation' IS DISTINCT FROM incarnation
  ) THEN RETURN false; END IF;
  PERFORM (incarnation->>'createTime')::timestamptz;
  RETURN true;
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.valid_erasure_memory_deletion(reservation jsonb, receipt jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = public AS $$
 SELECT coalesce(jsonb_typeof(receipt)='object'
   AND receipt->>'status'='provider_deleted'
   AND receipt - 'status' = reservation->'memoryBinding'
   AND public.valid_erasure_memory_binding(reservation,receipt - 'status')
   AND jsonb_typeof(reservation->'memoryBinding'->'memoryBinding'->'creationProvenance')='object',false);
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
    RAISE EXCEPTION 'personal agent erasure reserved' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.retain_erasure_memory_binding(
  owner_id text, attempt_id text, expected jsonb, receipt jsonb
) RETURNS boolean LANGUAGE plpgsql SET search_path = public AS $$
DECLARE current_row public.personal_agent_registry%ROWTYPE; reservation jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
  PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
  SELECT * INTO current_row FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
  IF NOT FOUND OR current_row.status IS DISTINCT FROM 'suspended' THEN RETURN false; END IF;
  reservation := current_row.backend_metadata->'erasure';
  IF reservation->>'ownerId' IS DISTINCT FROM owner_id
     OR reservation->>'attemptId' IS DISTINCT FROM attempt_id
     OR NOT public.valid_erasure_memory_binding(reservation,receipt) THEN RETURN false; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
      WHERE tgrelid='public.personal_agent_registry'::regclass
        AND tgname='zz_personal_agent_erasure_registry' AND tgenabled IN ('O','A')
        AND tgtype=27 AND tgnargs=0 AND tgqual IS NULL
        AND tgfoid='public.guard_personal_agent_erasure_registry()'::regprocedure) THEN RETURN false; END IF;
  IF reservation ? 'memoryBinding' THEN RETURN reservation->'memoryBinding'=receipt; END IF;
  IF reservation IS DISTINCT FROM expected THEN RETURN false; END IF;
  UPDATE public.personal_agent_registry SET backend_metadata=jsonb_set(
    backend_metadata,'{erasure,memoryBinding}',receipt,true) WHERE user_id=owner_id;
  RETURN true;
END;
$$;
CREATE OR REPLACE FUNCTION public.retain_erasure_memory_deletion(
  owner_id text, attempt_id text, expected jsonb, receipt jsonb
) RETURNS boolean LANGUAGE plpgsql SET search_path = public AS $$
DECLARE current_row public.personal_agent_registry%ROWTYPE; reservation jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
  PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
  SELECT * INTO current_row FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
  IF NOT FOUND OR current_row.status IS DISTINCT FROM 'suspended' THEN RETURN false; END IF;
  reservation := current_row.backend_metadata->'erasure';
  IF reservation->>'ownerId' IS DISTINCT FROM owner_id
     OR reservation->>'attemptId' IS DISTINCT FROM attempt_id
     OR NOT public.valid_erasure_memory_deletion(reservation,receipt) THEN RETURN false; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
      WHERE tgrelid='public.personal_agent_registry'::regclass
        AND tgname='zz_personal_agent_erasure_registry' AND tgenabled IN ('O','A')
        AND tgtype=27 AND tgnargs=0 AND tgqual IS NULL
        AND tgfoid='public.guard_personal_agent_erasure_registry()'::regprocedure) THEN RETURN false; END IF;
  IF reservation ? 'memoryDeletion' THEN RETURN reservation->'memoryDeletion'=receipt; END IF;
  IF reservation IS DISTINCT FROM expected THEN RETURN false; END IF;
  UPDATE public.personal_agent_registry SET backend_metadata=jsonb_set(
    backend_metadata,'{erasure,memoryDeletion}',receipt,true) WHERE user_id=owner_id;
  RETURN true;
END;
$$;
COMMIT;
