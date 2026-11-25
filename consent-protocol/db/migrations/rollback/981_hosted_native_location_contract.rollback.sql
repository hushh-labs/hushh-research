-- Restore the exact 974 validator only while no 981-qualified evidence exists.
BEGIN;

LOCK TABLE public.personal_agent_registry IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.personal_agent_deletion_tombstones IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.personal_agent_cloud_removals IN SHARE ROW EXCLUSIVE MODE;

DO $native_location_rollback$
BEGIN
 IF EXISTS(SELECT 1 FROM public.personal_agent_registry
   WHERE position('fd515e3e2663485fbf0d97017227d88a69e8572a092cf48e975a39cc292b9ab7' IN coalesce(backend_metadata::text,''))>0)
 OR EXISTS(SELECT 1 FROM public.personal_agent_deletion_tombstones
   WHERE position('fd515e3e2663485fbf0d97017227d88a69e8572a092cf48e975a39cc292b9ab7' IN coalesce(metadata::text,''))>0)
 OR EXISTS(SELECT 1 FROM public.personal_agent_cloud_removals
   WHERE position('fd515e3e2663485fbf0d97017227d88a69e8572a092cf48e975a39cc292b9ab7' IN coalesce(archive::text,''))>0) THEN
  RAISE EXCEPTION 'native location contract evidence requires forward recovery before rollback';
 END IF;
END
$native_location_rollback$;

CREATE OR REPLACE FUNCTION public.valid_managed_prefix_memory_absence(c jsonb,observation jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $$
DECLARE catalogue jsonb:=observation->'locationCatalogue'; locations jsonb; coverage jsonb:=observation->'coverage';
 entry jsonb; identity jsonb; attempt text:=coalesce(c->>'provisionAttemptId',c->'projectIdentity'->'labels'->>'hussh-provision-attempt');
BEGIN
 IF jsonb_typeof(observation) IS DISTINCT FROM 'object'
 OR observation-ARRAY['projectNumber','locations','engines','complete','status','coverage','locationCatalogue']<>'{}'::jsonb
 OR observation->>'projectNumber' IS DISTINCT FROM c->>'projectNumber'
 OR observation->'engines' IS DISTINCT FROM '[]'::jsonb OR observation->'complete' IS DISTINCT FROM 'true'::jsonb
 OR observation->>'status' IS DISTINCT FROM 'observed_absent'
 OR jsonb_typeof(catalogue) IS DISTINCT FROM 'object'
 OR catalogue-ARRAY['projectNumber','locations','paginationComplete']<>'{}'::jsonb
 OR catalogue->>'projectNumber' IS DISTINCT FROM c->>'projectNumber'
 OR catalogue->'paginationComplete' IS DISTINCT FROM 'true'::jsonb
 OR jsonb_typeof(catalogue->'locations') IS DISTINCT FROM 'array'
 OR jsonb_typeof(coverage) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 IF jsonb_array_length(catalogue->'locations') NOT BETWEEN 1 AND 1024
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(catalogue->'locations') x
   WHERE jsonb_typeof(x)<>'string' OR (x#>>'{}' ~ '^[a-z][a-z0-9-]{0,62}$') IS NOT TRUE)
 OR (SELECT count(*)<>count(DISTINCT x) FROM jsonb_array_elements(catalogue->'locations') x) THEN RETURN false; END IF;
 SELECT jsonb_agg(x ORDER BY x) INTO locations FROM (
  SELECT DISTINCT x FROM jsonb_array_elements((catalogue->'locations')||jsonb_build_array('global',c->>'region')) t(x)
 ) names;
 IF observation->'locations' IS DISTINCT FROM locations
 OR jsonb_array_length(coverage)<>jsonb_array_length(locations)
 OR (SELECT count(*)<>count(DISTINCT x->>'location') FROM jsonb_array_elements(coverage) x)
 THEN RETURN false; END IF;
 FOR entry IN SELECT value FROM jsonb_array_elements(coverage) LOOP
  IF jsonb_typeof(entry) IS DISTINCT FROM 'object'
   OR entry->>'projectNumber' IS DISTINCT FROM c->>'projectNumber'
   OR NOT locations ? (entry->>'location') OR entry->>'apiVersion' IS DISTINCT FROM 'v1beta1'
   OR jsonb_typeof(entry->'observedAt') IS DISTINCT FROM 'string'
   OR length(entry->>'observedAt') NOT BETWEEN 20 AND 64
   OR (entry->>'observedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?(Z|[+]00:00)$') IS NOT TRUE
   OR jsonb_typeof(entry->'pages') IS DISTINCT FROM 'number' THEN RETURN false; END IF;
  IF entry->>'status'='listed_empty' THEN
   IF entry-ARRAY['location','status','apiVersion','observedAt','projectNumber','pages']<>'{}'::jsonb
    OR (entry->>'pages' ~ '^[1-9][0-9]{0,3}$') IS NOT TRUE THEN RETURN false; END IF;
  ELSIF entry->>'status'='not_applicable' THEN
   identity:=entry->'projectIdentity';
   IF entry->>'location' IS DISTINCT FROM 'ca' OR entry->'pages' IS DISTINCT FROM '0'::jsonb
    OR entry-ARRAY['location','status','apiVersion','observedAt','projectNumber','pages','providerContract','projectIdentity','endpointObservation']<>'{}'::jsonb
    OR (attempt ~ '^[a-f0-9]{32}$') IS NOT TRUE
    OR coalesce(c->>'project','') !~ '^[a-z][a-z0-9-]{4,28}[a-z0-9]$'
    OR entry->'providerContract' IS DISTINCT FROM jsonb_build_object(
      'sourceUrl','https://docs.cloud.google.com/gemini-enterprise-agent-platform/resources/agent-locations',
      'sourceLastUpdated','2026-10-26','snapshotSha256','040fd2ca7235d6b70df2531b15c18753ec1c3f8fd0c7571290de2ff9aca7b193',
      'qualificationExpiresAt','2026-10-31T00:00:00Z')
    OR jsonb_typeof(identity) IS DISTINCT FROM 'object'
    OR identity-ARRAY['projectId','projectNumber','createTime','lifecycleState','labels']<>'{}'::jsonb
    OR identity->>'projectId' IS DISTINCT FROM c->>'project'
    OR identity->>'projectNumber' IS DISTINCT FROM c->>'projectNumber'
    OR identity->>'lifecycleState' IS DISTINCT FROM 'ACTIVE'
    OR identity->'labels' IS DISTINCT FROM jsonb_build_object('created-by','hussh-one','tenancy','hussh-hosted',
      'hussh-environment','dev','hussh-provision-attempt',attempt)
    OR jsonb_typeof(identity->'createTime') IS DISTINCT FROM 'string'
    OR (identity->>'createTime' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?(Z|[+]00:00)$') IS NOT TRUE
    OR (identity->>'createTime')::timestamptz<'2026-10-26T00:00:00Z'::timestamptz
    OR (identity->>'createTime')::timestamptz>(entry->>'observedAt')::timestamptz
    OR (entry->>'observedAt')::timestamptz>='2026-10-31T00:00:00Z'::timestamptz
    OR entry->'endpointObservation' IS DISTINCT FROM jsonb_build_object('url',
      'https://ca-aiplatform.googleapis.com/v1beta1/projects/'||(c->>'project')||'/locations/ca/reasoningEngines',
      'httpStatus',404,'status','unavailable') THEN RETURN false; END IF;
  ELSE RETURN false;
  END IF;
 END LOOP;
 RETURN true;
EXCEPTION WHEN data_exception THEN RETURN false;
END;
$$;

COMMIT;
