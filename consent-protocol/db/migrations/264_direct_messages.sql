-- Connection-gated one-to-one direct messages.
--
-- A Direct Message is a relationship capability, not Circle membership.  The
-- authoritative admission check below reads only the canonical `connections`
-- pair and requires status='active'; it never queries Circle membership,
-- trusted_connections, or connection origins.  Historical conversations remain
-- readable when that connection is later revoked, but no new conversation or
-- message can be created.
--
-- Content is server-managed AES-256-GCM ciphertext.  The service seals it with
-- DIRECT_MESSAGE_ENCRYPTION_KEY_V1 and AAD bound to message/conversation/sender.
-- AESGCM's ciphertext includes the 16-byte authentication tag, so no plaintext
-- `content` column or separate tag column exists in this schema.

BEGIN;

CREATE TABLE IF NOT EXISTS public.conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  participant_a_user_id TEXT NOT NULL
    REFERENCES public.actor_profiles(user_id) ON DELETE CASCADE,
  participant_b_user_id TEXT NOT NULL
    REFERENCES public.actor_profiles(user_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  last_message_at TIMESTAMPTZ,
  CONSTRAINT conversations_distinct_participants
    CHECK (participant_a_user_id <> participant_b_user_id),
  CONSTRAINT conversations_canonical_participant_order
    CHECK (participant_a_user_id < participant_b_user_id),
  CONSTRAINT conversations_last_message_after_created
    CHECK (last_message_at IS NULL OR last_message_at >= created_at),
  CONSTRAINT conversations_unique_participant_pair
    UNIQUE (participant_a_user_id, participant_b_user_id)
);

CREATE TABLE IF NOT EXISTS public.messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL
    REFERENCES public.conversations(id) ON DELETE CASCADE,
  sender_user_id TEXT NOT NULL
    REFERENCES public.actor_profiles(user_id) ON DELETE CASCADE,
  -- AES-GCM output with its authentication tag appended, base64url encoded.
  content_ciphertext TEXT NOT NULL,
  -- Base64url-encoded AES-GCM nonce.  The current service emits a 96-bit nonce.
  content_iv TEXT NOT NULL,
  content_algorithm TEXT NOT NULL DEFAULT 'aes-256-gcm-aad-v1',
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  read_at TIMESTAMPTZ,
  CONSTRAINT messages_ciphertext_nonempty_bounded
    CHECK (char_length(btrim(content_ciphertext)) BETWEEN 1 AND 24576),
  CONSTRAINT messages_iv_nonempty_bounded
    CHECK (char_length(btrim(content_iv)) BETWEEN 1 AND 128),
  CONSTRAINT messages_current_algorithm
    CHECK (content_algorithm = 'aes-256-gcm-aad-v1'),
  CONSTRAINT messages_read_after_created
    CHECK (read_at IS NULL OR read_at >= created_at)
);

-- A directed block is relationship metadata, not a connection revocation.  It
-- preserves the pair's prior history while denying either person new sends.
-- Keeping it after a connection removal also prevents a later reconnection
-- from unexpectedly reopening messaging.
CREATE TABLE IF NOT EXISTS public.direct_message_blocks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  blocker_user_id TEXT NOT NULL
    REFERENCES public.actor_profiles(user_id) ON DELETE CASCADE,
  blocked_user_id TEXT NOT NULL
    REFERENCES public.actor_profiles(user_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT direct_message_blocks_no_self
    CHECK (blocker_user_id <> blocked_user_id),
  CONSTRAINT direct_message_blocks_unique_directed_pair
    UNIQUE (blocker_user_id, blocked_user_id)
);

-- Inbox access is participant-scoped.  The two expression indexes support the
-- two canonical sides without storing a duplicate viewer row.  The message
-- indexes support newest-first history, lateral latest-message lookup, unread
-- counts, and FK/account-erasure cleanup.
DO $$
BEGIN
  IF to_regclass('public.idx_conversations_participant_a_inbox') IS NULL THEN
    EXECUTE 'CREATE INDEX idx_conversations_participant_a_inbox
      ON public.conversations
      (participant_a_user_id, (COALESCE(last_message_at, created_at)) DESC, id DESC)';
  END IF;
  IF to_regclass('public.idx_conversations_participant_b_inbox') IS NULL THEN
    EXECUTE 'CREATE INDEX idx_conversations_participant_b_inbox
      ON public.conversations
      (participant_b_user_id, (COALESCE(last_message_at, created_at)) DESC, id DESC)';
  END IF;
  IF to_regclass('public.idx_messages_conversation_created') IS NULL THEN
    EXECUTE 'CREATE INDEX idx_messages_conversation_created
      ON public.messages (conversation_id, created_at DESC, id DESC)';
  END IF;
  IF to_regclass('public.idx_messages_conversation_unread') IS NULL THEN
    EXECUTE 'CREATE INDEX idx_messages_conversation_unread
      ON public.messages (conversation_id, created_at DESC, id DESC)
      WHERE read_at IS NULL';
  END IF;
  IF to_regclass('public.idx_messages_sender_user_id') IS NULL THEN
    EXECUTE 'CREATE INDEX idx_messages_sender_user_id
      ON public.messages (sender_user_id)';
  END IF;
  IF to_regclass('public.idx_direct_message_blocks_blocked_user_id') IS NULL THEN
    EXECUTE 'CREATE INDEX idx_direct_message_blocks_blocked_user_id
      ON public.direct_message_blocks (blocked_user_id)';
  END IF;
END $$;

-- Lock the canonical pair row before deciding whether sending is permitted.
-- The row lock shares the same decisive state as connection revocation: a send
-- cannot observe active and commit after a concurrent revoke has won.  This is
-- deliberately independent of Circle membership and connection origins.
CREATE OR REPLACE FUNCTION public.require_active_direct_message_connection(
  p_first_user_id TEXT,
  p_second_user_id TEXT
) RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_connection_status TEXT;
BEGIN
  IF NULLIF(btrim(p_first_user_id), '') IS NULL
     OR NULLIF(btrim(p_second_user_id), '') IS NULL
     OR p_first_user_id = p_second_user_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'DIRECT_MESSAGE_CONNECTION_REQUIRED',
      DETAIL = 'An active accepted connection is required to send a direct message.';
  END IF;

  SELECT connection.status
    INTO v_connection_status
    FROM public.connections AS connection
   WHERE connection.user_a_id = LEAST(p_first_user_id, p_second_user_id)
     AND connection.user_b_id = GREATEST(p_first_user_id, p_second_user_id)
   FOR UPDATE;

  IF NOT FOUND OR v_connection_status <> 'active' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'DIRECT_MESSAGE_CONNECTION_REQUIRED',
      DETAIL = 'An active accepted connection is required to send a direct message.';
  END IF;

  -- `direct_message_blocks` is directed, but either participant's block
  -- closes the conversation to new messages.  Block mutations take the same
  -- connection-row FOR UPDATE lock in their trigger, so an absent-row check
  -- cannot race a concurrently committed block.
  IF EXISTS (
    SELECT 1
    FROM public.direct_message_blocks AS message_block
    WHERE (message_block.blocker_user_id = p_first_user_id
           AND message_block.blocked_user_id = p_second_user_id)
       OR (message_block.blocker_user_id = p_second_user_id
           AND message_block.blocked_user_id = p_first_user_id)
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'DIRECT_MESSAGE_BLOCKED',
      DETAIL = 'Messaging is unavailable for this connection.';
  END IF;
END;
$$;

-- Serialise directed block/unblock mutations with sends using the same
-- canonical connection row.  A block that wins the lock is visible to the
-- next send; a send that wins is correctly ordered before that new block.
-- Blocks may exist after a connection ends so they remain effective if the
-- people reconnect later.
CREATE OR REPLACE FUNCTION public.guard_direct_message_block_write()
RETURNS TRIGGER
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_blocker_user_id TEXT;
  v_blocked_user_id TEXT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.blocker_user_id IS DISTINCT FROM OLD.blocker_user_id
       OR NEW.blocked_user_id IS DISTINCT FROM OLD.blocked_user_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'DIRECT_MESSAGE_BLOCK_IMMUTABLE';
    END IF;
    RETURN NEW;
  END IF;

  v_blocker_user_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.blocker_user_id ELSE NEW.blocker_user_id END;
  v_blocked_user_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.blocked_user_id ELSE NEW.blocked_user_id END;

  -- There may be no canonical connection row when a block is retained after
  -- removal.  In that case there is no active send to serialize with.
  PERFORM 1
  FROM public.connections AS connection
  WHERE connection.user_a_id = LEAST(v_blocker_user_id, v_blocked_user_id)
    AND connection.user_b_id = GREATEST(v_blocker_user_id, v_blocked_user_id)
  FOR UPDATE;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

-- Conversation pairs are immutable after creation.  Only the derived inbox
-- timestamp may change, and insertion has the same locked connection gate as
-- message creation.  The trigger name sorts after migration 201's tombstone
-- guard so identity locks are acquired before the graph row lock.
CREATE OR REPLACE FUNCTION public.guard_direct_message_conversation_write()
RETURNS TRIGGER
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM public.require_active_direct_message_connection(
      NEW.participant_a_user_id,
      NEW.participant_b_user_id
    );
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.participant_a_user_id IS DISTINCT FROM OLD.participant_a_user_id
     OR NEW.participant_b_user_id IS DISTINCT FROM OLD.participant_b_user_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'DIRECT_MESSAGE_CONVERSATION_IMMUTABLE';
  END IF;

  IF NEW.last_message_at IS DISTINCT FROM OLD.last_message_at
     AND (
       NEW.last_message_at IS NULL
       OR NEW.last_message_at < OLD.created_at
       OR (
         OLD.last_message_at IS NOT NULL
         AND NEW.last_message_at < OLD.last_message_at
       )
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'DIRECT_MESSAGE_CONVERSATION_TIMESTAMP_INVALID';
  END IF;

  RETURN NEW;
END;
$$;

-- A message is immutable except for one monotonic read receipt.  The insert
-- gate verifies the sender is one of the two stored participants and locks the
-- current connection edge.  A later read receipt is intentionally allowed
-- after disconnect so a person can clear the unread indicator while viewing
-- preserved, read-only history; it can never alter message content or sender.
CREATE OR REPLACE FUNCTION public.guard_direct_message_message_write()
RETURNS TRIGGER
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_participant_a_user_id TEXT;
  v_participant_b_user_id TEXT;
  v_conversation_created_at TIMESTAMPTZ;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
       OR NEW.sender_user_id IS DISTINCT FROM OLD.sender_user_id
       OR NEW.content_ciphertext IS DISTINCT FROM OLD.content_ciphertext
       OR NEW.content_iv IS DISTINCT FROM OLD.content_iv
       OR NEW.content_algorithm IS DISTINCT FROM OLD.content_algorithm
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'DIRECT_MESSAGE_IMMUTABLE';
    END IF;

    IF NEW.read_at IS DISTINCT FROM OLD.read_at
       AND (
         OLD.read_at IS NOT NULL
         OR NEW.read_at IS NULL
         OR NEW.read_at < OLD.created_at
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'DIRECT_MESSAGE_READ_RECEIPT_INVALID';
    END IF;

    RETURN NEW;
  END IF;

  SELECT
    conversation.participant_a_user_id,
    conversation.participant_b_user_id,
    conversation.created_at
    INTO
      v_participant_a_user_id,
      v_participant_b_user_id,
      v_conversation_created_at
    FROM public.conversations AS conversation
   WHERE conversation.id = NEW.conversation_id
   FOR KEY SHARE;

  IF NOT FOUND
     OR NEW.sender_user_id NOT IN (v_participant_a_user_id, v_participant_b_user_id) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'DIRECT_MESSAGE_SENDER_FORBIDDEN',
      DETAIL = 'Only conversation participants can send direct messages.';
  END IF;

  IF NEW.created_at < v_conversation_created_at THEN
    RAISE EXCEPTION USING
      ERRCODE = '22007',
      MESSAGE = 'DIRECT_MESSAGE_TIMESTAMP_INVALID';
  END IF;

  PERFORM public.require_active_direct_message_connection(
    v_participant_a_user_id,
    v_participant_b_user_id
  );
  RETURN NEW;
END;
$$;

-- Maintain the inbox timestamp from the immutable message event rather than
-- trusting a separate application write.  A late/backfilled message cannot
-- move a conversation backwards.
CREATE OR REPLACE FUNCTION public.touch_direct_message_conversation()
RETURNS TRIGGER
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  UPDATE public.conversations
     SET last_message_at = CASE
       WHEN last_message_at IS NULL OR NEW.created_at > last_message_at
         THEN NEW.created_at
       ELSE last_message_at
     END
   WHERE id = NEW.conversation_id;
  RETURN NEW;
END;
$$;

-- Postgres NOTIFY is a doorbell, never a message transport.  The recipient
-- re-reads through the authenticated API; the event includes no content,
-- encryption envelope, sender identity, display name, or unread count.
CREATE OR REPLACE FUNCTION public.notify_direct_message_recipient()
RETURNS TRIGGER
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_recipient_user_id TEXT;
  v_payload TEXT;
  v_deep_link TEXT;
BEGIN
  SELECT CASE
    WHEN conversation.participant_a_user_id = NEW.sender_user_id
      THEN conversation.participant_b_user_id
    ELSE conversation.participant_a_user_id
  END
    INTO v_recipient_user_id
    FROM public.conversations AS conversation
   WHERE conversation.id = NEW.conversation_id;

  IF v_recipient_user_id IS NULL THEN
    -- The FK and before-insert participant gate make this unreachable in a
    -- healthy database.  Do not turn a delivery hint into a mutation failure.
    RETURN NEW;
  END IF;

  v_deep_link := '/one/messages?conversationId=' || NEW.conversation_id::TEXT;
  v_payload := json_build_object(
    'type', 'direct_message',
    'user_id', v_recipient_user_id,
    'message_id', 'direct-message:' || NEW.id::TEXT,
    'conversation_id', NEW.conversation_id::TEXT,
    'direct_message_id', NEW.id::TEXT,
    'at', NEW.created_at,
    'deep_link', v_deep_link,
    'request_url', v_deep_link
  )::TEXT;

  -- Keep below the listener's 7.5 KiB safety cap.  Firebase UIDs and UUIDs
  -- make this branch theoretical, but persistence must not depend on a hint.
  IF octet_length(v_payload) <= 7500 THEN
    PERFORM pg_notify('one_user_state_changed', v_payload);
  END IF;
  RETURN NEW;
END;
$$;

-- Do not use DROP/CREATE on hot tables during replay.  A migration replay only
-- creates a missing trigger; a manually repointed trigger fails closed instead
-- of silently weakening the gate.
DO $$
DECLARE
  v_function_oid OID;
BEGIN
  SELECT tgfoid INTO v_function_oid
    FROM pg_trigger
   WHERE tgrelid = 'public.conversations'::regclass
     AND tgname = 'trg_z_direct_message_conversation_guard'
     AND NOT tgisinternal;
  IF NOT FOUND THEN
    EXECUTE 'CREATE TRIGGER trg_z_direct_message_conversation_guard
      BEFORE INSERT OR UPDATE ON public.conversations
      FOR EACH ROW EXECUTE FUNCTION public.guard_direct_message_conversation_write()';
  ELSIF v_function_oid <> 'public.guard_direct_message_conversation_write()'::regprocedure::OID THEN
    RAISE EXCEPTION 'direct-message conversation guard trigger has unexpected function';
  END IF;

  SELECT tgfoid INTO v_function_oid
    FROM pg_trigger
   WHERE tgrelid = 'public.messages'::regclass
     AND tgname = 'trg_z_direct_message_message_guard'
     AND NOT tgisinternal;
  IF NOT FOUND THEN
    EXECUTE 'CREATE TRIGGER trg_z_direct_message_message_guard
      BEFORE INSERT OR UPDATE ON public.messages
      FOR EACH ROW EXECUTE FUNCTION public.guard_direct_message_message_write()';
  ELSIF v_function_oid <> 'public.guard_direct_message_message_write()'::regprocedure::OID THEN
    RAISE EXCEPTION 'direct-message message guard trigger has unexpected function';
  END IF;

  SELECT tgfoid INTO v_function_oid
    FROM pg_trigger
   WHERE tgrelid = 'public.direct_message_blocks'::regclass
     AND tgname = 'trg_z_direct_message_block_guard'
     AND NOT tgisinternal;
  IF NOT FOUND THEN
    EXECUTE 'CREATE TRIGGER trg_z_direct_message_block_guard
      BEFORE INSERT OR UPDATE OR DELETE ON public.direct_message_blocks
      FOR EACH ROW EXECUTE FUNCTION public.guard_direct_message_block_write()';
  ELSIF v_function_oid <> 'public.guard_direct_message_block_write()'::regprocedure::OID THEN
    RAISE EXCEPTION 'direct-message block guard trigger has unexpected function';
  END IF;

  SELECT tgfoid INTO v_function_oid
    FROM pg_trigger
   WHERE tgrelid = 'public.messages'::regclass
     AND tgname = 'trg_direct_message_conversation_touched'
     AND NOT tgisinternal;
  IF NOT FOUND THEN
    EXECUTE 'CREATE TRIGGER trg_direct_message_conversation_touched
      AFTER INSERT ON public.messages
      FOR EACH ROW EXECUTE FUNCTION public.touch_direct_message_conversation()';
  ELSIF v_function_oid <> 'public.touch_direct_message_conversation()'::regprocedure::OID THEN
    RAISE EXCEPTION 'direct-message inbox timestamp trigger has unexpected function';
  END IF;

  SELECT tgfoid INTO v_function_oid
    FROM pg_trigger
   WHERE tgrelid = 'public.messages'::regclass
     AND tgname = 'trg_direct_message_recipient_notified'
     AND NOT tgisinternal;
  IF NOT FOUND THEN
    EXECUTE 'CREATE TRIGGER trg_direct_message_recipient_notified
      AFTER INSERT ON public.messages
      FOR EACH ROW EXECUTE FUNCTION public.notify_direct_message_recipient()';
  ELSIF v_function_oid <> 'public.notify_direct_message_recipient()'::regprocedure::OID THEN
    RAISE EXCEPTION 'direct-message recipient notification trigger has unexpected function';
  END IF;
END $$;

-- Browser/mobile clients never receive a database role for this personal
-- relationship data.  Cloud SQL's current runtime shares the table-owner role
-- and therefore bypasses RLS; do not FORCE RLS until schema and runtime roles
-- are separated.  The API/service participant checks and trigger gates remain
-- mandatory for that privileged path.
DO $$
DECLARE
  v_table_name TEXT;
  v_policy RECORD;
BEGIN
  FOREACH v_table_name IN ARRAY ARRAY['conversations', 'messages', 'direct_message_blocks'] LOOP
    IF NOT (
      SELECT relation.relrowsecurity
      FROM pg_class AS relation
      WHERE relation.oid = format('public.%I', v_table_name)::regclass
    ) THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_table_name);
    END IF;

    FOR v_policy IN
      SELECT policy.polname
      FROM pg_policy AS policy
      WHERE policy.polrelid = format('public.%I', v_table_name)::regclass
    LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', v_policy.polname, v_table_name);
    END LOOP;
  END LOOP;
END $$;

REVOKE ALL PRIVILEGES ON TABLE public.conversations, public.messages,
  public.direct_message_blocks FROM PUBLIC;
DO $$
DECLARE
  v_role_name TEXT;
BEGIN
  FOREACH v_role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role_name) THEN
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON TABLE public.conversations, public.messages, public.direct_message_blocks FROM %I',
        v_role_name
      );
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    REVOKE ALL PRIVILEGES ON TABLE public.conversations, public.messages,
      public.direct_message_blocks FROM service_role;
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON TABLE public.conversations, public.messages, public.direct_message_blocks TO service_role;
  END IF;
END $$;

REVOKE ALL ON FUNCTION public.require_active_direct_message_connection(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_direct_message_block_write() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_direct_message_conversation_write() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_direct_message_message_write() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.touch_direct_message_conversation() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.notify_direct_message_recipient() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.require_active_direct_message_connection(TEXT, TEXT) TO service_role;
    GRANT EXECUTE ON FUNCTION public.guard_direct_message_block_write() TO service_role;
    GRANT EXECUTE ON FUNCTION public.guard_direct_message_conversation_write() TO service_role;
    GRANT EXECUTE ON FUNCTION public.guard_direct_message_message_write() TO service_role;
    GRANT EXECUTE ON FUNCTION public.touch_direct_message_conversation() TO service_role;
    GRANT EXECUTE ON FUNCTION public.notify_direct_message_recipient() TO service_role;
  END IF;
END $$;

DO $$
BEGIN
  IF to_regprocedure('public.install_account_deletion_write_guards()') IS NOT NULL THEN
    PERFORM public.install_account_deletion_write_guards();
  END IF;
END $$;

COMMENT ON TABLE public.conversations IS
  'Canonical one-to-one direct-message participant pair. Creation requires the current active connections edge; revocation preserves history but blocks new messages.';
COMMENT ON TABLE public.messages IS
  'AES-256-GCM direct-message envelopes. content_ciphertext includes the GCM tag; no plaintext message content is persisted.';
COMMENT ON TABLE public.direct_message_blocks IS
  'Directed direct-message block state. Either direction blocks new sends while preserving conversation history and the canonical connection itself.';
COMMENT ON COLUMN public.messages.content_algorithm IS
  'Envelope version aes-256-gcm-aad-v1. AAD binds direct-message-v1, conversation id, message id, and sender user id.';
COMMENT ON FUNCTION public.require_active_direct_message_connection(TEXT, TEXT) IS
  'Locks and validates the canonical active connections pair and either directed direct-message block for writes; never derives authority from Circle membership.';
COMMENT ON FUNCTION public.notify_direct_message_recipient() IS
  'Transactional metadata-only one_user_state_changed doorbell for the direct-message recipient; no content or sender identity is published.';

COMMIT;
