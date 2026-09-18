-- Dev-only: retain private-pod erasure admission in the existing registry.
-- Reservation is not a cleanup receipt and never authorizes account deletion.
BEGIN;
ALTER TABLE personal_agent_registry DROP CONSTRAINT IF EXISTS personal_agent_registry_status_check;
ALTER TABLE personal_agent_registry ADD CONSTRAINT personal_agent_registry_status_check
CHECK (status IN (
  'unprovisioned', 'pending', 'provisioning', 'connecting', 'provisioned',
  'provisioning_failed', 'needs_reinit', 'migrating', 'reaped', 'suspended'
)) NOT VALID;
ALTER TABLE personal_agent_registry VALIDATE CONSTRAINT personal_agent_registry_status_check;

CREATE OR REPLACE FUNCTION public.valid_erasure_upgrade_ack(reservation jsonb, receipt jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT coalesce(
    jsonb_typeof(receipt) = 'object' AND octet_length(receipt::text) <= 16384
    AND receipt->>'version' = '1'
    AND jsonb_typeof(receipt->'generation') = 'number'
    AND receipt->>'generation' ~ '^[1-9][0-9]*$'
    AND receipt->>'attemptId' = encode(sha256(convert_to(
        reservation->'registrySnapshot'->'backend_metadata'->>'upgradeLease', 'UTF8')), 'hex')
    AND length(receipt->>'serviceUid') > 0 AND length(receipt->>'service') > 0
    AND receipt->>'serviceUid' = reservation->'registrySnapshot'->'backend_metadata'->>'serviceUid'
    AND receipt->>'service' = coalesce(
        reservation->'registrySnapshot'->'backend_metadata'->>'service',
        reservation->'registrySnapshot'->>'external_agent_id')
    AND length(receipt->>'image') > 0 AND length(receipt->>'targetImage') > 0
    AND right(reservation->'registrySnapshot'->'backend_metadata'->>'upgradeLease',
        length(receipt->>'targetImage') + 1) = '|' || (receipt->>'targetImage'),
    false
  );
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
    RAISE EXCEPTION 'personal agent erasure reserved' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS zz_personal_agent_erasure_registry ON public.personal_agent_registry;
CREATE TRIGGER zz_personal_agent_erasure_registry
BEFORE UPDATE OR DELETE ON public.personal_agent_registry
FOR EACH ROW EXECUTE FUNCTION public.guard_personal_agent_erasure_registry();

CREATE OR REPLACE FUNCTION public.guard_personal_agent_erasure_grant()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  -- Existing account guard takes shared owner locks before this trigger. The
  -- reservation takes those locks exclusively, in the same 171 -> 198 order.
  IF NEW.agent_id = 'personal_agent' AND NEW.action = 'CONSENT_GRANTED' AND EXISTS (
    SELECT 1 FROM public.personal_agent_registry
    WHERE user_id = NEW.user_id AND backend_metadata ? 'erasure'
  ) THEN
    RAISE EXCEPTION 'personal agent erasure reserved' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS zy_personal_agent_erasure_grant ON public.consent_audit;
CREATE TRIGGER zy_personal_agent_erasure_grant
BEFORE INSERT ON public.consent_audit
FOR EACH ROW EXECUTE FUNCTION public.guard_personal_agent_erasure_grant();

CREATE OR REPLACE FUNCTION public.reserve_personal_agent_erasure(owner_id text, attempt_id text)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  current_row public.personal_agent_registry%ROWTYPE;
  reservation jsonb;
BEGIN
  IF owner_id IS NULL OR btrim(owner_id) = '' OR attempt_id IS NULL OR btrim(attempt_id) = '' THEN
    RAISE EXCEPTION 'invalid personal agent erasure admission' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(owner_id, 171));
  PERFORM pg_advisory_xact_lock(hashtextextended(owner_id, 198));
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_registry'::regclass
      AND tgname='zz_personal_agent_erasure_registry' AND tgenabled IN ('O','A')
      AND tgtype=27 AND tgnargs=0 AND tgqual IS NULL
      AND tgfoid='public.guard_personal_agent_erasure_registry()'::regprocedure
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid='public.consent_audit'::regclass
      AND tgname='zy_personal_agent_erasure_grant' AND tgenabled IN ('O','A')
      AND tgtype=7 AND tgnargs=0 AND tgqual IS NULL
      AND tgfoid='public.guard_personal_agent_erasure_grant()'::regprocedure
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid='public.consent_audit'::regclass
      AND tgname='trg_reject_deleted_account_insert' AND tgenabled IN ('O','A')
      AND tgfoid='public.reject_deleted_account_identity_write()'::regprocedure
  ) THEN
    RAISE EXCEPTION 'personal agent erasure guards unavailable' USING ERRCODE='42501';
  END IF;
  SELECT * INTO current_row FROM public.personal_agent_registry WHERE user_id = owner_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'personal agent erasure registry unavailable' USING ERRCODE = '42501';
  END IF;
  IF current_row.backend_metadata IS NOT NULL AND jsonb_typeof(current_row.backend_metadata) <> 'object' THEN
    RAISE EXCEPTION 'personal agent erasure metadata invalid' USING ERRCODE = '42501';
  END IF;
  IF current_row.backend_metadata ? 'erasure' THEN
    RETURN current_row.backend_metadata->'erasure';
  END IF;
  reservation := jsonb_build_object(
    'version', 1, 'ownerId', owner_id, 'attemptId', attempt_id,
    'hushhId', current_row.hushh_id, 'phase', 'reserved',
    'registrySnapshot', to_jsonb(current_row)
  );
  UPDATE public.personal_agent_registry SET
    backend_metadata = coalesce(backend_metadata, '{}'::jsonb) || jsonb_build_object('erasure', reservation),
    status = 'suspended', updated_at = clock_timestamp()
  WHERE user_id = owner_id;
  RETURN reservation;
END;
$$;
CREATE OR REPLACE FUNCTION public.retain_erasure_upgrade_ack(owner_id text, lease text, receipt jsonb)
RETURNS boolean LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  current_row public.personal_agent_registry%ROWTYPE;
  reservation jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(owner_id, 171));
  PERFORM pg_advisory_xact_lock(hashtextextended(owner_id, 198));
  SELECT * INTO current_row FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
  reservation := current_row.backend_metadata->'erasure';
  IF reservation IS NULL OR lease IS NULL OR
     reservation->'registrySnapshot'->'backend_metadata'->>'upgradeLease' IS DISTINCT FROM lease OR
     NOT public.valid_erasure_upgrade_ack(reservation, receipt) THEN
    RETURN false;
  END IF;
  IF reservation ? 'lateUpgradeAcknowledgement' THEN
    RETURN reservation->'lateUpgradeAcknowledgement' = receipt;
  END IF;
  UPDATE public.personal_agent_registry SET backend_metadata = jsonb_set(
    backend_metadata, '{erasure,lateUpgradeAcknowledgement}', receipt, true
  ) WHERE user_id=owner_id;
  RETURN true;
END;
$$;
COMMIT;
