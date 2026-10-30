-- Down path for 264_direct_messages.sql.
--
-- Conversation history is private data.  Refuse a destructive schema rollback
-- when it would discard any encrypted conversation or message row.  Operators
-- must first take an approved preservation/export decision rather than using a
-- rollback as an account-history delete path.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.messages') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.messages LIMIT 1) THEN
    RAISE EXCEPTION 'Cannot rollback direct messages while message history exists';
  END IF;
  IF to_regclass('public.conversations') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.conversations LIMIT 1) THEN
    RAISE EXCEPTION 'Cannot rollback direct messages while conversation history exists';
  END IF;
  IF to_regclass('public.direct_message_blocks') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.direct_message_blocks LIMIT 1) THEN
    RAISE EXCEPTION 'Cannot rollback direct messages while block state exists';
  END IF;
END $$;

DROP TABLE IF EXISTS public.messages;
DROP TABLE IF EXISTS public.conversations;
DROP TABLE IF EXISTS public.direct_message_blocks;

DROP FUNCTION IF EXISTS public.notify_direct_message_recipient();
DROP FUNCTION IF EXISTS public.touch_direct_message_conversation();
DROP FUNCTION IF EXISTS public.guard_direct_message_message_write();
DROP FUNCTION IF EXISTS public.guard_direct_message_conversation_write();
DROP FUNCTION IF EXISTS public.guard_direct_message_block_write();
DROP FUNCTION IF EXISTS public.require_active_direct_message_connection(TEXT, TEXT);

DO $$
BEGIN
  IF to_regprocedure('public.install_account_deletion_write_guards()') IS NOT NULL THEN
    PERFORM public.install_account_deletion_write_guards();
  END IF;
END $$;

COMMIT;
