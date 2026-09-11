-- Dev-only consumer MCP runtime credentials.
-- A standing memory grant remains durable until disconnect; each short-lived
-- bearer token is an append-only event under that same connection generation.
BEGIN;

CREATE OR REPLACE FUNCTION public.guard_consumer_memory_consent()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  binding public.consumer_mcp_connections%ROWTYPE;
  prior public.consent_audit%ROWTYPE;
  ref TEXT;
  requested_generation BIGINT;
BEGIN
  IF NEW.scope IS DISTINCT FROM 'cap.consumer.memory' THEN RETURN NEW; END IF;
  IF NEW.agent_id IS NULL OR NEW.action IS NULL
     OR NEW.agent_id !~ '^consumer_mcp:cmc_[a-f0-9]{32}:[1-9][0-9]*$'
     OR NEW.action NOT IN (
       'CONSENT_GRANTED', 'CONSUMER_TOKEN_ISSUED', 'REVOKED', 'CONSENT_DENIED'
     ) THEN
    RAISE EXCEPTION 'invalid consumer consent identity' USING ERRCODE = '42501';
  END IF;

  PERFORM pg_advisory_xact_lock_shared(hashtextextended(NEW.user_id, 171));
  PERFORM pg_advisory_xact_lock_shared(hashtextextended(NEW.user_id, 198));
  ref := split_part(NEW.agent_id, ':', 2);
  requested_generation := split_part(NEW.agent_id, ':', 3)::bigint;
  SELECT * INTO binding FROM public.consumer_mcp_connections
    WHERE connection_id = ref AND user_id = NEW.user_id FOR UPDATE;
  IF NOT FOUND OR binding.generation <> requested_generation THEN
    RAISE EXCEPTION 'consumer connection changed' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO prior FROM public.consent_audit
    WHERE user_id = NEW.user_id AND agent_id = NEW.agent_id AND scope = NEW.scope
      AND action IN (
        'CONSENT_GRANTED', 'CONSUMER_TOKEN_ISSUED', 'REVOKED', 'CONSENT_DENIED'
      )
    ORDER BY issued_at DESC, id DESC LIMIT 1;

  IF NEW.action = 'CONSENT_GRANTED' THEN
    IF prior.id IS NOT NULL OR NEW.expires_at IS NOT NULL THEN
      RAISE EXCEPTION 'consumer consent requires a new reviewed generation'
        USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.action = 'CONSUMER_TOKEN_ISSUED' THEN
    IF prior.id IS NULL OR prior.action NOT IN ('CONSENT_GRANTED', 'CONSUMER_TOKEN_ISSUED')
       OR NEW.expires_at IS NULL OR NEW.expires_at <= NEW.issued_at
       OR NEW.token_id IS NULL OR NEW.token_id NOT LIKE 'HCT:%' THEN
      RAISE EXCEPTION 'consumer runtime credential requires standing consent'
        USING ERRCODE = '42501';
    END IF;
  ELSE
    -- Standing grants do not expire. A token expiry worker cannot disconnect
    -- the assistant merely because one runtime credential expired.
    IF NEW.metadata::jsonb->>'reason' = 'expired' THEN
      RAISE EXCEPTION 'consumer standing consent does not expire' USING ERRCODE = '42501';
    END IF;
    UPDATE public.consumer_mcp_connections SET generation = generation + 1,
      authorization_floor_id = (SELECT last_value FROM public.developer_oauth_authorizations_id_seq)
      WHERE connection_id = ref;
    UPDATE public.developer_oauth_authorizations SET status = 'denied'
      WHERE consumer_connection_id = ref AND consumer_generation = requested_generation;
    UPDATE public.developer_oauth_tokens SET revoked_at =
      floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint
      WHERE authorization_id IN (SELECT id FROM public.developer_oauth_authorizations
        WHERE consumer_connection_id = ref AND consumer_generation = requested_generation)
      AND revoked_at IS NULL;
  END IF;
  NEW.issued_at := greatest(NEW.issued_at, coalesce(prior.issued_at + 1, 0));
  RETURN NEW;
END;
$$;

COMMIT;
