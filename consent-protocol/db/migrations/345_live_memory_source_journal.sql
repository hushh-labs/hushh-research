-- Transactional, metadata-only change hints for admitted Live Memory sources.
-- The event never contains source values, counterpart IDs, payment IDs or tokens.
-- A reader must fetch the authoritative source after seeing a committed hint.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.live_memory_source_streams (
  owner_hash TEXT PRIMARY KEY CHECK (owner_hash ~ '^sha256:[0-9a-f]{64}$'),
  last_sequence BIGINT NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
  first_retained_sequence BIGINT NOT NULL DEFAULT 1 CHECK (first_retained_sequence >= 1),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (first_retained_sequence - 1 <= last_sequence)
);
CREATE TABLE IF NOT EXISTS public.live_memory_source_events (
  owner_hash TEXT NOT NULL REFERENCES public.live_memory_source_streams(owner_hash) ON DELETE CASCADE,
  sequence BIGINT NOT NULL CHECK (sequence > 0),
  event_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  source_kind TEXT NOT NULL CHECK (source_kind IN
    ('profile','consent','connection','document_earning','payout_activity','document_request_payment')),
  operation TEXT NOT NULL CHECK (operation IN ('changed','deleted')),
  schema_version SMALLINT NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner_hash, sequence)
);
COMMENT ON TABLE public.live_memory_source_events IS
  'Committed owner-scoped kind hints only; source payloads and row IDs are never copied.';
ALTER TABLE public.live_memory_source_streams ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.live_memory_source_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.live_memory_source_streams, public.live_memory_source_events FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.live_memory_source_streams,
      public.live_memory_source_events TO service_role;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.append_live_memory_source_hint(
  p_owner TEXT, p_kind TEXT, p_operation TEXT
) RETURNS VOID
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_hash TEXT;
  v_sequence BIGINT;
  v_floor BIGINT;
BEGIN
  IF p_owner IS NULL OR p_owner = '' THEN RETURN; END IF;
  IF p_kind NOT IN ('profile','consent','connection','document_earning',
                   'payout_activity','document_request_payment') OR
     p_operation NOT IN ('changed','deleted') THEN
    RAISE EXCEPTION 'Invalid live memory source hint';
  END IF;
  v_hash := 'sha256:' || encode(digest(p_owner, 'sha256'), 'hex');
  -- Full deletion records this tombstone before source rows are removed.
  IF EXISTS (SELECT 1 FROM public.account_deletion_tombstones
             WHERE user_id_hash=v_hash) THEN RETURN; END IF;
  -- The row lock serializes sequence allocation with source commits.
  INSERT INTO public.live_memory_source_streams (owner_hash,last_sequence)
  VALUES (v_hash,1)
  ON CONFLICT (owner_hash) DO UPDATE SET
    last_sequence=live_memory_source_streams.last_sequence+1,
    updated_at=clock_timestamp()
  RETURNING last_sequence INTO v_sequence;
  INSERT INTO public.live_memory_source_events
    (owner_hash,sequence,source_kind,operation)
  VALUES (v_hash,v_sequence,p_kind,p_operation);
  v_floor := GREATEST(1,v_sequence-2047);
  UPDATE public.live_memory_source_streams
  SET first_retained_sequence=GREATEST(first_retained_sequence,v_floor)
  WHERE owner_hash=v_hash
  RETURNING first_retained_sequence INTO v_floor;
  DELETE FROM public.live_memory_source_events
  WHERE owner_hash=v_hash AND sequence<v_floor;
END;
$$;
REVOKE ALL ON FUNCTION public.append_live_memory_source_hint(TEXT,TEXT,TEXT) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.capture_live_memory_source_hint()
RETURNS TRIGGER
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_old JSONB;
  v_new JSONB;
  v_row JSONB;
  v_owner TEXT;
  v_kind TEXT;
  v_operation TEXT;
  v_requester TEXT;
  v_document_owner TEXT;
  v_request_id UUID;
BEGIN
  IF TG_OP <> 'INSERT' THEN v_old := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN v_new := to_jsonb(NEW); END IF;
  IF TG_OP = 'UPDATE' AND v_old = v_new THEN RETURN NEW; END IF;
  -- Identity refresh rewrites last_synced_at and updated_at on every forced
  -- read. Only the fields in the owner profile snapshot may wake that read;
  -- otherwise polling the journal would generate another profile hint.
  IF TG_TABLE_NAME='actor_identity_cache' AND TG_OP='UPDATE'
     AND (v_old->>'display_name') IS NOT DISTINCT FROM (v_new->>'display_name')
     AND (v_old->>'email') IS NOT DISTINCT FROM (v_new->>'email')
     AND (v_old->>'photo_url') IS NOT DISTINCT FROM (v_new->>'photo_url')
     AND (v_old->>'custom_photo_url') IS NOT DISTINCT FROM (v_new->>'custom_photo_url')
  THEN RETURN NEW; END IF;
  v_row := CASE WHEN TG_OP='DELETE' THEN v_old ELSE v_new END;
  v_operation := CASE WHEN TG_OP='DELETE' THEN 'deleted' ELSE 'changed' END;

  IF TG_TABLE_NAME = 'drive_request_payment_orders' THEN
    v_requester := v_row->>'requester_user_id';
    v_document_owner := v_row->>'user_id';
    -- Stable owner order prevents cross-payment row-lock inversion.
    FOR v_owner,v_kind IN SELECT owner_id,kind FROM (VALUES
      (v_requester,'document_request_payment'),
      (v_document_owner,'document_earning')
    ) AS hints(owner_id,kind) WHERE owner_id IS NOT NULL
      ORDER BY owner_id,kind LOOP
      PERFORM public.append_live_memory_source_hint(v_owner,v_kind,v_operation);
    END LOOP;
  ELSIF TG_TABLE_NAME IN ('drive_request_payment_refunds','drive_request_owner_payouts') THEN
    v_request_id := (v_row->>'request_id')::UUID;
    SELECT o.requester_user_id,o.user_id INTO v_requester,v_document_owner
    FROM public.drive_request_payment_orders o WHERE o.request_id=v_request_id;
    IF TG_TABLE_NAME='drive_request_payment_refunds' THEN
      FOR v_owner,v_kind IN SELECT owner_id,kind FROM (VALUES
        (v_requester,'document_request_payment'),
        (v_document_owner,'document_earning')
      ) AS hints(owner_id,kind) WHERE owner_id IS NOT NULL
        ORDER BY owner_id,kind LOOP
        PERFORM public.append_live_memory_source_hint(v_owner,v_kind,v_operation);
      END LOOP;
    ELSE
      PERFORM public.append_live_memory_source_hint(
        v_document_owner,'document_earning',v_operation);
    END IF;
  ELSE
    -- The trigger's authored arguments are only owner-column names and kind.
    -- Conversion is local to this transaction; no source row is persisted.
    v_kind := TG_ARGV[0];
    FOR v_owner IN SELECT DISTINCT owner_id FROM unnest(ARRAY[
      v_old->>TG_ARGV[1], v_old->>TG_ARGV[2],
      v_new->>TG_ARGV[1], v_new->>TG_ARGV[2]
    ]) AS owners(owner_id)
    WHERE owner_id IS NOT NULL AND owner_id <> ''
    ORDER BY owner_id LOOP
      PERFORM public.append_live_memory_source_hint(
        v_owner,v_kind,
        CASE WHEN TG_OP='DELETE' OR
          (TG_OP='UPDATE' AND v_owner IS DISTINCT FROM v_new->>TG_ARGV[1]
           AND v_owner IS DISTINCT FROM v_new->>TG_ARGV[2])
        THEN 'deleted' ELSE 'changed' END);
    END LOOP;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.capture_live_memory_source_hint() FROM PUBLIC;

-- Each row trigger is attached at the storage authority, so webhook and worker
-- writes also wake the owner after commit. No browser needs to be open then.
DO $$
DECLARE
  v RECORD;
  v_existing RECORD;
BEGIN
  FOR v IN SELECT * FROM (VALUES
    ('actor_identity_cache','profile','user_id',NULL),
    ('consent_audit','consent','user_id',NULL),
    ('connections','connection','user_a_id','user_b_id'),
    ('connection_requests','connection','requester_user_id','addressee_user_id'),
    ('trusted_connections','connection','owner_user_id',NULL),
    ('drive_request_payment_orders','document_request_payment',NULL,NULL),
    ('drive_request_payment_refunds','document_request_payment',NULL,NULL),
    ('drive_request_owner_payouts','document_earning',NULL,NULL)
  ) AS authored(table_name,kind,owner_col,other_col) LOOP
    SELECT tgfoid,tgtype,tgenabled,tgqual,tgnargs INTO v_existing
    FROM pg_trigger WHERE tgname='live_memory_source_journal'
      AND tgrelid=format('public.%I',v.table_name)::regclass AND NOT tgisinternal;
    IF NOT FOUND THEN
      EXECUTE format(
        'CREATE TRIGGER live_memory_source_journal AFTER INSERT OR UPDATE OR DELETE ON public.%I '
        'FOR EACH ROW EXECUTE FUNCTION public.capture_live_memory_source_hint(%L,%L,%L)',
        v.table_name,v.kind,COALESCE(v.owner_col,''),COALESCE(v.other_col,''));
    ELSIF v_existing.tgfoid <> 'public.capture_live_memory_source_hint()'::regprocedure::OID
       OR v_existing.tgtype <> 29 OR v_existing.tgenabled <> 'O'
       OR v_existing.tgqual IS NOT NULL OR v_existing.tgnargs <> 3 THEN
      RAISE EXCEPTION 'Live Memory source trigger drift on %',v.table_name;
    END IF;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.erase_live_memory_source_journal_on_root_delete()
RETURNS TRIGGER LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
BEGIN
  DELETE FROM public.live_memory_source_streams
  WHERE owner_hash='sha256:' || encode(digest(OLD.user_id,'sha256'),'hex');
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION public.erase_live_memory_source_journal_on_root_delete() FROM PUBLIC;
DO $$ DECLARE v_root TEXT; v_existing RECORD; BEGIN
  FOREACH v_root IN ARRAY ARRAY['actor_profiles','vault_keys'] LOOP
    SELECT tgfoid,tgtype,tgenabled,tgqual,tgnargs INTO v_existing
    FROM pg_trigger WHERE tgname='erase_live_memory_source_journal'
      AND tgrelid=format('public.%I',v_root)::regclass AND NOT tgisinternal;
    IF NOT FOUND THEN
      EXECUTE format('CREATE TRIGGER erase_live_memory_source_journal AFTER DELETE ON public.%I '
        'FOR EACH ROW EXECUTE FUNCTION public.erase_live_memory_source_journal_on_root_delete()',v_root);
    ELSIF v_existing.tgfoid <> 'public.erase_live_memory_source_journal_on_root_delete()'::regprocedure::OID
       OR v_existing.tgtype <> 9 OR v_existing.tgenabled <> 'O'
       OR v_existing.tgqual IS NOT NULL OR v_existing.tgnargs <> 0 THEN
      RAISE EXCEPTION 'Live Memory source erasure trigger drift on %',v_root;
    END IF;
  END LOOP;
END $$;
DO $$ BEGIN
  IF to_regprocedure('public.install_account_deletion_write_guards()') IS NOT NULL THEN
    PERFORM public.install_account_deletion_write_guards();
  END IF;
END $$;
COMMIT;
