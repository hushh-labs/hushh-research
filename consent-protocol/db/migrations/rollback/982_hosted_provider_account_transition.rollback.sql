-- Remove only an unused 982 schema change. Any retained intent or settlement
-- requires forward recovery and permanently prevents this rollback.
BEGIN;

LOCK TABLE public.personal_agent_registry IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.personal_agent_deletion_tombstones IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.personal_agent_cloud_removals IN SHARE ROW EXCLUSIVE MODE;

DO $provider_account_transition_rollback_evidence$
BEGIN
 IF EXISTS(SELECT 1 FROM public.personal_agent_registry r
   WHERE r.backend_metadata->'provisionAttempt' ? 'providerAccountTransition'
      OR r.backend_metadata->'providerAccountTransitionHistory' IS NOT NULL)
 OR EXISTS(SELECT 1 FROM public.personal_agent_deletion_tombstones t
   WHERE position('providerAccountTransition' IN coalesce(t.metadata::text,''))>0)
 OR EXISTS(SELECT 1 FROM public.personal_agent_cloud_removals c
   WHERE position('providerAccountTransition' IN coalesce(c.archive::text,''))>0) THEN
  RAISE EXCEPTION 'provider account transition evidence requires forward recovery before rollback'
    USING ERRCODE='55000';
 END IF;
END;
$provider_account_transition_rollback_evidence$;

DO $provider_account_transition_archive_rollback$
DECLARE definition text; anchor text; replacement text;
BEGIN
 SELECT pg_get_functiondef('public.personal_agent_erasure_archive(jsonb,jsonb)'::regprocedure)
  INTO definition;
 anchor:=$anchor$'managedPrefixAbort',r->'managedPrefixAbort') ||
 jsonb_strip_nulls(jsonb_build_object(
  'providerAccountTransition',r->'registrySnapshot'->'backend_metadata'->'provisionAttempt'->'providerAccountTransition')) ELSE '{}'::jsonb END ||$anchor$;
 replacement:=$replacement$'managedPrefixAbort',r->'managedPrefixAbort') ELSE '{}'::jsonb END ||$replacement$;
 IF definition IS NULL OR position(anchor IN definition)=0
    OR length(definition)-length(replace(definition,anchor,''))<>length(anchor) THEN
  RAISE EXCEPTION 'Provider account transition archive rollback source shape changed';
 END IF;
 EXECUTE replace(definition,anchor,replacement);
 SELECT pg_get_functiondef('public.personal_agent_erasure_archive(jsonb,jsonb)'::regprocedure)
  INTO definition;
 IF definition IS NULL OR position('providerAccountTransition' IN definition)>0 THEN
  RAISE EXCEPTION 'Provider account transition archive rollback did not remove the receipt';
 END IF;
END;
$provider_account_transition_archive_rollback$;

DROP TRIGGER IF EXISTS zx_hosted_provider_account_transition_registry
 ON public.personal_agent_registry;
DROP FUNCTION IF EXISTS public.guard_hosted_provider_account_transition_registry();
DROP FUNCTION IF EXISTS public.record_hosted_provider_account_transition_intent(text,text,jsonb);
DROP FUNCTION IF EXISTS public.settle_hosted_provider_account_transition(text,text,bigint,text,jsonb);
DROP FUNCTION IF EXISTS public.valid_hosted_provider_account_transition_append(jsonb,jsonb);
DROP FUNCTION IF EXISTS public.valid_hosted_provider_account_transition(jsonb,jsonb);
DROP FUNCTION IF EXISTS public.valid_hosted_provider_account_transition_settlement(jsonb,jsonb);
DROP FUNCTION IF EXISTS public.valid_hosted_provider_account_transition_intent(jsonb,jsonb);

COMMIT;
