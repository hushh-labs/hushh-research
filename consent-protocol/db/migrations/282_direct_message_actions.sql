-- Durable direct-message actions: replies, edits, scoped deletion, and reactions.
--
-- Bodies remain in the existing AES-GCM message envelope. This migration only
-- adds participant-scoped metadata and never copies plaintext into a projection.

BEGIN;

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reply_to_message_id UUID
    REFERENCES public.messages(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS deleted_for_sender_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_for_recipient_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_for_everyone_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS public.direct_message_reactions (
  message_id UUID NOT NULL
    REFERENCES public.messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL
    REFERENCES public.actor_profiles(user_id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT direct_message_reactions_one_per_participant
    PRIMARY KEY (message_id, user_id),
  CONSTRAINT direct_message_reactions_emoji_bounded
    CHECK (char_length(btrim(emoji)) BETWEEN 1 AND 32),
  CONSTRAINT direct_message_reactions_updated_after_created
    CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS idx_direct_message_reactions_message
  ON public.direct_message_reactions (message_id, emoji);

-- Replaces the initial read-receipt-only guard. All identity fields remain
-- immutable; an update can make exactly one of the explicitly modeled action
-- changes. Sender authorization is enforced by the service before these
-- privileged runtime writes reach the database.
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
  v_content_changed BOOLEAN;
  v_visibility_changed BOOLEAN;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
       OR NEW.sender_user_id IS DISTINCT FROM OLD.sender_user_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.reply_to_message_id IS DISTINCT FROM OLD.reply_to_message_id THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'DIRECT_MESSAGE_IMMUTABLE';
    END IF;

    IF NEW.read_at IS DISTINCT FROM OLD.read_at
       AND (OLD.read_at IS NOT NULL OR NEW.read_at IS NULL OR NEW.read_at < OLD.created_at) THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'DIRECT_MESSAGE_READ_RECEIPT_INVALID';
    END IF;

    v_content_changed := NEW.content_ciphertext IS DISTINCT FROM OLD.content_ciphertext
      OR NEW.content_iv IS DISTINCT FROM OLD.content_iv
      OR NEW.content_algorithm IS DISTINCT FROM OLD.content_algorithm;
    IF v_content_changed AND (
      OLD.deleted_for_everyone_at IS NOT NULL
      OR NEW.edited_at IS NULL
      OR (OLD.edited_at IS NOT NULL AND NEW.edited_at <= OLD.edited_at)
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'DIRECT_MESSAGE_EDIT_INVALID';
    END IF;
    IF NOT v_content_changed AND NEW.edited_at IS DISTINCT FROM OLD.edited_at THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'DIRECT_MESSAGE_EDIT_INVALID';
    END IF;

    v_visibility_changed := NEW.deleted_for_sender_at IS DISTINCT FROM OLD.deleted_for_sender_at
      OR NEW.deleted_for_recipient_at IS DISTINCT FROM OLD.deleted_for_recipient_at
      OR NEW.deleted_for_everyone_at IS DISTINCT FROM OLD.deleted_for_everyone_at;
    IF v_visibility_changed AND (
      (NEW.deleted_for_sender_at IS DISTINCT FROM OLD.deleted_for_sender_at
        AND (OLD.deleted_for_sender_at IS NOT NULL OR NEW.deleted_for_sender_at IS NULL))
      OR (NEW.deleted_for_recipient_at IS DISTINCT FROM OLD.deleted_for_recipient_at
        AND (OLD.deleted_for_recipient_at IS NOT NULL OR NEW.deleted_for_recipient_at IS NULL))
      OR (NEW.deleted_for_everyone_at IS DISTINCT FROM OLD.deleted_for_everyone_at
        AND (OLD.deleted_for_everyone_at IS NOT NULL OR NEW.deleted_for_everyone_at IS NULL))
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'DIRECT_MESSAGE_DELETE_INVALID';
    END IF;
    RETURN NEW;
  END IF;

  SELECT conversation.participant_a_user_id, conversation.participant_b_user_id, conversation.created_at
    INTO v_participant_a_user_id, v_participant_b_user_id, v_conversation_created_at
    FROM public.conversations AS conversation
   WHERE conversation.id = NEW.conversation_id
   FOR KEY SHARE;

  IF NOT FOUND OR NEW.sender_user_id NOT IN (v_participant_a_user_id, v_participant_b_user_id) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'DIRECT_MESSAGE_SENDER_FORBIDDEN';
  END IF;
  IF NEW.created_at < v_conversation_created_at THEN
    RAISE EXCEPTION USING ERRCODE = '22007', MESSAGE = 'DIRECT_MESSAGE_TIMESTAMP_INVALID';
  END IF;
  IF NEW.reply_to_message_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.messages AS reply
    WHERE reply.id = NEW.reply_to_message_id AND reply.conversation_id = NEW.conversation_id
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'DIRECT_MESSAGE_REPLY_INVALID';
  END IF;
  PERFORM public.require_active_direct_message_connection(v_participant_a_user_id, v_participant_b_user_id);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_direct_message_reaction_write()
RETURNS TRIGGER
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_message_id UUID;
  v_user_id TEXT;
  v_sender_user_id TEXT;
  v_deleted_for_everyone_at TIMESTAMPTZ;
  v_participant_a_user_id TEXT;
  v_participant_b_user_id TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND (
    NEW.message_id IS DISTINCT FROM OLD.message_id
    OR NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.updated_at < OLD.updated_at
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'DIRECT_MESSAGE_REACTION_IMMUTABLE';
  END IF;

  v_message_id := NEW.message_id;
  v_user_id := NEW.user_id;
  SELECT message.sender_user_id, message.deleted_for_everyone_at,
         conversation.participant_a_user_id, conversation.participant_b_user_id
    INTO v_sender_user_id, v_deleted_for_everyone_at, v_participant_a_user_id, v_participant_b_user_id
    FROM public.messages AS message
    JOIN public.conversations AS conversation ON conversation.id = message.conversation_id
   WHERE message.id = v_message_id
   FOR KEY SHARE OF message, conversation;
  IF NOT FOUND OR v_user_id NOT IN (v_participant_a_user_id, v_participant_b_user_id) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'DIRECT_MESSAGE_REACTION_FORBIDDEN';
  END IF;
  IF v_deleted_for_everyone_at IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'DIRECT_MESSAGE_REACTION_DELETED';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_z_direct_message_reaction_guard ON public.direct_message_reactions;
CREATE TRIGGER trg_z_direct_message_reaction_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.direct_message_reactions
  FOR EACH ROW EXECUTE FUNCTION public.guard_direct_message_reaction_write();

-- A global deletion makes the existing recipient Feed pointer stale. The body
-- has never been copied into Feed, and the source row remains for the familiar
-- "message deleted" thread state.
DROP TRIGGER IF EXISTS trg_direct_message_feed_projection_globally_deleted ON public.messages;
CREATE TRIGGER trg_direct_message_feed_projection_globally_deleted
  AFTER UPDATE OF deleted_for_everyone_at ON public.messages
  FOR EACH ROW
  WHEN (OLD.deleted_for_everyone_at IS NULL AND NEW.deleted_for_everyone_at IS NOT NULL)
  EXECUTE FUNCTION public.remove_direct_message_feed_event();

ALTER TABLE public.direct_message_reactions ENABLE ROW LEVEL SECURITY;
DO $$
DECLARE
  v_policy RECORD;
BEGIN
  FOR v_policy IN SELECT policy.polname FROM pg_policy AS policy
    WHERE policy.polrelid = 'public.direct_message_reactions'::regclass
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.direct_message_reactions', v_policy.polname);
  END LOOP;
END $$;

REVOKE ALL PRIVILEGES ON TABLE public.direct_message_reactions FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL PRIVILEGES ON TABLE public.direct_message_reactions FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL PRIVILEGES ON TABLE public.direct_message_reactions FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.direct_message_reactions TO service_role;
    GRANT EXECUTE ON FUNCTION public.guard_direct_message_reaction_write() TO service_role;
  END IF;
END $$;

REVOKE ALL ON FUNCTION public.guard_direct_message_reaction_write() FROM PUBLIC;

-- The reactions table introduces a new persisted account identity reference.
-- Reinstall migration 201's guards in the same transaction so a tombstoned
-- identity cannot be written before a later migration happens to refresh them.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'install_account_deletion_write_guards') THEN
    PERFORM public.install_account_deletion_write_guards();
  END IF;
END $$;

COMMENT ON COLUMN public.messages.reply_to_message_id IS
  'Optional same-conversation parent message for participant-visible reply context.';
COMMENT ON TABLE public.direct_message_reactions IS
  'Participant-scoped durable reaction metadata for encrypted direct-message envelopes; emoji only, no plaintext content.';

COMMIT;
