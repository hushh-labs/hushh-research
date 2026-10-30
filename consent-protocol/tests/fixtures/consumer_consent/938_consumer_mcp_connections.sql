-- Private consumer lane only. Canonical consent_audit owns grants; this table
-- binds an assistant across short-lived OAuth sessions and retains generations.
BEGIN;
CREATE TABLE IF NOT EXISTS public.consumer_mcp_connections (
  connection_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  app_id TEXT NOT NULL REFERENCES public.developer_apps(app_id) ON DELETE CASCADE,
  client_id TEXT NOT NULL REFERENCES public.developer_oauth_clients(client_id) ON DELETE CASCADE,
  environment TEXT NOT NULL,
  resource TEXT NOT NULL,
  deployment_id TEXT NOT NULL,
  generation BIGINT NOT NULL DEFAULT 1 CHECK (generation > 0),
  authorization_floor_id BIGINT NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  UNIQUE (user_id, client_id, environment, resource),
  CHECK (connection_id ~ '^cmc_[a-f0-9]{32}$')
);
ALTER TABLE public.developer_oauth_authorizations
  ADD COLUMN IF NOT EXISTS consumer_connection_id TEXT
    REFERENCES public.consumer_mcp_connections(connection_id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS consumer_generation BIGINT;
DO $$ BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_constraint
  WHERE conrelid='public.developer_oauth_authorizations'::regclass
    AND conname='consumer_oauth_binding_pair') THEN
ALTER TABLE public.developer_oauth_authorizations ADD CONSTRAINT consumer_oauth_binding_pair CHECK (
    (consumer_connection_id IS NULL AND consumer_generation IS NULL) OR
    (consumer_connection_id IS NOT NULL AND consumer_generation IS NOT NULL
      AND consumer_generation > 0)
  );
END IF;
END $$;
CREATE INDEX IF NOT EXISTS consumer_mcp_oauth_binding_idx
  ON public.developer_oauth_authorizations(consumer_connection_id, consumer_generation);

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
     OR NEW.action NOT IN ('CONSENT_GRANTED', 'REVOKED', 'CONSENT_DENIED') THEN
    RAISE EXCEPTION 'invalid consumer consent identity' USING ERRCODE = '42501';
  END IF;
  -- Follow the existing account-deletion order before taking a connection lock.
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
      AND action IN ('CONSENT_GRANTED', 'REVOKED', 'CONSENT_DENIED')
    ORDER BY issued_at DESC, id DESC LIMIT 1;
  IF NEW.action = 'CONSENT_GRANTED' THEN
    IF prior.id IS NOT NULL OR NEW.expires_at IS NOT NULL THEN
      RAISE EXCEPTION 'consumer consent requires a new reviewed generation'
        USING ERRCODE = '42501';
    END IF;
  ELSE
    -- Standing grants do not expire. A token expiry worker cannot disconnect
    -- the assistant merely because one short-lived runtime credential expired.
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
DROP TRIGGER IF EXISTS zz_consumer_memory_consent ON public.consent_audit;
CREATE TRIGGER zz_consumer_memory_consent
BEFORE INSERT ON public.consent_audit
FOR EACH ROW EXECUTE FUNCTION public.guard_consumer_memory_consent();

-- Generic audit cleanup cannot erase the decisions used to fence credentials.
CREATE OR REPLACE FUNCTION public.preserve_consumer_memory_consent()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.scope = 'cap.consumer.memory' OR
     (TG_OP = 'UPDATE' AND NEW.scope = 'cap.consumer.memory') THEN
    -- Full account erasure records this existing irreversible tombstone first.
    IF TG_OP = 'DELETE' AND EXISTS (
      SELECT 1 FROM public.account_deletion_tombstones
      WHERE user_id_hash = 'sha256:' || encode(sha256(convert_to(OLD.user_id, 'UTF8')), 'hex')
    ) THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'consumer consent decisions are append only' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS zz_preserve_consumer_memory_consent ON public.consent_audit;
CREATE TRIGGER zz_preserve_consumer_memory_consent
BEFORE UPDATE OR DELETE ON public.consent_audit
FOR EACH ROW EXECUTE FUNCTION public.preserve_consumer_memory_consent();
COMMIT;
