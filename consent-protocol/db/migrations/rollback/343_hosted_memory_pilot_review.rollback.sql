-- Roll application code back first. No paired worker exists in this pilot.
BEGIN;
DROP TABLE IF EXISTS public.live_memory_hosted_pilot_grants;
COMMIT;
