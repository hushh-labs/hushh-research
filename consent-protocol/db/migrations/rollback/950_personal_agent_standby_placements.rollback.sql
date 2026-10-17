-- Roll back 950 only while no standby exists and no person has ever been switched:
-- dropping a standby row would forget a live agent in someone's cloud, and dropping
-- the epoch after a switch would let a returning old primary write again.
-- Pair with a hub that no longer reads placement_epoch or the standby table.
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.personal_agent_standby_placements') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.personal_agent_standby_placements) THEN
    RAISE EXCEPTION 'standby placements must be removed before 950 is rolled back';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'personal_agent_registry'
      AND column_name = 'placement_epoch'
  ) AND EXISTS (SELECT 1 FROM public.personal_agent_registry WHERE placement_epoch > 0) THEN
    RAISE EXCEPTION 'switched placements exist (placement_epoch > 0); 950 cannot be rolled back';
  END IF;
END;
$$;

DROP TABLE IF EXISTS public.personal_agent_standby_placements;
DROP FUNCTION IF EXISTS public.guard_personal_agent_standby_placement();

ALTER TABLE public.personal_agent_registry
  DROP CONSTRAINT IF EXISTS personal_agent_registry_placement_epoch_check;
ALTER TABLE public.personal_agent_registry
  DROP COLUMN IF EXISTS placement_epoch;

COMMIT;
