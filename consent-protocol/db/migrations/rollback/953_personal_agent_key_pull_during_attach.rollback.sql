-- Roll back 953: restore 917's guard, which refuses the signed-request key-pull
-- stamp while an attach is unfinished. No row changes; an agent that only signs
-- its requests then stays at `connecting` until 953 is re-applied.
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
    IF to_jsonb(NEW) - ARRAY['last_heartbeat_at','health_state','liveness_failures','backend_metadata'] =
       to_jsonb(OLD) - ARRAY['last_heartbeat_at','health_state','liveness_failures','backend_metadata']
       AND NEW.backend_metadata - 'observed' = OLD.backend_metadata - 'observed' THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'personal agent provision retained' USING ERRCODE='42501';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
COMMIT;
