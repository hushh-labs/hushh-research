-- Dev-only: retain the owner-access erasure receipt for an agent in the person's
-- own Azure subscription (docs/reference/architecture/byoc-azure.md).
--
-- PARKED (dev-only band, same contract as 900-948): out of
-- db/release_migration_manifest.json, applied only by the dev migration lane.
--
-- Hussh holds no delete authority in the person's subscription, so erasure there is:
-- the pod crypto-erases itself behind the erasure fence, Hussh revokes the pod's
-- access and then its own, last, and the person receives a receipt naming what
-- remains (resource ids, the vault's earliest purge date, the resource group to
-- delete). This retains that receipt once under the reserved attempt, like every
-- other erasure receipt. It completes nothing: the account guard still refuses
-- while the person's resources remain.
--
-- The registry guard is 943's verbatim plus one transition before its final
-- refusal (940 records what rewriting it by hand once lost).

BEGIN;

CREATE OR REPLACE FUNCTION public.valid_erasure_owner_access(reservation jsonb, receipt jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE
  snapshot jsonb := reservation->'registrySnapshot';
  agent jsonb := receipt->'agentErased';
  vault jsonb := receipt->'keyVault';
  grp text;
  days text;
BEGIN
  -- Types first, each on its own: a jsonb operator on the wrong type raises.
  IF jsonb_typeof(receipt) IS DISTINCT FROM 'object'
     OR jsonb_typeof(agent) IS DISTINCT FROM 'object'
     OR jsonb_typeof(vault) IS DISTINCT FROM 'object'
     OR jsonb_typeof(snapshot) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  IF receipt - ARRAY['version','tenantId','subscriptionId','resourceGroup','agentErased',
       'agentAccessRevoked','husshAccessRevoked','remainingResources','keyVault','nextStep'] <> '{}'::jsonb
     OR NOT receipt ?& ARRAY['version','tenantId','subscriptionId','resourceGroup','agentErased',
       'agentAccessRevoked','husshAccessRevoked','remainingResources','keyVault','nextStep']
     OR pg_column_size(receipt) > 65536
     OR receipt->'version' IS DISTINCT FROM '1'::jsonb
     OR reservation->>'phase' IS DISTINCT FROM 'reserved'
     OR reservation->>'version' IS DISTINCT FROM '1'
     OR snapshot->>'user_id' IS DISTINCT FROM reservation->>'ownerId'
     OR snapshot->>'status' IS DISTINCT FROM 'provisioned'
     OR snapshot->>'deployment_target' IS DISTINCT FROM 'user_azure'
     OR snapshot->'backend_metadata' ? 'upgradeLease'
     OR receipt->>'tenantId' IS DISTINCT FROM snapshot->>'user_cloud_tenant_id'
     OR receipt->>'subscriptionId' IS DISTINCT FROM snapshot->>'user_cloud_subscription_id'
     OR receipt->>'resourceGroup' IS DISTINCT FROM snapshot->>'user_cloud_resource_group'
  THEN RETURN false; END IF;
  -- The pod's own confirmation, bound to this attempt and the recorded incarnation.
  IF agent->'erased' IS DISTINCT FROM 'true'::jsonb
     OR agent->>'status' IS DISTINCT FROM 'erased'
     OR agent->>'attemptId' IS DISTINCT FROM reservation->>'attemptId'
     OR agent->>'hushhId' IS DISTINCT FROM reservation->>'hushhId'
     OR agent->>'serviceUid' IS DISTINCT FROM snapshot->'backend_metadata'->>'serviceUid'
     OR coalesce(agent->>'deleted','') !~ '^[0-9]{1,9}$'
     OR coalesce(agent->>'alreadyAbsent','') !~ '^[0-9]{1,9}$'
     OR coalesce(agent->>'records','') !~ '^[0-9]{1,9}$' THEN RETURN false; END IF;
  -- Every named resource lies inside the person's own resource group.
  IF jsonb_typeof(receipt->'agentAccessRevoked') IS DISTINCT FROM 'array'
     OR jsonb_typeof(receipt->'husshAccessRevoked') IS DISTINCT FROM 'array'
     OR jsonb_typeof(receipt->'remainingResources') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  grp := lower('/subscriptions/' || (receipt->>'subscriptionId') || '/resourcegroups/' || (receipt->>'resourceGroup'));
  IF EXISTS (
    SELECT 1
    FROM unnest(ARRAY['agentAccessRevoked','husshAccessRevoked','remainingResources']) AS field,
         jsonb_array_elements(receipt->field) AS element
    WHERE jsonb_typeof(element) IS DISTINCT FROM 'string'
       OR length(element #>> '{}') > 1024
       OR NOT (lower(element #>> '{}') = grp OR left(lower(element #>> '{}'), length(grp) + 1) = grp || '/')
  ) OR NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(receipt->'remainingResources') AS remaining
    WHERE lower(remaining) = grp
  ) THEN RETURN false; END IF;
  days := vault->>'softDeleteRetentionDays';
  IF vault - ARRAY['name','purgeProtection','softDeleteRetentionDays','earliestPurgeIfDeletedToday'] <> '{}'::jsonb
     OR jsonb_typeof(vault->'name') IS DISTINCT FROM 'string'
     OR coalesce(vault->>'name','') !~ '^[a-z0-9-]{3,24}$'
     OR vault->'purgeProtection' IS DISTINCT FROM 'true'::jsonb
     OR jsonb_typeof(vault->'softDeleteRetentionDays') IS DISTINCT FROM 'number'
     OR coalesce(days,'') !~ '^[0-9]{1,2}$'
     OR coalesce(vault->>'earliestPurgeIfDeletedToday','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
     OR jsonb_typeof(receipt->'nextStep') IS DISTINCT FROM 'string'
     OR length(receipt->>'nextStep') NOT BETWEEN 1 AND 1000
     OR position(lower(receipt->>'resourceGroup') IN lower(receipt->>'nextStep')) = 0
  THEN RETURN false; END IF;
  IF days::int NOT BETWEEN 7 AND 90 THEN RETURN false; END IF;
  PERFORM (vault->>'earliestPurgeIfDeletedToday')::date;
  RETURN true;
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.retain_erasure_owner_access(
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
     OR NOT public.valid_erasure_owner_access(reservation,receipt) THEN RETURN false; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
      WHERE tgrelid='public.personal_agent_registry'::regclass
        AND tgname='zz_personal_agent_erasure_registry' AND tgenabled IN ('O','A')
        AND tgtype=27 AND tgnargs=0 AND tgqual IS NULL
        AND tgfoid='public.guard_personal_agent_erasure_registry()'::regprocedure) THEN RETURN false; END IF;
  IF reservation ? 'ownerAccessErasure' THEN RETURN reservation->'ownerAccessErasure'=receipt; END IF;
  IF reservation IS DISTINCT FROM expected THEN RETURN false; END IF;
  UPDATE public.personal_agent_registry SET backend_metadata=jsonb_set(
    backend_metadata,'{erasure,ownerAccessErasure}',receipt,true) WHERE user_id=owner_id;
  RETURN true;
END;
$$;

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
    -- Owner-access erasure (949): one receipt, once, validated against the snapshot.
    IF TG_OP='UPDATE' AND to_jsonb(NEW)-'backend_metadata'=to_jsonb(OLD)-'backend_metadata'
       AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
       AND NOT (OLD.backend_metadata->'erasure' ? 'ownerAccessErasure')
       AND (NEW.backend_metadata->'erasure')-'ownerAccessErasure'=OLD.backend_metadata->'erasure'
       AND public.valid_erasure_owner_access(OLD.backend_metadata->'erasure',
           NEW.backend_metadata->'erasure'->'ownerAccessErasure') IS TRUE THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'personal agent erasure reserved' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

COMMIT;
