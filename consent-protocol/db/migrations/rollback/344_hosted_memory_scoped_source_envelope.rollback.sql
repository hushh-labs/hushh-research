-- Roll back application callers before dropping the scoped envelope table.
BEGIN;
DROP TRIGGER IF EXISTS erase_hosted_source_envelope_on_grant_change
  ON public.live_memory_hosted_pilot_grants;
DROP FUNCTION IF EXISTS public.erase_hosted_source_envelope_on_grant_change();
DROP TABLE IF EXISTS public.live_memory_hosted_source_envelopes;
ALTER TABLE public.live_memory_hosted_pilot_grants
  DROP CONSTRAINT IF EXISTS live_memory_hosted_pilot_source_id_shape;
ALTER TABLE public.live_memory_hosted_pilot_grants DROP COLUMN IF EXISTS source_id;
COMMIT;
