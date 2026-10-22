-- Down path for 284_direct_message_multiple_reactions.sql.
-- Refuse to collapse distinct reactions into one participant row.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.direct_message_reactions
    GROUP BY message_id, user_id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'Cannot rollback multiple direct-message reactions while distinct reactions exist';
  END IF;

  ALTER TABLE public.direct_message_reactions
    DROP CONSTRAINT IF EXISTS direct_message_reactions_one_per_emoji;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.direct_message_reactions'::regclass
      AND conname = 'direct_message_reactions_one_per_participant'
  ) THEN
    ALTER TABLE public.direct_message_reactions
      ADD CONSTRAINT direct_message_reactions_one_per_participant
      PRIMARY KEY (message_id, user_id);
  END IF;
END $$;
