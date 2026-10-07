-- Dev only: remove the notification port; retained obligations require cleanup first.
BEGIN;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.personal_agent_registry WHERE
  jsonb_path_exists(backend_metadata,'$.**.notificationCheckpoint')
  OR jsonb_path_exists(backend_metadata,'$.**.lateNotificationObservation')
  OR jsonb_path_exists(backend_metadata,'$.**.mailErasure.*.resources'))
  OR EXISTS(SELECT 1 FROM public.personal_agent_standby_placements WHERE
   jsonb_path_exists(backend_metadata,'$.**.notificationCheckpoint')) THEN
  RAISE EXCEPTION 'notification checkpoint receipts require retention before rollback';
 END IF;
END $$;
CREATE OR REPLACE FUNCTION public.guard_personal_agent_erasure_registry()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE reservation jsonb; snapshot jsonb;
BEGIN
  IF TG_OP='DELETE' AND public.personal_agent_erasure_archived(OLD.user_id,OLD.backend_metadata->'erasure') IS TRUE THEN RETURN OLD; END IF;
  IF OLD.backend_metadata ? 'erasure' THEN
    reservation := OLD.backend_metadata->'erasure';
    snapshot := reservation->'registrySnapshot';

    IF TG_OP='UPDATE'
       AND to_jsonb(NEW)-'backend_metadata'=to_jsonb(OLD)-'backend_metadata'
       AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
       AND (NEW.backend_metadata->'erasure')-'lateFilesUpgradeObservation'=OLD.backend_metadata->'erasure'
       AND NOT (OLD.backend_metadata->'erasure' ? 'lateFilesUpgradeObservation')
       AND NOT (OLD.backend_metadata->'erasure' ? 'substrateInventory')
       AND public.valid_erasure_files_upgrade_observation(OLD.backend_metadata->'erasure',
           NEW.backend_metadata->'erasure'->'lateFilesUpgradeObservation') IS TRUE THEN RETURN NEW;
    END IF;

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
    -- Owner-access erasure (949): the pod's confirmation, once, before any revocation.
    IF TG_OP='UPDATE' AND to_jsonb(NEW)-'backend_metadata'=to_jsonb(OLD)-'backend_metadata'
       AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
       AND NOT (OLD.backend_metadata->'erasure' ? 'agentCryptoErase')
       AND NOT (OLD.backend_metadata->'erasure' ? 'ownerAccessErasure')
       AND (NEW.backend_metadata->'erasure')-'agentCryptoErase'=OLD.backend_metadata->'erasure'
       AND public.valid_erasure_owner_access_checkpoint(OLD.backend_metadata->'erasure',
           NEW.backend_metadata->'erasure'->'agentCryptoErase') IS TRUE THEN RETURN NEW; END IF;
    -- Owner-access erasure (949): one receipt, once, validated against the snapshot.
    IF TG_OP='UPDATE' AND to_jsonb(NEW)-'backend_metadata'=to_jsonb(OLD)-'backend_metadata'
       AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
       AND NOT (OLD.backend_metadata->'erasure' ? 'ownerAccessErasure')
       AND (NEW.backend_metadata->'erasure')-'ownerAccessErasure'=OLD.backend_metadata->'erasure'
       AND public.valid_erasure_owner_access(OLD.backend_metadata->'erasure',
           NEW.backend_metadata->'erasure'->'ownerAccessErasure') IS TRUE THEN RETURN NEW; END IF;
    -- Never-hosted erasure (954): the derived receipt and the project fence, once.
    IF TG_OP='UPDATE' AND to_jsonb(NEW)-'backend_metadata'=to_jsonb(OLD)-'backend_metadata'
       AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
       AND public.valid_erasure_never_hosted_append(OLD.user_id,OLD.backend_metadata->'erasure',
           NEW.backend_metadata->'erasure') IS TRUE
       AND public.project_grant_release_is_exclusive(OLD.user_id,
           NEW.backend_metadata->'erasure'->'grantRelease'->>'project') IS TRUE THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'personal agent erasure reserved' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.effective_erasure_substrate_inventory(r jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $$
DECLARE inventory jsonb:=r->'registrySnapshot'->'backend_metadata'->'substrateReceipt';
 observation jsonb:=r->'lateFilesUpgradeObservation'; result jsonb; item jsonb; values_array jsonb;
BEGIN
 IF observation IS NULL THEN RETURN inventory; END IF;
 IF public.valid_erasure_files_upgrade_observation(r,observation) IS DISTINCT FROM true THEN RETURN NULL; END IF;
 result:=observation->'completed'->-1;
 IF result ? 'resourceObservation' THEN
  item:=result->'resourceObservation'; values_array:=coalesce(inventory->'resourceObservations','[]'::jsonb);
  IF NOT values_array @> jsonb_build_array(item) THEN values_array:=values_array||jsonb_build_array(item); END IF;
  inventory:=jsonb_set(inventory,'{resourceObservations}',values_array,true);
 END IF;
 IF result ? 'bindingObservations' THEN
  values_array:=coalesce(inventory->'bindingObservations','[]'::jsonb);
  FOR item IN SELECT value FROM jsonb_array_elements(result->'bindingObservations') LOOP
   IF NOT values_array @> jsonb_build_array(item) THEN values_array:=values_array||jsonb_build_array(item); END IF;
  END LOOP;
  inventory:=jsonb_set(inventory,'{bindingObservations}',values_array,true);
 END IF;
 RETURN inventory;
END;
$$;
CREATE OR REPLACE FUNCTION public.valid_erasure_substrate_inventory(reservation jsonb, inventory jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $$
BEGIN
 IF jsonb_typeof(inventory) IS DISTINCT FROM 'object'
    OR inventory IS DISTINCT FROM public.effective_erasure_substrate_inventory(reservation)
    OR inventory->>'version' IS DISTINCT FROM 'byoc.substrate.receipt.v1'
    OR jsonb_typeof(inventory->'plannedResources') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 IF jsonb_array_length(inventory->'plannedResources')=0 THEN RETURN false; END IF;
 RETURN coalesce(public.valid_erasure_compute_receipt(reservation,'computeDeletion',reservation->'computeDeletion'),false);
END;
$$;

CREATE OR REPLACE FUNCTION public.valid_erasure_mail_receipt(reservation jsonb, kind text, stage text, receipt jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $$
DECLARE inventory jsonb; observation jsonb; identity jsonb; project text; resource_name text; dependency text; admitted jsonb;
BEGIN
 IF public.valid_erasure_writer_receipt(reservation,'writerDisabled',reservation->'writerDisabled') IS DISTINCT FROM true
    OR kind IS NULL OR kind NOT IN ('cloud_scheduler_job','pubsub_subscription','pubsub_topic')
    OR stage IS NULL OR stage NOT IN ('admission','acknowledgement','deletion')
    OR jsonb_typeof(receipt) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 inventory:=reservation->'substrateInventory'; observation:=receipt->'resourceObservation'; identity:=observation->'identity';
 project:=reservation->'registrySnapshot'->>'user_cloud_project';
 IF receipt->>'ownerId' IS DISTINCT FROM reservation->>'ownerId'
    OR receipt->>'attemptId' IS DISTINCT FROM reservation->>'attemptId'
    OR receipt - ARRAY['ownerId','attemptId','resourceObservation','status'] <> '{}'::jsonb
    OR jsonb_typeof(observation) IS DISTINCT FROM 'object'
    OR observation - ARRAY['type','id','disposition','identity'] <> '{}'::jsonb
    OR observation->>'type' IS DISTINCT FROM kind OR observation->>'disposition' IS DISTINCT FROM 'created'
    OR observation->>'id' IS NULL OR observation->>'id' !~ '^[A-Za-z0-9_.~-]{1,255}$'
    OR jsonb_typeof(identity) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 resource_name := 'projects/' || project || '/' || CASE kind
    WHEN 'cloud_scheduler_job' THEN 'locations/' || (reservation->'registrySnapshot'->>'user_cloud_region') || '/jobs/'
    WHEN 'pubsub_subscription' THEN 'subscriptions/' ELSE 'topics/' END || (observation->>'id');
 IF resource_name IS NULL OR identity->>'name' IS DISTINCT FROM resource_name THEN RETURN false; END IF;
 IF (SELECT count(*) FROM jsonb_array_elements(inventory->'plannedResources') AS r WHERE r->>'type'=kind) <> 1
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(inventory->'plannedResources') AS r WHERE r->>'type'=kind AND r->>'id'=observation->>'id')
    OR (SELECT count(*) FROM jsonb_array_elements(inventory->'resourceObservations') AS r WHERE r=observation) <> 1 THEN RETURN false; END IF;
 IF kind='pubsub_topic' AND identity - 'name' <> '{}'::jsonb THEN RETURN false; END IF;
 IF kind='pubsub_subscription' AND (identity - ARRAY['name','topic'] <> '{}'::jsonb
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(inventory->'plannedResources') AS r WHERE r->>'type'='pubsub_topic' AND identity->>'topic'='projects/' || project || '/topics/' || (r->>'id'))) THEN RETURN false; END IF;
 IF kind='cloud_scheduler_job' AND (identity - ARRAY['name','pubsubTarget','schedule','timeZone'] <> '{}'::jsonb
    OR jsonb_typeof(identity->'pubsubTarget') IS DISTINCT FROM 'object'
    OR (identity->'pubsubTarget') - 'topicName' <> '{}'::jsonb
    OR jsonb_typeof(identity->'schedule') IS DISTINCT FROM 'string' OR length(identity->>'schedule') NOT BETWEEN 1 AND 128
    OR jsonb_typeof(identity->'timeZone') IS DISTINCT FROM 'string' OR length(identity->>'timeZone') NOT BETWEEN 1 AND 128
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(inventory->'plannedResources') AS r WHERE r->>'type'='pubsub_topic' AND identity->'pubsubTarget'->>'topicName'='projects/' || project || '/topics/' || (r->>'id'))) THEN RETURN false; END IF;
 IF stage='admission' THEN
    dependency := CASE kind WHEN 'pubsub_subscription' THEN 'cloud_scheduler_job' WHEN 'pubsub_topic' THEN 'pubsub_subscription' ELSE NULL END;
    IF dependency IS NOT NULL AND EXISTS (SELECT 1 FROM jsonb_array_elements(inventory->'plannedResources') AS r WHERE r->>'type'=dependency)
       AND public.valid_erasure_mail_receipt(reservation,dependency,'deletion',reservation->'mailErasure'->dependency->'deletion') IS DISTINCT FROM true THEN RETURN false; END IF;
    RETURN receipt->>'status'='admitted';
 END IF;
 admitted:=reservation->'mailErasure'->kind->'admission';
 IF public.valid_erasure_mail_receipt(reservation,kind,'admission',admitted) IS DISTINCT FROM true
    OR receipt - 'status' IS DISTINCT FROM admitted - 'status' THEN RETURN false; END IF;
 IF stage='acknowledgement' THEN RETURN receipt->>'status'='acknowledged'; END IF;
 RETURN receipt->>'status'='absent' AND public.valid_erasure_mail_receipt(reservation,kind,'acknowledgement',reservation->'mailErasure'->kind->'acknowledgement');
END;
$$;

CREATE OR REPLACE FUNCTION public.valid_erasure_mail_append(before_record jsonb, after_record jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $$
DECLARE kind text; stage text; old_mail jsonb; new_mail jsonb; old_kind jsonb; new_kind jsonb;
BEGIN
 old_mail:=coalesce(before_record->'mailErasure','{}'::jsonb); new_mail:=after_record->'mailErasure';
 IF jsonb_typeof(new_mail) IS DISTINCT FROM 'object' OR after_record-'mailErasure' IS DISTINCT FROM before_record-'mailErasure' THEN RETURN false; END IF;
 FOREACH kind IN ARRAY ARRAY['cloud_scheduler_job','pubsub_subscription','pubsub_topic'] LOOP
  old_kind:=coalesce(old_mail->kind,'{}'::jsonb); new_kind:=new_mail->kind;
  FOREACH stage IN ARRAY ARRAY['admission','acknowledgement','deletion'] LOOP
   IF NOT (old_kind ? stage) AND new_kind ? stage AND new_mail-kind=old_mail-kind
      AND new_kind-stage=old_kind AND public.valid_erasure_mail_receipt(before_record,kind,stage,new_kind->stage) IS TRUE THEN RETURN true; END IF;
  END LOOP;
 END LOOP;
 RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.retain_erasure_mail_receipt(
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
    OR public.valid_erasure_mail_receipt(reservation,kind,stage,receipt) IS DISTINCT FROM true THEN RETURN false; END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_registry'::regclass
    AND tgname='zz_personal_agent_erasure_registry' AND tgenabled IN ('O','A')
    AND tgtype=27 AND tgnargs=0 AND tgqual IS NULL
    AND tgfoid='public.guard_personal_agent_erasure_registry()'::regprocedure) THEN RETURN false; END IF;
 IF reservation->'mailErasure'->kind ? stage THEN
   RETURN stage <> 'admission' AND reservation->'mailErasure'->kind->stage=receipt;
 END IF;
 IF reservation IS DISTINCT FROM expected THEN RETURN false; END IF;
 UPDATE public.personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata,ARRAY['erasure','mailErasure'],coalesce(reservation->'mailErasure','{}'::jsonb) || jsonb_build_object(kind,coalesce(reservation->'mailErasure'->kind,'{}'::jsonb) || jsonb_build_object(stage,receipt)),true)
 WHERE user_id=owner_id;
 RETURN true;
END;
$$;

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

CREATE OR REPLACE FUNCTION public.verify_erasure_kms_preflight(owner_id text, attempt_id text, expected jsonb)
RETURNS boolean LANGUAGE sql STABLE SET search_path=public AS $$
 SELECT public.verify_erasure_mail_preflight(owner_id,attempt_id,expected)
 AND public.valid_erasure_bucket_receipt(expected,'bucketDeletion',expected->'bucketDeletion') IS TRUE
 AND NOT EXISTS (SELECT 1 FROM unnest(ARRAY['cloud_scheduler_job','pubsub_subscription','pubsub_topic']) kind
 WHERE public.valid_erasure_mail_receipt(expected,kind,'deletion',expected->'mailErasure'->kind->'deletion') IS DISTINCT FROM true);
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
    THEN jsonb_build_object('filesErasure',r->'filesErasure') ELSE '{}'::jsonb END
   -- 954: keep the person's never-hosted receipt; absent (no key) on every hosted archive.
   || jsonb_strip_nulls(jsonb_build_object('neverHosted',r->'neverHosted')));
$$;
DROP FUNCTION public.erasure_mail_resources_deleted(jsonb);
DROP FUNCTION public.erasure_mail_resource_state(jsonb,text,text);
DROP TRIGGER zz_personal_agent_notification_standby_retention ON public.personal_agent_standby_placements;
DROP FUNCTION public.guard_personal_agent_notification_standby_retention();
DROP TRIGGER zz_personal_agent_notification_retention ON public.personal_agent_registry;
DROP FUNCTION public.guard_personal_agent_notification_retention();
DROP FUNCTION public.notification_erasure_custody_archived(text,jsonb,jsonb);
DROP FUNCTION public.notification_placement_custody(jsonb);
DROP TRIGGER zx_personal_agent_notification_registry ON public.personal_agent_registry;
DROP FUNCTION public.guard_personal_agent_notification_registry();
DROP FUNCTION public.notification_initial_host_binding(jsonb,jsonb);
DROP FUNCTION public.notification_checkpoint_admission_ready();
DROP FUNCTION public.publish_personal_agent_notification_checkpoint(text,text,text,text,bigint,jsonb);
DROP FUNCTION public.valid_erasure_notification_observation(jsonb,jsonb);
DROP FUNCTION public.valid_personal_agent_notification_checkpoint(jsonb,jsonb,jsonb);
DROP FUNCTION public.notification_checkpoint_inventory(jsonb,jsonb);
COMMIT;
