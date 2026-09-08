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

CREATE OR REPLACE FUNCTION public.guard_personal_agent_erasure_registry()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF OLD.backend_metadata ? 'erasure' THEN
    -- Freeze custody/resource coordinates and all ordinary writers. Later
    -- erasure phase transitions need their own exact-attempt checked operation.
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
COMMIT;
