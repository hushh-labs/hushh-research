-- One owner-reviewed, encrypted curated OAuth status source. The table has no
-- key material, owner token, runtime-wrapped DEK, or worker checkpoint.
BEGIN;

ALTER TABLE public.live_memory_hosted_pilot_grants
  ADD COLUMN IF NOT EXISTS source_id TEXT;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.live_memory_hosted_pilot_grants'::regclass
      AND conname = 'live_memory_hosted_pilot_source_id_shape'
  ) THEN
    ALTER TABLE public.live_memory_hosted_pilot_grants
      ADD CONSTRAINT live_memory_hosted_pilot_source_id_shape
      CHECK (source_id IS NULL OR source_id ~ '^[a-z0-9_][a-z0-9_.:-]{0,127}$');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.live_memory_hosted_source_envelopes (
  user_id TEXT PRIMARY KEY REFERENCES public.live_memory_hosted_pilot_grants(user_id)
    ON DELETE CASCADE,
  grant_id UUID NOT NULL,
  grant_generation BIGINT NOT NULL CHECK (grant_generation > 0),
  source_id TEXT NOT NULL CHECK (source_id ~ '^[a-z0-9_][a-z0-9_.:-]{0,127}$'),
  scope_code TEXT NOT NULL CHECK (scope_code = 'connector_status.v1'),
  envelope_version TEXT NOT NULL CHECK (envelope_version = 'aes256gcm.pilot.v1'),
  key_id UUID NOT NULL,
  owner_revision BIGINT NOT NULL CHECK (owner_revision > 0),
  owner_nonce BYTEA NOT NULL CHECK (octet_length(owner_nonce) = 12),
  owner_ciphertext BYTEA NOT NULL
    CHECK (octet_length(owner_ciphertext) BETWEEN 17 AND 16384),
  owner_ciphertext_sha256 BYTEA NOT NULL
    CHECK (octet_length(owner_ciphertext_sha256) = 32),
  owner_aad_sha256 BYTEA NOT NULL CHECK (octet_length(owner_aad_sha256) = 32),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

COMMENT ON TABLE public.live_memory_hosted_source_envelopes IS
  'One scoped, owner-encrypted source envelope. No canonical vault key, owner token, wrapped DEK, plaintext source record, worker lease, or checkpoint.';

ALTER TABLE public.live_memory_hosted_source_envelopes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.live_memory_hosted_source_envelopes FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON public.live_memory_hosted_source_envelopes TO service_role;
  END IF;
END $$;

-- A grant re-review, source switch, or revocation destroys old encrypted state
-- in the same transaction, even with older app code.
CREATE OR REPLACE FUNCTION public.erase_hosted_source_envelope_on_grant_change()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD.grant_id IS DISTINCT FROM NEW.grant_id
     OR OLD.generation IS DISTINCT FROM NEW.generation
     OR OLD.source_id IS DISTINCT FROM NEW.source_id
     OR NEW.status = 'revoked' THEN
    DELETE FROM public.live_memory_hosted_source_envelopes
    WHERE user_id = NEW.user_id;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.erase_hosted_source_envelope_on_grant_change() FROM PUBLIC;

DO $$
DECLARE
  v_trigger RECORD;
  v_expected_attrs TEXT[];
  v_actual_attrs TEXT[];
BEGIN
  SELECT tgfoid, tgtype, tgenabled, tgqual, tgnargs, tgattr,
         tgconstraint, tgoldtable, tgnewtable
    INTO v_trigger FROM pg_trigger
    WHERE tgname = 'erase_hosted_source_envelope_on_grant_change'
      AND tgrelid = 'public.live_memory_hosted_pilot_grants'::regclass
      AND NOT tgisinternal;
  IF NOT FOUND THEN
    CREATE TRIGGER erase_hosted_source_envelope_on_grant_change
      AFTER UPDATE OF grant_id, generation, source_id, status
      ON public.live_memory_hosted_pilot_grants FOR EACH ROW
      EXECUTE FUNCTION public.erase_hosted_source_envelope_on_grant_change();
  ELSE
    SELECT array_agg(attnum::TEXT ORDER BY attnum::TEXT) INTO v_expected_attrs
    FROM pg_attribute
    WHERE attrelid = 'public.live_memory_hosted_pilot_grants'::regclass
      AND attname IN ('grant_id', 'generation', 'source_id', 'status')
      AND NOT attisdropped;
    SELECT array_agg(attr ORDER BY attr) INTO v_actual_attrs
    FROM unnest(string_to_array(v_trigger.tgattr::TEXT, ' ')) AS attrs(attr);
    IF v_expected_attrs IS NULL OR cardinality(v_expected_attrs) <> 4
       OR v_trigger.tgfoid <>
            'public.erase_hosted_source_envelope_on_grant_change()'::regprocedure::OID
       OR v_trigger.tgtype <> 17 OR v_trigger.tgenabled <> 'O'
       OR v_trigger.tgqual IS NOT NULL OR v_trigger.tgnargs <> 0
       OR v_trigger.tgconstraint <> 0
       OR v_trigger.tgoldtable IS NOT NULL OR v_trigger.tgnewtable IS NOT NULL
       OR v_actual_attrs IS DISTINCT FROM v_expected_attrs THEN
      RAISE EXCEPTION 'Hosted source erasure trigger has unexpected definition';
    END IF;
  END IF;
END $$;

DO $$
BEGIN
  IF to_regprocedure('public.install_account_deletion_write_guards()') IS NOT NULL THEN
    PERFORM public.install_account_deletion_write_guards();
  END IF;
END $$;
COMMIT;
