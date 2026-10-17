-- Roll back 951: restore 927's Google-only admission. Azure setup jobs are then
-- refused again at insert, so roll back only alongside a hub that no longer
-- starts Azure setups, and only while no Azure setup job is running.
BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.byoc_setup_jobs WHERE project_id LIKE '/subscriptions/%' AND status='running') THEN
    RAISE EXCEPTION 'an Azure setup job is running; let it finish before rolling back 951';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION public.assert_project_grant_admission(project_id text)
RETURNS void LANGUAGE plpgsql VOLATILE SET search_path=public AS $$
BEGIN
 IF project_id IS NULL OR project_id='' THEN RETURN; END IF;
 IF project_id !~ '^[a-z][a-z0-9-]{4,61}[a-z0-9]$' OR current_setting('transaction_isolation') <> 'read committed' THEN
  RAISE EXCEPTION 'project grant admission unavailable' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(project_id,205));
 IF EXISTS (SELECT 1 FROM public.personal_agent_registry r WHERE r.backend_metadata->'erasure'->'grantRelease'->>'project'=project_id) THEN
  RAISE EXCEPTION 'project grant release reserved' USING ERRCODE='42501'; END IF;
END;
$$;

COMMIT;
