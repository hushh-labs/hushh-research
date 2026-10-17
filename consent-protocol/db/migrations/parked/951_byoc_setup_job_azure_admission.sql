-- Dev-only: admit an Azure setup job under the project-grant fence (927).
--
-- PARKED (dev-only band, same contract as 900-950): out of
-- db/release_migration_manifest.json, applied only by the dev migration lane.
--
-- byoc_setup_jobs.project_id names where a setup job works. For Google Cloud it
-- is the project id; for an agent in the person's own Azure subscription it is
-- the resource group's ARM id, /subscriptions/<guid>/resourceGroups/<name>
-- (azure_setup_plan.group_id). 927's admission accepted only the Google Cloud
-- shape, so EVERY Azure setup was refused with "project grant admission
-- unavailable" before any Azure call: measured 2026-10-03 against the dev
-- registry on the first live Connect Azure run.
--
-- This widens the accepted shapes and changes nothing else: the same
-- read-committed requirement, the same per-target advisory lock (key 205), and
-- the same refusal while an erasure reserves the target's grant release.
-- Grant release itself (project_grant_release_is_exclusive, 935) stays
-- Google-only on purpose: Hussh holds no grant to release in a person's Azure
-- subscription, so an Azure target never reaches it.
BEGIN;

CREATE OR REPLACE FUNCTION public.assert_project_grant_admission(project_id text)
RETURNS void LANGUAGE plpgsql VOLATILE SET search_path=public AS $$
BEGIN
 IF project_id IS NULL OR project_id='' THEN RETURN; END IF;
 IF (project_id !~ '^[a-z][a-z0-9-]{4,61}[a-z0-9]$'
     AND project_id !~ '^/subscriptions/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/resourceGroups/[A-Za-z0-9_().-]{0,89}[A-Za-z0-9_()-]$')
 OR current_setting('transaction_isolation') <> 'read committed' THEN
  RAISE EXCEPTION 'project grant admission unavailable' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(project_id,205));
 IF EXISTS (SELECT 1 FROM public.personal_agent_registry r WHERE r.backend_metadata->'erasure'->'grantRelease'->>'project'=project_id) THEN
  RAISE EXCEPTION 'project grant release reserved' USING ERRCODE='42501'; END IF;
END;
$$;

COMMIT;
