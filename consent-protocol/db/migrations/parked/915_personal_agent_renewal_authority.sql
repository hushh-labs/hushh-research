-- Dev-only: serialize personal-agent renewals with revocation in the existing
-- consent ledger. No token, memory or lifecycle authority is stored elsewhere.
BEGIN;

CREATE OR REPLACE FUNCTION public.guard_personal_agent_renewal()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  prior public.consent_audit%ROWTYPE;
  details jsonb;
  automatic boolean;
BEGIN
  IF NEW.agent_id <> 'personal_agent' OR
     NEW.action NOT IN ('CONSENT_GRANTED', 'REVOKED', 'CONSENT_DENIED') THEN
    RETURN NEW;
  END IF;

  -- Account identity triggers run first (their names precede zz_). The
  -- per-grant lock follows those existing shared owner lifecycle barriers.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    jsonb_build_array(NEW.user_id, NEW.agent_id, NEW.scope)::text, 315));
  SELECT * INTO prior FROM public.consent_audit
    WHERE user_id = NEW.user_id AND agent_id = NEW.agent_id AND scope = NEW.scope
      AND action IN ('CONSENT_GRANTED', 'REVOKED', 'CONSENT_DENIED')
    ORDER BY issued_at DESC, id DESC LIMIT 1;
  details := coalesce(NEW.metadata::jsonb, '{}'::jsonb);
  automatic := details->>'automatic_renewal' = 'true'
    OR details->>'grant_kind' LIKE 'personal_agent_%';

  -- A stale expiry worker must not revoke a replacement or overwrite an
  -- owner's explicit revocation with an automatically renewable expiry event.
  IF NEW.action = 'REVOKED' AND details->>'reason' = 'expired'
     AND details->>'source' = 'consent_revocation_worker' THEN
    IF prior.action IS DISTINCT FROM 'CONSENT_GRANTED'
       OR prior.token_id IS DISTINCT FROM NEW.token_id
       OR prior.expires_at IS NULL
       OR prior.expires_at > floor(extract(epoch FROM clock_timestamp()) * 1000) THEN
      RAISE EXCEPTION 'personal agent expiry superseded' USING ERRCODE = '40001';
    END IF;
  END IF;

  IF NEW.action = 'CONSENT_GRANTED' AND automatic AND
     prior.action IN ('REVOKED', 'CONSENT_DENIED') AND NOT (
       prior.action = 'REVOKED'
       AND coalesce(prior.metadata::jsonb->>'reason', '') = 'expired'
       AND coalesce(prior.metadata::jsonb->>'source', '') = 'consent_revocation_worker'
       AND prior.expires_at IS NOT NULL
       AND prior.expires_at <= floor(extract(epoch FROM clock_timestamp()) * 1000)
     ) THEN
    RAISE EXCEPTION 'personal agent consent requires owner reapproval' USING ERRCODE = '42501';
  END IF;

  -- Validators order by issued_at. Preserve commit order even when requests
  -- were timestamped before waiting, or arrived in the same millisecond.
  IF prior.issued_at IS NOT NULL THEN
    NEW.issued_at := greatest(NEW.issued_at, prior.issued_at + 1);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS zz_personal_agent_renewal_authority ON public.consent_audit;
CREATE TRIGGER zz_personal_agent_renewal_authority
BEFORE INSERT ON public.consent_audit
FOR EACH ROW EXECUTE FUNCTION public.guard_personal_agent_renewal();

-- The production adapter calls this entrypoint for automatic grants. An old
-- database without this migration refuses issuance instead of silently omitting
-- the concurrency guard. SECURITY INVOKER retains the caller's ordinary rights.
CREATE OR REPLACE FUNCTION public.insert_personal_agent_renewal(event jsonb)
RETURNS SETOF public.consent_audit LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  incoming public.consent_audit%ROWTYPE;
BEGIN
  incoming := jsonb_populate_record(NULL::public.consent_audit,
    event || jsonb_build_object('metadata', (event->>'metadata')::jsonb));
  IF incoming.agent_id IS DISTINCT FROM 'personal_agent'
     OR incoming.action IS DISTINCT FROM 'CONSENT_GRANTED'
     OR incoming.metadata::jsonb->>'automatic_renewal' IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'invalid personal agent renewal' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.consent_audit'::regclass
      AND tgname = 'zz_personal_agent_renewal_authority'
      AND tgenabled IN ('O', 'A')
      AND tgtype = 7 AND tgnargs = 0 AND tgqual IS NULL
      AND tgfoid = 'public.guard_personal_agent_renewal()'::regprocedure
  ) THEN
    RAISE EXCEPTION 'personal agent renewal authority unavailable' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY INSERT INTO public.consent_audit (
    token_id, user_id, agent_id, scope, action, issued_at, expires_at,
    request_id, scope_description, poll_timeout_at, metadata
  ) VALUES (
    incoming.token_id, incoming.user_id, incoming.agent_id, incoming.scope,
    incoming.action, incoming.issued_at, incoming.expires_at, incoming.request_id,
    incoming.scope_description, incoming.poll_timeout_at, incoming.metadata
  ) RETURNING *;
END;
$$;

COMMIT;
