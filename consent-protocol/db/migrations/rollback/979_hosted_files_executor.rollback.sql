-- Restore the exact 974 custody definitions only before any Hosted Files executor evidence exists.
-- Owner execution and erasure receipts are durable obligations; rollback keeps
-- the schema in place until those records have a forward recovery path.
BEGIN;

LOCK TABLE public.personal_agent_registry IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.personal_agent_deletion_tombstones IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.personal_agent_cloud_removals IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.hosted_files_executor_976_rollback_source IN ACCESS EXCLUSIVE MODE;

DO $hosted_files_executor_rollback$
DECLARE source record;
BEGIN
 IF (SELECT count(*) FROM public.hosted_files_executor_976_rollback_source)<>5 THEN
  RAISE EXCEPTION 'Hosted Files executor rollback source is incomplete'; END IF;
 IF EXISTS(SELECT 1 FROM public.personal_agent_registry
   WHERE backend_metadata ? 'hostedFilesExecutor'
      OR backend_metadata ? 'upgradeLeaseHost'
      OR backend_metadata->'erasure' ?| ARRAY['lateFilesExecutorExit','lateFilesReplacementIntent',
        'lateFilesProviderSettlement'])
 OR EXISTS(SELECT 1 FROM public.personal_agent_deletion_tombstones
   WHERE position('"hostedFilesExecutor"' IN coalesce(metadata::text,''))>0)
 OR EXISTS(SELECT 1 FROM public.personal_agent_cloud_removals
   WHERE position('"hostedFilesExecutor"' IN coalesce(archive::text,''))>0) THEN
  RAISE EXCEPTION 'Hosted Files executor evidence requires forward recovery before rollback';
 END IF;
 FOR source IN SELECT definition FROM public.hosted_files_executor_976_rollback_source
  ORDER BY signature LOOP
  EXECUTE source.definition;
 END LOOP;
END;
$hosted_files_executor_rollback$;

DROP FUNCTION public.hosted_files_queue_erasure_settled(jsonb);
DROP FUNCTION public.finish_hosted_files_executor(text,text,text);
DROP FUNCTION public.record_hosted_files_provider_settlement(text,text,text,jsonb);
DROP FUNCTION public.record_hosted_files_replacement_intent(text,text,text,text,jsonb);
DROP FUNCTION public.resume_hosted_files_executor(text,jsonb,jsonb,timestamptz,timestamptz,jsonb,text,jsonb,jsonb,text,text,text);
DROP FUNCTION public.begin_hosted_files_executor(text,jsonb,jsonb,timestamptz,timestamptz,jsonb,text,text,text,jsonb,text,text);
DROP FUNCTION public.hosted_files_executor_registry_guard(jsonb,jsonb,text);
DROP FUNCTION public.valid_hosted_files_queue_retry(jsonb,jsonb,jsonb,text,text,text);
DROP FUNCTION public.valid_hosted_files_previous_success(jsonb,jsonb);
DROP FUNCTION public.valid_hosted_files_previous_failure(jsonb,jsonb);
DROP FUNCTION public.valid_hosted_files_previous_terminal(jsonb,jsonb);
DROP FUNCTION public.valid_hosted_files_no_dispatch(jsonb,jsonb);
DROP FUNCTION public.valid_hosted_files_provider_settlement(text,text,jsonb,jsonb,jsonb);
DROP FUNCTION public.valid_hosted_files_executor_exit(jsonb,jsonb,jsonb);
DROP FUNCTION public.valid_hosted_files_replacement_intent(jsonb,jsonb,jsonb);
DROP FUNCTION public.hosted_files_executor_session_active(text);
DROP FUNCTION public.hosted_files_executor_owner_locks_held(text);
DROP FUNCTION public.hosted_files_executor_session_held(text,jsonb);
DROP FUNCTION public.hosted_files_upgrade_host_binding(jsonb);
DROP TABLE public.hosted_files_executor_976_rollback_source;

COMMIT;
