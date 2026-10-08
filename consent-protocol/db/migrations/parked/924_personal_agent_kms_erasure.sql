-- Dev-only KMS checkpoints inside the existing owner erasure reservation.
BEGIN;
CREATE OR REPLACE FUNCTION public.valid_erasure_kms_receipt(r jsonb, stage text, receipt jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $$
DECLARE obs jsonb; ident jsonb; inv jsonb; captured jsonb; version_name text; key_name text; kind text;
BEGIN
 IF stage IS NULL OR stage NOT IN ('inventory','admission','acknowledgement','destruction','completion')
 OR jsonb_typeof(receipt) IS DISTINCT FROM 'object'
 OR public.valid_erasure_bucket_receipt(r,'bucketDeletion',r->'bucketDeletion') IS DISTINCT FROM true THEN RETURN false; END IF;
 FOREACH kind IN ARRAY ARRAY['cloud_scheduler_job','pubsub_subscription','pubsub_topic'] LOOP
  IF public.valid_erasure_mail_receipt(r,kind,'deletion',r->'mailErasure'->kind->'deletion') IS DISTINCT FROM true THEN RETURN false; END IF;
 END LOOP;
 inv:=r->'substrateInventory'; obs:=receipt->'resourceObservation'; ident:=obs->'identity';
 key_name:='projects/' || (r->'registrySnapshot'->>'user_cloud_project') || '/locations/' || (r->'registrySnapshot'->>'user_cloud_region') || '/keyRings/hushh-one/cryptoKeys/' || (obs->>'id');
 IF receipt->>'ownerId' IS DISTINCT FROM r->>'ownerId' OR receipt->>'attemptId' IS DISTINCT FROM r->>'attemptId'
 OR jsonb_typeof(obs) IS DISTINCT FROM 'object' OR obs - ARRAY['type','id','disposition','identity'] <> '{}'::jsonb
 OR obs->>'type' IS DISTINCT FROM 'kms_key' OR obs->>'disposition' IS DISTINCT FROM 'created'
 OR obs->>'id' IS NULL OR obs->>'id' !~ '^[A-Za-z0-9_-]{1,63}$'
 OR jsonb_typeof(ident) IS DISTINCT FROM 'object' OR ident - ARRAY['name','purpose','createTime'] <> '{}'::jsonb
 OR key_name IS NULL OR ident->>'name' IS DISTINCT FROM key_name OR ident->>'purpose' IS DISTINCT FROM 'ENCRYPT_DECRYPT'
 OR jsonb_typeof(ident->'createTime') IS DISTINCT FROM 'string' OR length(ident->>'createTime') NOT BETWEEN 1 AND 64
 OR (SELECT count(*) FROM jsonb_array_elements(inv->'plannedResources') x WHERE x->>'type'='kms_key') <> 1
 OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(inv->'plannedResources') x WHERE x->>'type'='kms_key' AND x->>'id'=obs->>'id')
 OR (SELECT count(*) FROM jsonb_array_elements(inv->'resourceObservations') x WHERE x=obs) <> 1 THEN RETURN false; END IF;
 IF stage='inventory' THEN
  IF receipt - ARRAY['ownerId','attemptId','resourceObservation','versionNames'] <> '{}'::jsonb
  OR jsonb_typeof(receipt->'versionNames') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(receipt->'versionNames') > 32000 THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(receipt->'versionNames') x WHERE jsonb_typeof(x) <> 'string'
    OR left(x #>> '{}',length(key_name || '/cryptoKeyVersions/')) <> key_name || '/cryptoKeyVersions/'
    OR substring(x #>> '{}' FROM length(key_name || '/cryptoKeyVersions/')+1) !~ '^[0-9]{1,20}$') THEN RETURN false; END IF;
  RETURN (SELECT count(*)=count(DISTINCT x) FROM jsonb_array_elements(receipt->'versionNames') x);
 END IF;
 captured:=r->'kmsErasure'->'inventory';
 IF public.valid_erasure_kms_receipt(r,'inventory',captured) IS DISTINCT FROM true
 OR receipt->'resourceObservation' IS DISTINCT FROM captured->'resourceObservation' THEN RETURN false; END IF;
 IF stage='completion' THEN
  IF receipt - 'status' IS DISTINCT FROM captured OR receipt->>'status' IS DISTINCT FROM 'destroyed' THEN RETURN false; END IF;
  FOR version_name IN SELECT jsonb_array_elements_text(captured->'versionNames') LOOP
   IF public.valid_erasure_kms_receipt(r,'destruction',r->'kmsErasure'->'versions'->version_name->'destruction') IS DISTINCT FROM true THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
 END IF;
 version_name:=receipt->>'versionName';
 IF receipt - ARRAY['ownerId','attemptId','resourceObservation','versionName','status'] <> '{}'::jsonb
 OR version_name IS NULL OR NOT (captured->'versionNames' ? version_name) THEN RETURN false; END IF;
 IF stage='admission' THEN RETURN receipt->>'status'='admitted'; END IF;
 IF stage='destruction' THEN RETURN receipt->>'status'='destroyed'; END IF;
 RETURN receipt->>'status'='scheduled'
 AND public.valid_erasure_kms_receipt(r,'admission',r->'kmsErasure'->'versions'->version_name->'admission') IS TRUE;
END;
$$;
CREATE OR REPLACE FUNCTION public.valid_erasure_kms_append(old_r jsonb,new_r jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $$
DECLARE old_k jsonb; new_k jsonb; stage text; version_name text; prior jsonb; incoming jsonb;
BEGIN
 old_k:=coalesce(old_r->'kmsErasure','{}'::jsonb); new_k:=new_r->'kmsErasure';
 IF new_r - 'kmsErasure' IS DISTINCT FROM old_r - 'kmsErasure' OR jsonb_typeof(new_k) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 FOREACH stage IN ARRAY ARRAY['inventory','completion'] LOOP
  IF NOT (old_k ? stage) AND new_k - stage=old_k AND public.valid_erasure_kms_receipt(old_r,stage,new_k->stage) IS TRUE THEN RETURN true; END IF;
 END LOOP;
 IF new_k - 'versions' IS DISTINCT FROM old_k - 'versions' OR jsonb_typeof(new_k->'versions') IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 FOR version_name,incoming IN SELECT * FROM jsonb_each(new_k->'versions') LOOP
  prior:=coalesce(old_k->'versions'->version_name,'{}'::jsonb);
  IF jsonb_typeof(incoming) IS DISTINCT FROM 'object' OR (new_k->'versions') - version_name IS DISTINCT FROM coalesce(old_k->'versions','{}'::jsonb) - version_name THEN CONTINUE; END IF;
  FOREACH stage IN ARRAY ARRAY['admission','acknowledgement','destruction'] LOOP
   IF NOT (prior ? stage) AND incoming - stage=prior
   AND incoming->stage->>'versionName'=version_name
   AND public.valid_erasure_kms_receipt(old_r,stage,incoming->stage) IS TRUE THEN RETURN true; END IF;
  END LOOP;
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
    RAISE EXCEPTION 'personal agent erasure reserved' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;


CREATE OR REPLACE FUNCTION public.retain_erasure_kms_receipt(owner_id text, attempt_id text, expected jsonb, stage text, receipt jsonb)
RETURNS boolean LANGUAGE plpgsql SET search_path=public AS $$
DECLARE current_row public.personal_agent_registry%ROWTYPE; r jsonb; k jsonb; previous jsonb; version_name text;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 SELECT * INTO current_row FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 IF NOT FOUND OR current_row.status IS DISTINCT FROM 'suspended' THEN RETURN false; END IF;
 r:=current_row.backend_metadata->'erasure';
 IF r->>'ownerId' IS DISTINCT FROM owner_id OR r->>'attemptId' IS DISTINCT FROM attempt_id
 OR public.valid_erasure_kms_receipt(r,stage,receipt) IS DISTINCT FROM true THEN RETURN false; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_registry'::regclass
 AND tgname='zz_personal_agent_erasure_registry' AND tgenabled IN ('O','A') AND tgtype=27 AND tgnargs=0 AND tgqual IS NULL
 AND tgfoid='public.guard_personal_agent_erasure_registry()'::regprocedure) THEN RETURN false; END IF;
 k:=coalesce(r->'kmsErasure','{}'::jsonb); version_name:=receipt->>'versionName';
 previous:=CASE WHEN stage IN ('inventory','completion') THEN k->stage ELSE k->'versions'->version_name->stage END;
 IF previous IS NOT NULL THEN RETURN stage <> 'admission' AND previous=receipt; END IF;
 IF r IS DISTINCT FROM expected THEN RETURN false; END IF;
 IF stage IN ('inventory','completion') THEN k:=k || jsonb_build_object(stage,receipt);
 ELSE k:=k || jsonb_build_object('versions',coalesce(k->'versions','{}'::jsonb) || jsonb_build_object(version_name,coalesce(k->'versions'->version_name,'{}'::jsonb) || jsonb_build_object(stage,receipt))); END IF;
 UPDATE public.personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata,ARRAY['erasure','kmsErasure'],k,true) WHERE user_id=owner_id;
 RETURN true;
END;
$$;
CREATE OR REPLACE FUNCTION public.verify_erasure_kms_preflight(owner_id text, attempt_id text, expected jsonb)
RETURNS boolean LANGUAGE sql STABLE SET search_path=public AS $$
 SELECT public.verify_erasure_mail_preflight(owner_id,attempt_id,expected)
 AND public.valid_erasure_bucket_receipt(expected,'bucketDeletion',expected->'bucketDeletion') IS TRUE
 AND NOT EXISTS (SELECT 1 FROM unnest(ARRAY['cloud_scheduler_job','pubsub_subscription','pubsub_topic']) kind
 WHERE public.valid_erasure_mail_receipt(expected,kind,'deletion',expected->'mailErasure'->kind->'deletion') IS DISTINCT FROM true);
$$;
COMMIT;
