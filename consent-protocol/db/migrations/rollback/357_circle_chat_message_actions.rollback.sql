-- Keep expanded storage once actions exist: dropping visibility or authenticated
-- reply references would restore hidden messages or make replies unreadable.
BEGIN;
LOCK TABLE circle_chat_messages, circle_chat_recipients IN ACCESS EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
      AND table_name = 'circle_chat_messages' AND column_name = 'reply_to_message_id') THEN
    IF EXISTS (SELECT 1 FROM circle_chat_messages WHERE reply_to_message_id IS NOT NULL
        OR revision > 0 OR edited_at IS NOT NULL OR deleted_for_everyone_at IS NOT NULL)
      OR EXISTS (SELECT 1 FROM circle_chat_recipients WHERE deleted_at IS NOT NULL) THEN
      RAISE EXCEPTION 'migration 357: message actions exist; retain expanded storage';
    END IF;
  END IF;
END $$;
ALTER TABLE circle_chat_recipients DROP COLUMN IF EXISTS deleted_at;
ALTER TABLE circle_chat_messages
  DROP COLUMN IF EXISTS reply_to_message_id,
  DROP COLUMN IF EXISTS revision,
  DROP COLUMN IF EXISTS edited_at,
  DROP COLUMN IF EXISTS deleted_for_everyone_at;
COMMIT;
