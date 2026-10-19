-- Disable admission and end all calls through the service before rollback.
BEGIN;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM public.direct_calls WHERE state IN ('preparing','ringing','connecting','active')) THEN
  RAISE EXCEPTION 'DIRECT_CALLS_MUST_END_BEFORE_ROLLBACK';
 END IF;
END $$;
DROP TABLE IF EXISTS public.direct_call_signals;
DROP TABLE IF EXISTS public.direct_call_commands;
DROP TABLE IF EXISTS public.direct_call_slots;
DROP TABLE IF EXISTS public.direct_calls;
DROP TABLE IF EXISTS public.direct_communication_keys;
COMMIT;
