"""Reviewed schema-only adoption fixtures; no owner rows or runtime authority."""

RECEIPT_PREDECESSORS = (
    (
        "904_consent_audit_receipts.sql",
        "3dd91a54968b624471548ec97e90d18f254a86ced3b9d459501fc2fccc79fdaf",
    ),
)

# Reviewed schema-only definitions from the legacy Dev catalog. No owner rows.
LEGACY_FUNCTIONS = r"""CREATE OR REPLACE FUNCTION public.guard_consumer_memory_consent()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.preserve_consumer_memory_consent()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
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
$function$;
"""
LEGACY_TRIGGERS = r"""CREATE TRIGGER zz_consumer_memory_consent BEFORE INSERT ON consent_audit FOR EACH ROW EXECUTE FUNCTION guard_consumer_memory_consent();
CREATE TRIGGER zz_preserve_consumer_memory_consent BEFORE DELETE OR UPDATE ON consent_audit FOR EACH ROW EXECUTE FUNCTION preserve_consumer_memory_consent();"""

# Authored906/907 registry definitions; actual904 supplies the pre-ledger receipt schema.
LEGACY_PREDECESSOR_SCHEMA = """
ALTER TABLE public.personal_agent_registry
 DROP CONSTRAINT IF EXISTS personal_agent_registry_deployment_target_check,
 DROP CONSTRAINT IF EXISTS personal_agent_registry_model_credential_mode_check,
 DROP CONSTRAINT IF EXISTS personal_agent_registry_status_check,
 ADD CONSTRAINT personal_agent_registry_deployment_target_check
  CHECK(deployment_target IS NULL OR deployment_target IN ('gcp','user_gcp','anypoint','null')),
 ADD CONSTRAINT personal_agent_registry_model_credential_mode_check
  CHECK(model_credential_mode IS NULL OR model_credential_mode IN ('user_adc','byok_per_turn','fleet_adc')),
 ADD CONSTRAINT personal_agent_registry_status_check
  CHECK(status IN ('unprovisioned','pending','provisioning','connecting','provisioned','provisioning_failed','reaped'));
"""
LEGACY_PREDECESSOR_DRIFT = (
    (
        "ALTER TABLE public.consent_audit_receipts ADD COLUMN ledger text",
        "column",
    ),
    (
        "ALTER TABLE public.personal_agent_registry DROP CONSTRAINT IF EXISTS personal_agent_registry_status_check; ALTER TABLE public.personal_agent_registry ADD CONSTRAINT personal_agent_registry_status_check CHECK(status IS NOT NULL) NOT VALID",
        "predecessor",
    ),
    (
        "ALTER TABLE public.consent_audit_receipts DROP CONSTRAINT consent_audit_receipts_subject_id_hash_key; ALTER TABLE public.consent_audit_receipts ADD CONSTRAINT consent_audit_receipts_subject_id_hash_key UNIQUE(hash,subject_id)",
        "receipt",
    ),
    (
        "ALTER TABLE public.consent_audit_receipts DROP CONSTRAINT consent_audit_receipts_subject_id_seq_key",
        "receipt",
    ),
    (
        "DROP INDEX public.idx_consent_audit_receipts_subject; CREATE INDEX idx_consent_audit_receipts_subject ON public.consent_audit_receipts(subject_id,seq)",
        "receipt",
    ),
    (
        "DROP INDEX public.idx_consent_audit_receipts_subject",
        "receipt",
    ),
    (
        "INSERT INTO public.personal_agent_registry(user_id,hushh_id,deployment_target) VALUES('synthetic-anypoint','synthetic-anypoint','anypoint')",
        "anypoint",
    ),
)


LEGACY_GUARD_MUTATIONS = (
    (
        "CREATE TRIGGER zz_unreviewed_consumer_memory BEFORE INSERT ON public.consent_audit FOR EACH ROW EXECUTE FUNCTION public.guard_consumer_memory_consent()",
        "DROP TRIGGER zz_unreviewed_consumer_memory ON public.consent_audit",
    ),
    (
        "ALTER TABLE public.consent_audit DISABLE TRIGGER zz_consumer_memory_consent",
        "ALTER TABLE public.consent_audit ENABLE TRIGGER zz_consumer_memory_consent",
    ),
    (
        "DROP TRIGGER zz_preserve_consumer_memory_consent ON public.consent_audit",
        LEGACY_TRIGGERS.split(";\n", 1)[1],
    ),
    (
        "DROP TRIGGER zz_consumer_memory_consent ON public.consent_audit; DROP TRIGGER zz_preserve_consumer_memory_consent ON public.consent_audit",
        LEGACY_TRIGGERS,
    ),
    (
        "DROP TRIGGER zz_consumer_memory_consent ON public.consent_audit; CREATE TRIGGER zz_consumer_memory_consent AFTER INSERT ON public.consent_audit FOR EACH ROW EXECUTE FUNCTION public.guard_consumer_memory_consent()",
        "DROP TRIGGER zz_consumer_memory_consent ON public.consent_audit; "
        + LEGACY_TRIGGERS.split(";\n", 1)[0],
    ),
    (
        "DROP TRIGGER zz_consumer_memory_consent ON public.consent_audit; CREATE TRIGGER zz_consumer_memory_consent BEFORE INSERT ON public.consent_audit FOR EACH ROW EXECUTE FUNCTION public.guard_consumer_memory_consent('extra')",
        "DROP TRIGGER zz_consumer_memory_consent ON public.consent_audit; "
        + LEGACY_TRIGGERS.split(";\n", 1)[0],
    ),
    (
        "DROP TRIGGER zz_consumer_memory_consent ON public.consent_audit; CREATE TRIGGER zz_consumer_memory_consent BEFORE INSERT ON public.consent_audit FOR EACH ROW WHEN(NEW.scope IS NOT NULL) EXECUTE FUNCTION public.guard_consumer_memory_consent()",
        "DROP TRIGGER zz_consumer_memory_consent ON public.consent_audit; "
        + LEGACY_TRIGGERS.split(";\n", 1)[0],
    ),
    (
        "CREATE OR REPLACE FUNCTION public.guard_consumer_memory_consent() RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$ BEGIN RETURN NEW; END; $$",
        LEGACY_FUNCTIONS,
    ),
    (
        "ALTER FUNCTION public.guard_consumer_memory_consent() SECURITY DEFINER",
        "ALTER FUNCTION public.guard_consumer_memory_consent() SECURITY INVOKER",
    ),
    (
        "CREATE FUNCTION public.guard_consumer_memory_consent(integer) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$",
        "DROP FUNCTION public.guard_consumer_memory_consent(integer)",
    ),
)
