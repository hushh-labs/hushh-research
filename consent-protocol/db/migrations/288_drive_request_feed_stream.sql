-- A request belongs in both people's durable Feed. PostgreSQL NOTIFY is only
-- an opaque wake-up; clients always reread authenticated state after connect.
BEGIN;

DO $$
DECLARE installed TEXT[];
BEGIN
  SELECT ARRAY(SELECT DISTINCT hit[1] FROM regexp_matches(
    pg_get_constraintdef(c.oid), '''(document_share_[^'']+)''', 'g') AS hit
    ORDER BY hit[1]) INTO installed
  FROM pg_constraint c
  WHERE c.conrelid='drive_share_events'::regclass
    AND c.conname='drive_share_events_event_type_check';
  IF installed IS DISTINCT FROM ARRAY[
    'document_share_decided','document_share_outcome',
    'document_share_payment_confirmed','document_share_payment_ready',
    'document_share_payment_refunded','document_share_request',
    'document_share_request_sent','document_share_review_ready',
    'document_share_revocation_outcome','document_share_revoked']::TEXT[] THEN
    ALTER TABLE drive_share_events DROP CONSTRAINT IF EXISTS drive_share_events_event_type_check;
    ALTER TABLE drive_share_events ADD CONSTRAINT drive_share_events_event_type_check
      CHECK (event_type IN (
        'document_share_request','document_share_request_sent',
        'document_share_review_ready','document_share_decided',
        'document_share_outcome','document_share_revoked','document_share_revocation_outcome',
        'document_share_payment_ready','document_share_payment_confirmed',
        'document_share_payment_refunded'
      ));
  END IF;
END $$;

-- 246 created the Feed projection and 262 added payment events. Retain that
-- installed implementation and extend its closed vocabulary without changing
-- the plaintext metadata boundary or rewriting the trigger on hot tables.
DO $$
DECLARE source_sql TEXT;
BEGIN
  IF to_regprocedure('project_drive_event_to_feed(text,uuid,uuid,text,text,timestamptz)') IS NULL THEN
    RAISE EXCEPTION 'Drive Feed projection is missing';
  END IF;
  SELECT pg_get_functiondef('project_drive_event_to_feed(text,uuid,uuid,text,text,timestamptz)'::regprocedure)
    INTO source_sql;
  IF strpos(source_sql, '''document_share_request_sent''') = 0 THEN
    IF strpos(source_sql, '''document_share_request'',') = 0 THEN
      RAISE EXCEPTION 'Drive Feed request event allowlist was not found';
    END IF;
    EXECUTE replace(source_sql, '''document_share_request'',',
      '''document_share_request'',' || E'\n    ''document_share_request_sent'',');
  END IF;
END $$;

-- Backfill only the new requester milestone. It is keyed by the immutable
-- outbox UUID, so replay cannot duplicate it or reinterpret an older event.
SELECT project_drive_event_to_feed(
  'share', e.event_id, e.request_id, e.user_id, e.event_type, e.created_at
)
FROM drive_share_events e
WHERE e.event_type='document_share_request_sent'
  AND e.created_at > now() - INTERVAL '3 days';

CREATE OR REPLACE FUNCTION public.notify_document_request_feed_changed()
RETURNS TRIGGER
LANGUAGE plpgsql VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE v_payload TEXT;
BEGIN
  -- An outbox row and its Feed projection commit together. No filenames,
  -- purpose, provider IDs, counterpart identity or payment details cross the
  -- notification boundary. Multiple backend instances hear the same doorbell.
  v_payload := json_build_object(
    'type', 'document_share_feed_changed',
    'user_id', NEW.user_id,
    'event_id', NEW.event_id::TEXT,
    'request_id', NEW.request_id::TEXT
  )::TEXT;
  IF octet_length(v_payload) <= 7500 THEN
    PERFORM pg_notify('one_user_state_changed', v_payload);
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- A realtime hint cannot become transaction authority for a request.
  RAISE WARNING 'drive_feed_wake_failed sqlstate=%', SQLSTATE;
  RETURN NEW;
END;
$$;

DO $$
DECLARE v_function_oid OID;
BEGIN
  SELECT tgfoid INTO v_function_oid
  FROM pg_trigger
  WHERE tgname='drive_share_event_feed_wake'
    AND tgrelid='drive_share_events'::regclass
    AND NOT tgisinternal;
  IF v_function_oid IS NULL THEN
    CREATE TRIGGER drive_share_event_feed_wake
      AFTER INSERT ON drive_share_events
      FOR EACH ROW EXECUTE FUNCTION public.notify_document_request_feed_changed();
  ELSIF v_function_oid <> 'public.notify_document_request_feed_changed()'::regprocedure::OID THEN
    RAISE EXCEPTION 'Drive Feed wake trigger points to unexpected function';
  END IF;
END $$;

REVOKE ALL ON FUNCTION public.notify_document_request_feed_changed() FROM PUBLIC;
COMMENT ON FUNCTION public.notify_document_request_feed_changed() IS
  'Committed metadata-only document request Feed doorbell; readers recover with an authenticated snapshot.';

-- Stop access (migration 287) fences grants on the request row without
-- inserting a Drive event. Wake both participants only on the first durable
-- stop transition; a later worker reconciliation can still emit its normal
-- revocation outcome. request_id is the one-shot opaque event id here.
CREATE OR REPLACE FUNCTION public.notify_document_request_access_stop()
RETURNS TRIGGER
LANGUAGE plpgsql VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_user_id TEXT;
  v_payload TEXT;
BEGIN
  IF OLD.access_stop_requested_at IS NOT NULL
     OR NEW.access_stop_requested_at IS NULL THEN
    RETURN NEW;
  END IF;
  FOREACH v_user_id IN ARRAY ARRAY[NEW.user_id, NEW.recipient_user_id] LOOP
    v_payload := json_build_object(
      'type', 'document_share_feed_changed',
      'user_id', v_user_id,
      'event_id', NEW.request_id::TEXT,
      'request_id', NEW.request_id::TEXT
    )::TEXT;
    IF octet_length(v_payload) <= 7500 THEN
      PERFORM pg_notify('one_user_state_changed', v_payload);
    END IF;
  END LOOP;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- The owner stop must still commit when a best-effort wake fails.
  RAISE WARNING 'drive_stop_feed_wake_failed sqlstate=%', SQLSTATE;
  RETURN NEW;
END;
$$;

DO $$
DECLARE v_function_oid OID;
BEGIN
  SELECT tgfoid INTO v_function_oid
  FROM pg_trigger
  WHERE tgname='drive_share_request_access_stop_feed_wake'
    AND tgrelid='drive_share_requests'::regclass
    AND NOT tgisinternal;
  IF v_function_oid IS NULL THEN
    CREATE TRIGGER drive_share_request_access_stop_feed_wake
      AFTER UPDATE OF access_stop_requested_at ON drive_share_requests
      FOR EACH ROW
      WHEN (OLD.access_stop_requested_at IS NULL AND NEW.access_stop_requested_at IS NOT NULL)
      EXECUTE FUNCTION public.notify_document_request_access_stop();
  ELSIF v_function_oid <> 'public.notify_document_request_access_stop()'::regprocedure::OID THEN
    RAISE EXCEPTION 'Drive access-stop Feed wake trigger points to unexpected function';
  END IF;
END $$;

REVOKE ALL ON FUNCTION public.notify_document_request_access_stop() FROM PUBLIC;
COMMENT ON FUNCTION public.notify_document_request_access_stop() IS
  'One-shot metadata-only wake to both request participants after owner stops document access.';

COMMIT;
