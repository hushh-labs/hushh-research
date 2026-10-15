-- Refuse a lossy rollback. Keep the expanded schema if any newer reaction exists.
BEGIN;
LOCK TABLE circle_chat_reactions IN ACCESS EXCLUSIVE MODE;
DO $$
DECLARE definition TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM circle_chat_reactions
    WHERE emoji NOT IN ('❤️', '😂', '😮', '😢', '👍', '🙏')) THEN
    RAISE EXCEPTION 'migration 350: newer emoji reactions exist; retain expanded storage';
  END IF;
  SELECT pg_get_constraintdef(oid, true) INTO definition FROM pg_constraint
    WHERE conrelid = 'circle_chat_reactions'::regclass
      AND conname = 'circle_chat_reactions_emoji_check';
  IF definition IS NOT NULL AND definition <>
    'CHECK (emoji = ANY (ARRAY[''❤️''::text, ''😂''::text, ''😮''::text, ''😢''::text, ''👍''::text, ''🙏''::text]))' THEN
    RAISE EXCEPTION 'migration 350: unexpected legacy emoji constraint';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid = 'circle_chat_reactions'::regclass
      AND conname = 'circle_chat_reactions_emoji_check') THEN
    ALTER TABLE circle_chat_reactions ADD CONSTRAINT circle_chat_reactions_emoji_check
      CHECK (emoji IN ('❤️', '😂', '😮', '😢', '👍', '🙏'));
  END IF;
END $$;
ALTER TABLE circle_chat_reactions DROP CONSTRAINT IF EXISTS circle_chat_reactions_emoji_length;
COMMIT;
