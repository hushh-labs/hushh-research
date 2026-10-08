-- Dev-only: let the signed-request key pull run while an attach is unfinished.
-- Replaces only the 917 provision guard trigger function (same oid, so the claim's
-- trigger-identity check still holds). A pod that signs its requests instead of
-- presenting a Google token (every Azure agent) is unknown to the hub until its key
-- is pulled, and the verifier throttles that pull by stamping
-- backend_metadata.signingKeyPull. 917's guard admitted only heartbeat observations
-- on a row whose provision attempt is still `connecting`, so the stamp was refused,
-- the pull never ran and the first live Azure agent stayed at `connecting`, its
-- every heartbeat 401 (2026-10-05). Admit that one numeric key alongside
-- `observed`; every other column and metadata key still must not move.
BEGIN;
CREATE OR REPLACE FUNCTION public.guard_personal_agent_provision_registry()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  -- The later erasure trigger owns all mutations after reservation.
  IF OLD.backend_metadata ? 'erasure' THEN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF OLD.backend_metadata ? 'provisionAttempt'
     AND OLD.backend_metadata->'provisionAttempt'->>'phase' IS DISTINCT FROM 'provisioned' THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'personal agent provision retained' USING ERRCODE='42501';
    END IF;
    -- Existing erasure admission may capture the attempt, never discard it.
    IF NOT (OLD.backend_metadata ? 'erasure')
       AND NEW.status = 'suspended'
       AND NEW.backend_metadata->'erasure'->'registrySnapshot' = to_jsonb(OLD)
       AND NEW.backend_metadata - 'erasure' = OLD.backend_metadata
       AND to_jsonb(NEW) - ARRAY['status','updated_at','backend_metadata'] =
           to_jsonb(OLD) - ARRAY['status','updated_at','backend_metadata'] THEN
      RETURN NEW;
    END IF;
    -- The publication function sets this transaction-local coordination token.
    -- It is an accidental-writer guard, not authentication against database admins.
    IF current_setting('hussh.provision_attempt', true) =
       OLD.backend_metadata->'provisionAttempt'->>'attemptId'
       AND NEW.backend_metadata->'provisionAttempt'->>'attemptId' =
           OLD.backend_metadata->'provisionAttempt'->>'attemptId' THEN
      RETURN NEW;
    END IF;
    -- Pod heartbeat observations do not own lifecycle or resource coordinates.
    -- Nor does the signed-request key-pull throttle stamp (pod_request_verifier):
    -- on a pod with no Google token it is the only way its key is ever pulled.
    IF to_jsonb(NEW) - ARRAY['last_heartbeat_at','health_state','liveness_failures','backend_metadata'] =
       to_jsonb(OLD) - ARRAY['last_heartbeat_at','health_state','liveness_failures','backend_metadata']
       AND NEW.backend_metadata - ARRAY['observed','signingKeyPull']
           = OLD.backend_metadata - ARRAY['observed','signingKeyPull']
       AND (NOT (NEW.backend_metadata ? 'signingKeyPull')
            OR jsonb_typeof(NEW.backend_metadata->'signingKeyPull') = 'number') THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'personal agent provision retained' USING ERRCODE='42501';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
COMMIT;
