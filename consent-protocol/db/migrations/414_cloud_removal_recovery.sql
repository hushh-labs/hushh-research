-- Forward-only, after the qualified cloud-removal contract (972).
-- A review may be withdrawn only before approval and destructive dispatch.
BEGIN;

ALTER TABLE public.personal_agent_cloud_removals
 ADD COLUMN execution_started_at timestamptz,
 ADD COLUMN execution_digest text CHECK (execution_digest ~ '^[0-9a-f]{64}$'),
 ADD COLUMN cancelled_at timestamptz,
 ADD CONSTRAINT cloud_removal_dispatch_pair CHECK
  ((execution_started_at IS NULL) = (execution_digest IS NULL)),
 ADD CONSTRAINT cloud_removal_cancel_inert CHECK
  (cancelled_at IS NULL OR (approved_digest IS NULL AND execution_started_at IS NULL AND completed_at IS NULL));

-- No provider call, key checkpoint or worker can have begun in this shape.
CREATE FUNCTION public.cloud_removal_review_inert(r jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=public AS $$
 SELECT jsonb_typeof(r)='object' AND r->>'phase'='reserved'
 AND r-ARRAY['version','ownerId','attemptId','hushhId','phase','registrySnapshot','substrateInventory','azureTeardown']='{}'::jsonb
 AND (NOT (r ? 'azureTeardown') OR (
  jsonb_typeof(r->'azureTeardown')='object'
  AND (r->'azureTeardown')-ARRAY['plan','approvals','resources','setupHistory','authorizationAttempts']='{}'::jsonb
  AND r->'azureTeardown'->'approvals'='[]'::jsonb
  AND r->'azureTeardown'->'resources'='{}'::jsonb
  AND jsonb_typeof(coalesce(r->'azureTeardown'->'authorizationAttempts','{}'::jsonb))='object'
  AND NOT EXISTS(SELECT 1 FROM jsonb_each(coalesce(r->'azureTeardown'->'authorizationAttempts','{}'::jsonb)) a
    WHERE a.value->>'purpose' IS DISTINCT FROM 'inspect'
       OR a.value->>'status' NOT IN ('settled','attention_required')
       OR a.value->>'status' IS NULL)));
$$;

CREATE FUNCTION public.cloud_removal_cancel_ready(owner_id text, attempt text)
RETURNS boolean LANGUAGE sql STABLE SET search_path=public AS $$
 SELECT EXISTS(SELECT 1 FROM public.personal_agent_cloud_removals c
 JOIN public.personal_agent_registry p ON p.user_id=c.user_id
 WHERE c.user_id=owner_id AND c.attempt_id=attempt
 AND c.cancelled_at IS NULL AND c.execution_started_at IS NULL
 AND c.approved_digest IS NULL AND c.completed_at IS NULL
 AND p.status='suspended' AND p.placement_epoch=c.placement_epoch
 AND p.backend_metadata->'erasure'->>'ownerId'=owner_id
 AND p.backend_metadata->'erasure'->>'attemptId'=attempt
 AND c.snapshot_sha256=encode(sha256(convert_to((p.backend_metadata->'erasure'->'registrySnapshot')::text,'UTF8')),'hex')
 AND public.cloud_removal_review_inert(p.backend_metadata->'erasure') IS TRUE
 AND NOT EXISTS(SELECT 1 FROM public.personal_agent_deletion_tombstones t WHERE t.hushh_id=p.hushh_id)
 AND NOT EXISTS(SELECT 1 FROM public.account_deletion_tombstones t
  WHERE t.user_id_hash='sha256:'||encode(sha256(convert_to(owner_id,'UTF8')),'hex')));
$$;

-- The trigger independently verifies the receipt and exact restored row.
-- A caller-settable GUC alone never supplies restoration authority.
CREATE FUNCTION public.cloud_removal_cancel_restore_allowed(prior jsonb, incoming jsonb)
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=public AS $$
DECLARE r jsonb:=prior->'backend_metadata'->'erasure'; owner_id text:=prior->>'user_id';
BEGIN
 IF NOT pg_try_advisory_xact_lock(hashtextextended(owner_id,171))
 OR NOT pg_try_advisory_xact_lock(hashtextextended(owner_id,198)) THEN RETURN false; END IF;
 RETURN current_setting('transaction_isolation') IN ('read committed','read uncommitted')
 AND prior->>'status'='suspended' AND public.cloud_removal_review_inert(r) IS TRUE
 AND incoming=r->'registrySnapshot' AND incoming->>'user_id'=owner_id
 AND incoming->>'hushh_id'=prior->>'hushh_id' AND NOT (incoming->'backend_metadata' ? 'erasure')
 AND EXISTS(SELECT 1 FROM public.personal_agent_cloud_removals c
  WHERE c.user_id=owner_id AND c.attempt_id=r->>'attemptId' AND c.cancelled_at IS NOT NULL
  AND c.execution_started_at IS NULL AND c.approved_digest IS NULL AND c.completed_at IS NULL
  AND c.placement_epoch=(prior->>'placement_epoch')::bigint
  AND c.snapshot_sha256=encode(sha256(convert_to(incoming::text,'UTF8')),'hex'))
 AND NOT EXISTS(SELECT 1 FROM public.personal_agent_deletion_tombstones t WHERE t.hushh_id=prior->>'hushh_id')
 AND NOT EXISTS(SELECT 1 FROM public.account_deletion_tombstones t
  WHERE t.user_id_hash='sha256:'||encode(sha256(convert_to(owner_id,'UTF8')),'hex'));
END;
$$;

CREATE FUNCTION public.cancel_personal_agent_cloud_removal(owner_id text, attempt text)
RETURNS boolean LANGUAGE plpgsql VOLATILE SET search_path=public AS $$
DECLARE agent public.personal_agent_registry%ROWTYPE; op public.personal_agent_cloud_removals%ROWTYPE;
 snapshot jsonb; columns_sql text;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 SELECT * INTO agent FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT * INTO op FROM public.personal_agent_cloud_removals WHERE user_id=owner_id AND attempt_id=attempt FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 IF op.cancelled_at IS NOT NULL THEN
  -- Replay may confirm only the exact unchanged placement, never a new setup.
  RETURN op.snapshot_sha256=encode(sha256(convert_to(to_jsonb(agent)::text,'UTF8')),'hex');
 END IF;
 IF public.cloud_removal_cancel_ready(owner_id,attempt) IS NOT TRUE THEN RETURN false; END IF;
 snapshot:=agent.backend_metadata->'erasure'->'registrySnapshot';
 UPDATE public.personal_agent_cloud_removals SET cancelled_at=clock_timestamp()
 WHERE user_id=owner_id AND attempt_id=attempt;
 SELECT string_agg(quote_ident(attname),',' ORDER BY attnum) INTO columns_sql
 FROM pg_attribute WHERE attrelid='public.personal_agent_registry'::regclass
 AND attnum>0 AND NOT attisdropped AND attgenerated='';
 EXECUTE format('UPDATE public.personal_agent_registry SET (%1$s)=(SELECT %1$s FROM jsonb_populate_record(NULL::public.personal_agent_registry,$1)) WHERE user_id=$2',columns_sql)
 USING snapshot,owner_id;
 RETURN true;
END;
$$;

CREATE FUNCTION public.begin_personal_agent_cloud_removal(owner_id text, attempt text, expected_digest text)
RETURNS boolean LANGUAGE plpgsql VOLATILE SET search_path=public AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 PERFORM 1 FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 IF public.personal_agent_cloud_removal_execute_ready(owner_id,attempt) IS NOT TRUE THEN RETURN false; END IF;
 UPDATE public.personal_agent_cloud_removals
 SET execution_started_at=coalesce(execution_started_at,clock_timestamp()), execution_digest=expected_digest
 WHERE user_id=owner_id AND attempt_id=attempt AND approved_digest=expected_digest
 AND cancelled_at IS NULL AND completed_at IS NULL
 AND (execution_digest IS NULL OR execution_digest=expected_digest);
 RETURN FOUND;
END;
$$;

CREATE FUNCTION public.cloud_removal_execution_admitted(owner_id text, attempt text)
RETURNS boolean LANGUAGE sql STABLE SET search_path=public AS $$
 SELECT NOT EXISTS(SELECT 1 FROM public.personal_agent_cloud_removals WHERE user_id=owner_id AND attempt_id=attempt)
 OR EXISTS(SELECT 1 FROM public.personal_agent_cloud_removals c
  WHERE c.user_id=owner_id AND c.attempt_id=attempt AND c.cancelled_at IS NULL
  AND c.completed_at IS NULL AND c.execution_started_at IS NOT NULL
  AND c.execution_digest=c.approved_digest
  AND public.personal_agent_cloud_removal_execute_ready(owner_id,attempt) IS TRUE);
$$;

-- Existing provider authorities and immutable receipt validation follow below.

CREATE OR REPLACE FUNCTION public.guard_personal_agent_cloud_removal()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
DECLARE owner_id text; agent public.personal_agent_registry%ROWTYPE; r jsonb; review jsonb; history jsonb;
BEGIN
 owner_id:=CASE WHEN TG_OP='DELETE' THEN OLD.user_id ELSE NEW.user_id END;
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 -- Full account erasure explicitly removes these records in its own transaction.
 IF TG_OP='DELETE' THEN
  IF EXISTS(SELECT 1 FROM public.account_deletion_tombstones WHERE cleanup_intent_kind='full_account'
   AND user_id_hash='sha256:'||encode(sha256(convert_to(owner_id,'UTF8')),'hex')) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'cloud removal evidence retained' USING ERRCODE='42501';
 END IF;
 IF EXISTS(SELECT 1 FROM public.account_deletion_tombstones
  WHERE user_id_hash='sha256:'||encode(sha256(convert_to(owner_id,'UTF8')),'hex')) THEN
  RAISE EXCEPTION 'cloud removal owner deleted' USING ERRCODE='42501'; END IF;
 SELECT * INTO agent FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 r:=agent.backend_metadata->'erasure';
 IF NOT FOUND OR agent.status IS DISTINCT FROM 'suspended' OR jsonb_typeof(r) IS DISTINCT FROM 'object'
 OR NEW.attempt_id IS DISTINCT FROM r->>'attemptId' OR r->>'ownerId' IS DISTINCT FROM owner_id
 OR NEW.placement_epoch IS DISTINCT FROM agent.placement_epoch
 OR NEW.snapshot_sha256 IS DISTINCT FROM encode(sha256(convert_to((r->'registrySnapshot')::text,'UTF8')),'hex') THEN
  RAISE EXCEPTION 'cloud removal placement changed' USING ERRCODE='42501'; END IF;
 IF TG_OP='UPDATE' AND OLD.cancelled_at IS NOT NULL THEN
  RAISE EXCEPTION 'cancelled cloud removal immutable' USING ERRCODE='42501'; END IF;
 IF TG_OP='UPDATE' AND NEW.cancelled_at IS NOT NULL THEN
  IF to_jsonb(NEW)-'cancelled_at' IS DISTINCT FROM to_jsonb(OLD)-'cancelled_at'
  OR public.cloud_removal_cancel_ready(owner_id,NEW.attempt_id) IS NOT TRUE THEN
   RAISE EXCEPTION 'cloud removal cannot cancel' USING ERRCODE='42501'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.approved_digest IS NOT NULL OR NEW.archive IS NOT NULL OR NEW.cancelled_at IS NOT NULL OR NEW.execution_started_at IS NOT NULL OR NEW.execution_digest IS NOT NULL THEN
   RAISE EXCEPTION 'cloud removal approval required' USING ERRCODE='42501'; END IF;
  RETURN NEW;
 END IF;
 IF OLD.completed_at IS NOT NULL OR to_jsonb(NEW)-ARRAY['approved_digest','approved_at','completed_at','archive','released_identity','execution_started_at','execution_digest']
  IS DISTINCT FROM to_jsonb(OLD)-ARRAY['approved_digest','approved_at','completed_at','archive','released_identity','execution_started_at','execution_digest'] THEN
  RAISE EXCEPTION 'cloud removal evidence immutable' USING ERRCODE='42501'; END IF;
 IF OLD.execution_started_at IS NOT NULL AND (NEW.execution_started_at IS DISTINCT FROM OLD.execution_started_at
  OR NEW.execution_digest IS DISTINCT FROM OLD.execution_digest) THEN
  RAISE EXCEPTION 'cloud removal dispatch immutable' USING ERRCODE='42501'; END IF;
 IF NEW.execution_started_at IS NOT NULL AND (NEW.execution_digest IS DISTINCT FROM NEW.approved_digest
  OR (OLD.execution_started_at IS NULL AND public.personal_agent_cloud_removal_execute_ready(owner_id,NEW.attempt_id) IS NOT TRUE)) THEN
  RAISE EXCEPTION 'cloud removal dispatch not admitted' USING ERRCODE='42501'; END IF;
 review:=public.personal_agent_cloud_removal_review(r);
 IF NEW.approved_digest IS NULL OR NEW.approved_digest IS DISTINCT FROM encode(sha256(convert_to(review::text,'UTF8')),'hex')
 OR (NEW.archive IS NOT NULL AND (NEW.approved_digest IS DISTINCT FROM OLD.approved_digest
  OR NEW.approved_at IS DISTINCT FROM OLD.approved_at)) THEN
  RAISE EXCEPTION 'cloud removal approval changed' USING ERRCODE='42501'; END IF;
 IF NEW.archive IS NOT NULL THEN
  SELECT authorization_attempts INTO history FROM public.byoc_setup_jobs WHERE user_id=owner_id;
  IF public.personal_agent_erasure_complete(owner_id) IS NOT TRUE
  OR NEW.archive IS DISTINCT FROM public.personal_agent_erasure_archive(r,history)
  OR NEW.released_identity IS DISTINCT FROM public.personal_agent_cloud_removal_identity(to_jsonb(agent),NEW.completed_at,NEW.attempt_id) THEN
   RAISE EXCEPTION 'cloud removal completion unconfirmed' USING ERRCODE='42501'; END IF;
 END IF;
 RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.personal_agent_cloud_removal_execute_ready(owner_id text, attempt text)
RETURNS boolean LANGUAGE sql STABLE SET search_path=public AS $$
 SELECT public.personal_agent_cloud_removal_ready() IS TRUE AND EXISTS(
  SELECT 1 FROM public.personal_agent_cloud_removals c JOIN public.personal_agent_registry p ON p.user_id=c.user_id
  WHERE c.user_id=owner_id AND c.attempt_id=attempt AND c.completed_at IS NULL AND c.cancelled_at IS NULL
  AND p.status='suspended' AND p.backend_metadata->'erasure'->>'attemptId'=attempt
  AND p.backend_metadata->'erasure'->>'ownerId'=owner_id AND p.placement_epoch=c.placement_epoch
  AND c.snapshot_sha256=encode(sha256(convert_to((p.backend_metadata->'erasure'->'registrySnapshot')::text,'UTF8')),'hex')
  AND c.approved_digest=encode(sha256(convert_to(public.personal_agent_cloud_removal_review(p.backend_metadata->'erasure')::text,'UTF8')),'hex')
  AND c.approved_at>clock_timestamp()-interval '10 minutes');
$$;

CREATE OR REPLACE FUNCTION public.guard_personal_agent_erasure_registry()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE reservation jsonb; snapshot jsonb;
BEGIN
  IF TG_OP='UPDATE' AND public.cloud_removal_cancel_restore_allowed(to_jsonb(OLD),to_jsonb(NEW)) IS TRUE THEN RETURN NEW; END IF;
  IF TG_OP='DELETE' AND public.personal_agent_erasure_archived(OLD.user_id,OLD.backend_metadata->'erasure') IS TRUE THEN RETURN OLD; END IF;
  IF OLD.backend_metadata ? 'erasure' THEN
    reservation := OLD.backend_metadata->'erasure';
    snapshot := reservation->'registrySnapshot';

    -- 962: one validated append to the existing owner resource-cleanup receipt.
    IF TG_OP='UPDATE' AND to_jsonb(NEW)-'backend_metadata'=to_jsonb(OLD)-'backend_metadata'
       AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
       AND public.valid_azure_erasure_append(OLD.user_id,OLD.backend_metadata->'erasure',
           NEW.backend_metadata->'erasure') IS TRUE THEN RETURN NEW; END IF;

    -- 956: one qualified receipt for the exact notification mutation frozen by erasure.
    IF TG_OP='UPDATE' AND to_jsonb(NEW)-'backend_metadata'=to_jsonb(OLD)-'backend_metadata'
       AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
       AND (NEW.backend_metadata->'erasure')-'lateNotificationObservation'=OLD.backend_metadata->'erasure'
       AND NOT (OLD.backend_metadata->'erasure' ? 'lateNotificationObservation')
       AND NOT (OLD.backend_metadata->'erasure' ? 'substrateInventory')
       AND public.valid_erasure_notification_observation(OLD.backend_metadata->'erasure',
           NEW.backend_metadata->'erasure'->'lateNotificationObservation') IS TRUE THEN RETURN NEW; END IF;

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
       AND NOT EXISTS(SELECT 1 FROM public.personal_agent_cloud_removals c
        WHERE c.user_id=OLD.user_id AND c.attempt_id=reservation->>'attemptId')
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

CREATE OR REPLACE FUNCTION public.begin_azure_erasure_worker(
 owner_id text, attempt_id text, execution_id text
) RETURNS boolean LANGUAGE plpgsql VOLATILE SET search_path=public AS $$
DECLARE agent public.personal_agent_registry%ROWTYPE; r jsonb; state jsonb; acquired boolean;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 IF public.cloud_removal_execution_admitted(owner_id,attempt_id) IS NOT TRUE THEN RETURN false; END IF;
 IF public.byoc_azure_worker_session_held(owner_id) IS TRUE THEN RETURN false; END IF;
 acquired:=pg_try_advisory_lock(hashtextextended(owner_id,206));
 IF NOT acquired THEN RETURN false; END IF;
 SELECT * INTO agent FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 r:=agent.backend_metadata->'erasure'; state:=r->'azureTeardown';
 state:=state||jsonb_build_object('worker',jsonb_build_object('executionId',execution_id,
  'backendPid',pg_backend_pid(),'approvalIndex',jsonb_array_length(state->'approvals')-1));
 IF public.retain_azure_erasure_state(owner_id,attempt_id,r,state) IS NOT TRUE THEN
  PERFORM pg_advisory_unlock(hashtextextended(owner_id,206)); RETURN false;
 END IF;
 RETURN true;
EXCEPTION WHEN OTHERS THEN
 -- Closing the dedicated connection is also mandatory for the caller.
 IF acquired THEN PERFORM pg_advisory_unlock(hashtextextended(owner_id,206)); END IF;
 RAISE;
END;
$$;

CREATE OR REPLACE FUNCTION public.assert_azure_erasure_worker(
 owner_id text, attempt_id text, execution_id text
) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=public AS $$
DECLARE r jsonb; state jsonb; approval jsonb;
BEGIN
 SELECT backend_metadata->'erasure' INTO r FROM public.personal_agent_registry
 WHERE user_id=owner_id AND status='suspended';
 state:=r->'azureTeardown'; approval:=state->'approvals'->-1;
 RETURN public.cloud_removal_execution_admitted(owner_id,attempt_id) IS TRUE
 AND r->>'attemptId'=attempt_id
 AND public.byoc_azure_worker_session_held(owner_id) IS TRUE
 AND public.azure_account_cleanup_ready() IS TRUE
 AND public.valid_azure_erasure_plan(owner_id,state->'plan') IS TRUE
 AND public.azure_erasure_writers_drained(owner_id) IS TRUE
 AND public.azure_cleanup_information_erased(owner_id,r) IS TRUE
 AND state->'worker'->>'executionId'=execution_id
 AND state->'worker'->'backendPid'=to_jsonb(pg_backend_pid())
 AND state->'worker'->'approvalIndex'=to_jsonb(jsonb_array_length(state->'approvals')-1)
 AND NOT (coalesce(state->'finalReadbacks','{}'::jsonb) ? execution_id)
 AND NOT (coalesce(state->'workerExits','{}'::jsonb) ? execution_id)
 AND (approval->>'expiresAt')::bigint>extract(epoch FROM statement_timestamp());
END;
$$;

CREATE OR REPLACE FUNCTION public.restore_personal_agent_erasure_reservation(
  owner_id text, attempt_id text, snapshot_sha256 text, evidence jsonb
)
RETURNS boolean LANGUAGE plpgsql VOLATILE SET search_path = public AS $$
DECLARE
  current_row public.personal_agent_registry%ROWTYPE;
  reservation jsonb;
  snapshot jsonb;
  restored public.personal_agent_registry%ROWTYPE;
BEGIN
  IF current_setting('transaction_isolation') NOT IN ('read committed','read uncommitted') THEN RETURN false; END IF;
  IF owner_id IS NULL OR btrim(owner_id) = ''
     OR attempt_id IS NULL OR attempt_id !~ '^[a-f0-9]{32}$'
     OR snapshot_sha256 IS NULL OR snapshot_sha256 !~ '^[a-f0-9]{64}$'
     OR jsonb_typeof(evidence) IS DISTINCT FROM 'object'
     OR evidence - ARRAY['project','service','url','observedAt'] <> '{}'::jsonb
     OR length(evidence->>'project') = 0 OR length(evidence->>'service') = 0 THEN
    RETURN false;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(owner_id, 171));
  PERFORM pg_advisory_xact_lock(hashtextextended(owner_id, 198));
  SELECT * INTO current_row
  FROM public.personal_agent_registry
  WHERE user_id = owner_id
  FOR UPDATE;
  IF NOT FOUND OR current_row.status IS DISTINCT FROM 'suspended' THEN RETURN false; END IF;

  reservation := current_row.backend_metadata->'erasure';
  IF EXISTS(SELECT 1 FROM public.personal_agent_cloud_removals c
   WHERE c.user_id=owner_id AND c.attempt_id=reservation->>'attemptId') THEN RETURN false; END IF;
  snapshot := reservation->'registrySnapshot';
  IF reservation IS NULL
     OR reservation - ARRAY['version','ownerId','attemptId','hushhId','phase','registrySnapshot'] <> '{}'::jsonb
     OR reservation->>'ownerId' IS DISTINCT FROM owner_id
     OR reservation->>'attemptId' IS DISTINCT FROM attempt_id
     OR reservation->>'phase' IS DISTINCT FROM 'reserved'
     OR snapshot->>'status' IS DISTINCT FROM 'provisioned'
     OR jsonb_typeof(snapshot->'backend_metadata') IS DISTINCT FROM 'object'
     OR snapshot->'backend_metadata' ? 'erasure'
     OR encode(sha256(convert_to(snapshot::text, 'UTF8')), 'hex') IS DISTINCT FROM snapshot_sha256
     OR evidence->>'project' IS DISTINCT FROM coalesce(snapshot->>'user_cloud_project', snapshot->'backend_metadata'->>'project')
     OR evidence->>'service' IS DISTINCT FROM coalesce(snapshot->>'external_agent_id', snapshot->'backend_metadata'->>'service')
     OR (snapshot->'backend_metadata'->>'url' IS NOT NULL
         AND evidence->>'url' IS DISTINCT FROM snapshot->'backend_metadata'->>'url') THEN
    RETURN false;
  END IF;
  -- A deletion tombstone or account-erasure tombstone always wins. This function
  -- cannot resurrect an identity that the erasure workflow has completed or begun.
  IF EXISTS (
    SELECT 1 FROM public.personal_agent_deletion_tombstones
    WHERE hushh_id = current_row.hushh_id
  ) OR EXISTS (
    SELECT 1 FROM public.account_deletion_tombstones
    WHERE user_id_hash = 'sha256:' || encode(sha256(convert_to(owner_id, 'UTF8')), 'hex')
  ) OR NOT EXISTS (
    SELECT 1 FROM public.byoc_setup_jobs
    WHERE user_id = owner_id AND status = 'recorded' AND authorization_attempts = '{}'::jsonb
  ) THEN
    RETURN false;
  END IF;

  restored := jsonb_populate_record(NULL::public.personal_agent_registry, snapshot);
  PERFORM set_config('hussh.erasure_restore_attempt', attempt_id, true);
  UPDATE public.personal_agent_registry SET
    hushh_id = restored.hushh_id,
    phone_e164_hash = restored.phone_e164_hash,
    space_id = restored.space_id,
    backend = restored.backend,
    external_agent_id = restored.external_agent_id,
    a2a_route = restored.a2a_route,
    backend_metadata = restored.backend_metadata,
    attestation_ref = restored.attestation_ref,
    pod_pubkey = restored.pod_pubkey,
    pod_key_id = restored.pod_key_id,
    pod_key_wrapping_alg = restored.pod_key_wrapping_alg,
    runtime_version = restored.runtime_version,
    prompt_version = restored.prompt_version,
    status = restored.status,
    region = restored.region,
    provisioned_at = restored.provisioned_at,
    created_at = restored.created_at,
    last_heartbeat_at = restored.last_heartbeat_at,
    health_state = restored.health_state,
    liveness_mode = restored.liveness_mode,
    last_probe_at = restored.last_probe_at,
    liveness_failures = restored.liveness_failures,
    last_healed_at = restored.last_healed_at,
    deployment_target = restored.deployment_target,
    model_credential_mode = restored.model_credential_mode,
    user_cloud_project = restored.user_cloud_project,
    user_cloud_region = restored.user_cloud_region,
    user_cloud_bootstrap_sa = restored.user_cloud_bootstrap_sa,
    user_cloud_authorized_at = restored.user_cloud_authorized_at,
    billing_space_id = restored.billing_space_id,
    updated_at = clock_timestamp()
  WHERE user_id = owner_id;
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.cancel_personal_agent_cloud_removal(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.begin_personal_agent_cloud_removal(text,text,text) FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  GRANT EXECUTE ON FUNCTION public.cancel_personal_agent_cloud_removal(text,text) TO service_role;
  GRANT EXECUTE ON FUNCTION public.begin_personal_agent_cloud_removal(text,text,text) TO service_role;
 END IF;
END $$;
COMMIT;
