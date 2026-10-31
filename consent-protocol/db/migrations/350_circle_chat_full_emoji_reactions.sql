-- Expand reaction storage without changing membership, RLS, keys or erasure.
-- Apply before the full picker/backend rollout. Exact Unicode validation lives
-- in the shared catalogue; SQL bounds the size of this plaintext metadata.
BEGIN;
DO $$
DECLARE definition TEXT;
BEGIN
  SELECT pg_get_constraintdef(oid, true) INTO definition FROM pg_constraint
    WHERE conrelid = 'circle_chat_reactions'::regclass
      AND conname = 'circle_chat_reactions_emoji_check';
  IF definition IS NOT NULL AND definition <>
    'CHECK (emoji = ANY (ARRAY[''❤️''::text, ''😂''::text, ''😮''::text, ''😢''::text, ''👍''::text, ''🙏''::text]))' THEN
    RAISE EXCEPTION 'migration 350: unexpected legacy emoji constraint';
  END IF;
  SELECT pg_get_constraintdef(oid, true) INTO definition FROM pg_constraint
    WHERE conrelid = 'circle_chat_reactions'::regclass
      AND conname = 'circle_chat_reactions_emoji_length';
  IF definition IS NOT NULL AND definition <>
    'CHECK (char_length(emoji) >= 1 AND char_length(emoji) <= 16)' THEN
    RAISE EXCEPTION 'migration 350: unexpected emoji length constraint';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid = 'circle_chat_reactions'::regclass
      AND conname = 'circle_chat_reactions_emoji_length') THEN
    ALTER TABLE circle_chat_reactions ADD CONSTRAINT circle_chat_reactions_emoji_length
      CHECK (char_length(emoji) BETWEEN 1 AND 16) NOT VALID;
  END IF;
END $$;
ALTER TABLE circle_chat_reactions DROP CONSTRAINT IF EXISTS circle_chat_reactions_emoji_check;
ALTER TABLE circle_chat_reactions VALIDATE CONSTRAINT circle_chat_reactions_emoji_length;
COMMIT;
