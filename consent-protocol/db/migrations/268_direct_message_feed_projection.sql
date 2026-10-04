-- Recipient-only Feed history for connection-gated Direct Messages.
--
-- `messages` remains the sole authority for an encrypted direct-message body.
-- This projection records only an opaque source-message reference. Feed reads
-- may reopen that source for its authenticated recipient and return a bounded,
-- transient preview; neither the body nor its encryption envelope is copied
-- into `feed_events`, push payloads, or realtime doorbells.

BEGIN;

CREATE OR REPLACE FUNCTION public.project_direct_message_feed_event()
RETURNS TRIGGER
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_recipient_user_id TEXT;
  v_feed_event_id BIGINT;
BEGIN
  SELECT CASE
    WHEN conversation.participant_a_user_id = NEW.sender_user_id
      THEN conversation.participant_b_user_id
    WHEN conversation.participant_b_user_id = NEW.sender_user_id
      THEN conversation.participant_a_user_id
  END
    INTO v_recipient_user_id
    FROM public.conversations AS conversation
   WHERE conversation.id = NEW.conversation_id;

  -- The message guard guarantees this in a healthy database. Keep the Feed
  -- projection defensive: a presentation row must never broaden a malformed
  -- relationship write into a recipient-facing record.
  IF v_recipient_user_id IS NULL
     OR v_recipient_user_id = NEW.sender_user_id THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.feed_events (
    user_id, source_domain, event_type, actor_label, metadata, source_row_id
  )
  VALUES (
    v_recipient_user_id,
    'connections',
    'direct_message_received',
    NULL,
    '{}'::JSONB,
    NEW.id::TEXT
  )
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_feed_event_id;

  -- The source projection index makes the insert idempotent. Reuse an
  -- existing row on a replay so its current counterpart identity remains
  -- resolvable without putting an internal user id in Feed metadata.
  IF v_feed_event_id IS NULL THEN
    SELECT id
      INTO v_feed_event_id
      FROM public.feed_events
     WHERE user_id = v_recipient_user_id
       AND source_domain = 'connections'
       AND event_type = 'direct_message_received'
       AND source_row_id = NEW.id::TEXT
     LIMIT 1;
  END IF;

  IF v_feed_event_id IS NOT NULL THEN
    INSERT INTO public.feed_event_counterparts (
      feed_event_id, counterpart_user_id
    )
    VALUES (v_feed_event_id, NEW.sender_user_id)
    ON CONFLICT (feed_event_id) DO UPDATE
      SET counterpart_user_id = EXCLUDED.counterpart_user_id;
  END IF;

  RETURN NEW;
END;
$$;

-- Source deletion includes explicit erasure plus foreign-key cascades from
-- either participant. Remove the derived Feed row at that same boundary so a
-- recipient never retains a pointer (or a future preview) to erased history.
CREATE OR REPLACE FUNCTION public.remove_direct_message_feed_event()
RETURNS TRIGGER
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  DELETE FROM public.feed_events
   WHERE source_domain = 'connections'
     AND event_type = 'direct_message_received'
     AND source_row_id = OLD.id::TEXT;
  RETURN OLD;
END;
$$;

-- Replays create only missing triggers. A manually repointed trigger fails
-- closed instead of silently weakening recipient isolation or source cleanup.
DO $$
DECLARE
  v_function_oid OID;
BEGIN
  SELECT tgfoid INTO v_function_oid
    FROM pg_trigger
   WHERE tgrelid = 'public.messages'::regclass
     AND tgname = 'trg_direct_message_feed_projected'
     AND NOT tgisinternal;
  IF NOT FOUND THEN
    EXECUTE 'CREATE TRIGGER trg_direct_message_feed_projected
      AFTER INSERT ON public.messages
      FOR EACH ROW EXECUTE FUNCTION public.project_direct_message_feed_event()';
  ELSIF v_function_oid <> 'public.project_direct_message_feed_event()'::regprocedure::OID THEN
    RAISE EXCEPTION 'direct-message Feed projection trigger has unexpected function';
  END IF;

  SELECT tgfoid INTO v_function_oid
    FROM pg_trigger
   WHERE tgrelid = 'public.messages'::regclass
     AND tgname = 'trg_direct_message_feed_projection_deleted'
     AND NOT tgisinternal;
  IF NOT FOUND THEN
    EXECUTE 'CREATE TRIGGER trg_direct_message_feed_projection_deleted
      AFTER DELETE ON public.messages
      FOR EACH ROW EXECUTE FUNCTION public.remove_direct_message_feed_event()';
  ELSIF v_function_oid <> 'public.remove_direct_message_feed_event()'::regprocedure::OID THEN
    RAISE EXCEPTION 'direct-message Feed cleanup trigger has unexpected function';
  END IF;
END $$;

REVOKE ALL ON FUNCTION public.project_direct_message_feed_event() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.remove_direct_message_feed_event() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.project_direct_message_feed_event() TO service_role;
    GRANT EXECUTE ON FUNCTION public.remove_direct_message_feed_event() TO service_role;
  END IF;
END $$;

COMMENT ON FUNCTION public.project_direct_message_feed_event() IS
  'Creates one recipient-only Feed projection per direct message. The Feed row stores only the opaque message source id; the encrypted body is never copied into Feed storage.';
COMMENT ON FUNCTION public.remove_direct_message_feed_event() IS
  'Deletes recipient-only direct-message Feed projections when their source message is erased.';

COMMIT;
