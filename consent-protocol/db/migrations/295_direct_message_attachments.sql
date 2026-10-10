-- One encrypted, size-bounded attachment per direct message. The filename,
-- MIME type and caption live in the existing encrypted message envelope.
BEGIN;

CREATE TABLE IF NOT EXISTS public.direct_message_attachments (
  message_id UUID PRIMARY KEY REFERENCES public.messages(id) ON DELETE CASCADE,
  ciphertext BYTEA NOT NULL,
  iv BYTEA NOT NULL,
  content_digest BYTEA NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT direct_message_attachment_ciphertext_size CHECK (octet_length(ciphertext) BETWEEN 17 AND 5242896),
  CONSTRAINT direct_message_attachment_iv_size CHECK (octet_length(iv) = 12),
  CONSTRAINT direct_message_attachment_digest_size CHECK (octet_length(content_digest) = 32),
  CONSTRAINT direct_message_attachment_plain_size CHECK (size_bytes BETWEEN 1 AND 5242880)
);

CREATE OR REPLACE FUNCTION public.guard_direct_message_attachment_write()
RETURNS TRIGGER LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE
  v_message public.messages%ROWTYPE;
  v_first TEXT;
  v_second TEXT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'DIRECT_MESSAGE_ATTACHMENT_IMMUTABLE';
  END IF;
  SELECT * INTO v_message FROM public.messages WHERE id = NEW.message_id FOR KEY SHARE;
  IF NOT FOUND OR v_message.deleted_for_everyone_at IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'DIRECT_MESSAGE_ATTACHMENT_FORBIDDEN';
  END IF;
  SELECT participant_a_user_id, participant_b_user_id INTO v_first, v_second
    FROM public.conversations WHERE id = v_message.conversation_id FOR KEY SHARE;
  IF NOT FOUND OR v_message.sender_user_id NOT IN (v_first, v_second) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'DIRECT_MESSAGE_ATTACHMENT_FORBIDDEN';
  END IF;
  PERFORM public.require_active_direct_message_connection(v_first, v_second);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_direct_message_attachment_guard ON public.direct_message_attachments;
CREATE TRIGGER trg_direct_message_attachment_guard
  BEFORE INSERT OR UPDATE ON public.direct_message_attachments
  FOR EACH ROW EXECUTE FUNCTION public.guard_direct_message_attachment_write();

ALTER TABLE public.direct_message_attachments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS direct_message_attachments_deny_all ON public.direct_message_attachments;
CREATE POLICY direct_message_attachments_deny_all ON public.direct_message_attachments
  USING (false) WITH CHECK (false);
REVOKE ALL PRIVILEGES ON TABLE public.direct_message_attachments FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL PRIVILEGES ON TABLE public.direct_message_attachments FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL PRIVILEGES ON TABLE public.direct_message_attachments FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT SELECT, INSERT, DELETE ON TABLE public.direct_message_attachments TO service_role;
    GRANT EXECUTE ON FUNCTION public.guard_direct_message_attachment_write() TO service_role;
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.guard_direct_message_attachment_write() FROM PUBLIC;

COMMIT;
