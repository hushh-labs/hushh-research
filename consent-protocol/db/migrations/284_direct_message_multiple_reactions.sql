-- Allow each participant to add more than one distinct reaction to a message.
-- Repeating the same reaction remains idempotent in the PUT service contract.

BEGIN;

ALTER TABLE public.direct_message_reactions
  DROP CONSTRAINT IF EXISTS direct_message_reactions_one_per_participant;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.direct_message_reactions'::regclass
      AND conname = 'direct_message_reactions_one_per_emoji'
  ) THEN
    ALTER TABLE public.direct_message_reactions
      ADD CONSTRAINT direct_message_reactions_one_per_emoji
      PRIMARY KEY (message_id, user_id, emoji);
  END IF;
END $$;

COMMIT;
