-- Down path for 282_direct_message_actions.sql.
-- Action metadata is feature-owned state, so rolling back removes only that
-- metadata and restores the original immutable-message guard.

BEGIN;

DROP TRIGGER IF EXISTS trg_direct_message_feed_projection_globally_deleted ON public.messages;
DROP TRIGGER IF EXISTS trg_z_direct_message_reaction_guard ON public.direct_message_reactions;
DROP FUNCTION IF EXISTS public.guard_direct_message_reaction_write();
DROP TABLE IF EXISTS public.direct_message_reactions;

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
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'DIRECT_MESSAGE_IMMUTABLE';
    END IF;
    IF NEW.read_at IS DISTINCT FROM OLD.read_at
       AND (OLD.read_at IS NOT NULL OR NEW.read_at IS NULL OR NEW.read_at < OLD.created_at) THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'DIRECT_MESSAGE_READ_RECEIPT_INVALID';
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
  PERFORM public.require_active_direct_message_connection(v_participant_a_user_id, v_participant_b_user_id);
  RETURN NEW;
END;
$$;

ALTER TABLE public.messages
  DROP COLUMN IF EXISTS reply_to_message_id,
  DROP COLUMN IF EXISTS edited_at,
  DROP COLUMN IF EXISTS deleted_for_sender_at,
  DROP COLUMN IF EXISTS deleted_for_recipient_at,
  DROP COLUMN IF EXISTS deleted_for_everyone_at;

COMMIT;
