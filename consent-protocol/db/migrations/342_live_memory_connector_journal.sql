-- Durable, owner-only change hints for operator-owned OAuth connections.
-- No credential, token, scope, account label, or provider payload is copied.
-- The owner client must reread the authoritative connector overview before
-- changing its encrypted living-source projection. A hint is not a grant.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- A one-way owner commitment keeps the raw UID out of the journal. It also
-- avoids acquiring migration-201's identity-guard advisory lock after the
-- connector source row is locked, which could invert account-erasure order.
CREATE TABLE IF NOT EXISTS public.live_memory_connector_streams (
  owner_hash TEXT PRIMARY KEY CHECK (owner_hash ~ '^sha256:[0-9a-f]{64}$'),
  last_sequence BIGINT NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
  first_retained_sequence BIGINT NOT NULL DEFAULT 1
    CHECK (first_retained_sequence >= 1),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CHECK (first_retained_sequence - 1 <= last_sequence)
);

CREATE TABLE IF NOT EXISTS public.live_memory_connector_events (
  owner_hash TEXT NOT NULL REFERENCES public.live_memory_connector_streams(owner_hash) ON DELETE CASCADE,
  sequence BIGINT NOT NULL CHECK (sequence > 0),
  event_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  source_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('changed', 'deleted')),
  schema_version SMALLINT NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (owner_hash, sequence)
);

COMMENT ON TABLE public.live_memory_connector_streams IS
  'SHA-256 owner commitment and commit-ordered replay cursor for connector status hints. The stream row is locked by every append transaction.';
COMMENT ON TABLE public.live_memory_connector_events IS
  'Metadata-only operator OAuth connection hints. No credential values, tokens, scopes, account labels, or provider payloads.';

ALTER TABLE public.live_memory_connector_streams ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.live_memory_connector_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.live_memory_connector_streams, public.live_memory_connector_events FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON public.live_memory_connector_streams, public.live_memory_connector_events TO service_role;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.append_live_memory_connector_event()
RETURNS TRIGGER
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user_id TEXT;
  v_owner_hash TEXT;
  v_source_id TEXT;
  v_sequence BIGINT;
  v_first BIGINT;
BEGIN
  v_user_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.user_id ELSE NEW.user_id END;
  v_owner_hash := 'sha256:' || encode(digest(v_user_id, 'sha256'), 'hex');
  v_source_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.connector_id ELSE NEW.connector_id END;

  IF TG_OP = 'UPDATE'
     AND OLD.status IS NOT DISTINCT FROM NEW.status
     AND OLD.connected_at IS NOT DISTINCT FROM NEW.connected_at THEN
    RETURN NEW;
  END IF;

  -- Full account erasure records its tombstone before clearing credentials.
  -- A reset has no tombstone and may append a deletion before its journal is
  -- wiped in the same account-reset transaction.
  IF EXISTS (
    SELECT 1 FROM public.account_deletion_tombstones
    WHERE user_id_hash = v_owner_hash
  ) THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  -- The manifest-backed curated flag is code-owned; SQL deliberately emits a
  -- conservative hint for operator OAuth rows. The owner overview remains the
  -- authority for whether this source is actually curated and eligible.
  IF NOT EXISTS (
    SELECT 1 FROM public.external_mcp_connectors
    WHERE connector_id = v_source_id AND user_id IS NULL AND auth_style = 'oauth'
  ) THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  -- Updating one owner stream row holds a row lock until the source commit.
  -- A concurrent transaction cannot reserve a later sequence and commit first.
  INSERT INTO public.live_memory_connector_streams (owner_hash, last_sequence)
  VALUES (v_owner_hash, 1)
  ON CONFLICT (owner_hash) DO UPDATE SET
    last_sequence = live_memory_connector_streams.last_sequence + 1,
    updated_at = clock_timestamp()
  RETURNING last_sequence INTO v_sequence;

  INSERT INTO public.live_memory_connector_events
    (owner_hash, sequence, source_id, operation)
  VALUES (
    v_owner_hash, v_sequence, v_source_id,
    CASE WHEN TG_OP = 'DELETE' THEN 'deleted' ELSE 'changed' END
  );

  -- Keep at most the latest 2,048 committed events per owner. A lagging reader
  -- receives reset_required and rebuilds from the authenticated overview.
  v_first := GREATEST(1, v_sequence - 2047);
  UPDATE public.live_memory_connector_streams
  SET first_retained_sequence = GREATEST(first_retained_sequence, v_first)
  WHERE owner_hash = v_owner_hash
  RETURNING first_retained_sequence INTO v_first;
  DELETE FROM public.live_memory_connector_events
  WHERE owner_hash = v_owner_hash AND sequence < v_first;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.append_live_memory_connector_event() FROM PUBLIC;

-- Root deletion is the database's full-erasure signal, including while an
-- older runtime is still serving traffic after this migration is installed.
-- Migration 201 records the tombstone BEFORE this AFTER trigger runs; the
-- source trigger then suppresses any later connector deletion in that txn.
CREATE OR REPLACE FUNCTION public.erase_live_memory_connector_journal_on_root_delete()
RETURNS TRIGGER
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  DELETE FROM public.live_memory_connector_streams
  WHERE owner_hash = 'sha256:' || encode(digest(OLD.user_id, 'sha256'), 'hex');
  RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION public.erase_live_memory_connector_journal_on_root_delete() FROM PUBLIC;

DO $$
DECLARE
  v_trigger RECORD;
  v_expected_attrs TEXT[];
  v_actual_attrs TEXT[];
BEGIN
  SELECT tgfoid, tgtype, tgenabled, tgqual, tgnargs, tgattr,
         tgconstraint, tgoldtable, tgnewtable INTO v_trigger FROM pg_trigger
  WHERE tgname = 'external_connector_live_memory_journal'
    AND tgrelid = 'public.user_external_connector_connections'::regclass
    AND NOT tgisinternal;
  IF NOT FOUND THEN
    CREATE TRIGGER external_connector_live_memory_journal
      AFTER INSERT OR UPDATE OF status, connected_at OR DELETE
      ON public.user_external_connector_connections
      FOR EACH ROW EXECUTE FUNCTION public.append_live_memory_connector_event();
  ELSE
    SELECT array_agg(attnum::TEXT ORDER BY attnum::TEXT) INTO v_expected_attrs
    FROM pg_attribute
    WHERE attrelid = 'public.user_external_connector_connections'::regclass
      AND attname IN ('status', 'connected_at') AND NOT attisdropped;
    SELECT array_agg(attr ORDER BY attr) INTO v_actual_attrs
    FROM unnest(string_to_array(v_trigger.tgattr::TEXT, ' ')) AS attrs(attr);
    IF v_trigger.tgfoid <> 'public.append_live_memory_connector_event()'::regprocedure::OID
       OR v_trigger.tgtype <> 29 OR v_trigger.tgenabled <> 'O'
       OR v_trigger.tgqual IS NOT NULL OR v_trigger.tgnargs <> 0
       OR v_trigger.tgconstraint <> 0
       OR v_trigger.tgoldtable IS NOT NULL OR v_trigger.tgnewtable IS NOT NULL
       OR v_actual_attrs IS DISTINCT FROM v_expected_attrs THEN
      RAISE EXCEPTION 'Connector journal trigger has unexpected definition';
    END IF;
  END IF;
END $$;

DO $$
DECLARE
  v_root TEXT;
  v_trigger RECORD;
BEGIN
  FOREACH v_root IN ARRAY ARRAY['actor_profiles', 'vault_keys'] LOOP
    SELECT tgfoid, tgtype, tgenabled, tgqual, tgnargs INTO v_trigger
    FROM pg_trigger
    WHERE tgname = 'erase_live_memory_connector_journal'
      AND tgrelid = format('public.%I', v_root)::regclass
      AND NOT tgisinternal;
    IF NOT FOUND THEN
      EXECUTE format(
        'CREATE TRIGGER erase_live_memory_connector_journal '
        'AFTER DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION '
        'public.erase_live_memory_connector_journal_on_root_delete()',
        v_root
      );
    ELSIF v_trigger.tgfoid <>
          'public.erase_live_memory_connector_journal_on_root_delete()'::regprocedure::OID
       OR v_trigger.tgtype <> 9 OR v_trigger.tgenabled <> 'O'
       OR v_trigger.tgqual IS NOT NULL OR v_trigger.tgnargs <> 0 THEN
      RAISE EXCEPTION 'Connector journal erasure trigger has unexpected definition on %', v_root;
    END IF;
  END LOOP;
END $$;

DO $$
BEGIN
  IF to_regprocedure('public.install_account_deletion_write_guards()') IS NOT NULL THEN
    PERFORM public.install_account_deletion_write_guards();
  END IF;
END $$;
COMMIT;
