BEGIN;
DO $$ BEGIN
  IF to_regclass('public.direct_message_attachments') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.direct_message_attachments LIMIT 1) THEN
    RAISE EXCEPTION 'Cannot rollback direct-message attachments while attachment history exists';
  END IF;
END $$;
DROP TRIGGER IF EXISTS trg_direct_message_attachment_guard ON public.direct_message_attachments;
DROP FUNCTION IF EXISTS public.guard_direct_message_attachment_write();
DROP TABLE IF EXISTS public.direct_message_attachments;
COMMIT;
