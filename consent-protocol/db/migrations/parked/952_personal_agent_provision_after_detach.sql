-- Dev-only: admit provisioning for an Azure home and after a detached placement.
-- Replaces only the 946 claim function. `detach_placement` (2026-10-02) releases
-- a person's active placement but deliberately keeps their stable A2A route and
-- records the old host under `backend_metadata.detachedPlacements`, so a new home
-- can be set up and the old one resumed later. 946 refused exactly that row
-- ("requires reconciliation": a2a_route set, unexpected metadata key), so the
-- first live Azure attach after a detach failed (2026-10-05). Admit only the
-- route the newest detach recorded for the same identity, and a non-empty
-- detachedPlacements array; every other 946 refusal is unchanged. The claim's
-- upsert carries both forward untouched.
-- Second defect, same function: its insert row omitted the Azure coordinates,
-- and the 948 CHECK judges that proposed row before ON CONFLICT, so no Azure
-- home could ever be claimed. They are now copied from the observed row.
BEGIN;
CREATE OR REPLACE FUNCTION public.claim_personal_agent_provision(
  owner_id text, attempt_id text, observed jsonb, desired jsonb
) RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  current_row public.personal_agent_registry%ROWTYPE;
  expected_row public.personal_agent_registry%ROWTYPE;
  target public.personal_agent_registry%ROWTYPE;
  reservation jsonb;
  row_exists boolean;
BEGIN
  IF owner_id IS NULL OR btrim(owner_id) = '' OR attempt_id IS NULL
     OR attempt_id !~ '^[a-f0-9]{32}$' OR jsonb_typeof(desired) IS DISTINCT FROM 'object'
     OR desired->>'user_id' IS DISTINCT FROM owner_id
     OR coalesce(desired->>'hushh_id','') = ''
     OR coalesce(desired->>'phone_e164_hash','') = ''
     OR desired - ARRAY['user_id','hushh_id','phone_e164_hash','billing_space_id',
          'deployment_target','model_credential_mode','user_cloud_project',
          'user_cloud_region','user_cloud_bootstrap_sa','pod_pubkey','pod_key_id',
          'pod_key_wrapping_alg'] <> '{}'::jsonb THEN
    RAISE EXCEPTION 'invalid personal agent provision admission' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
  PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
  IF EXISTS (SELECT 1 FROM public.account_deletion_tombstones
      WHERE user_id_hash='sha256:' || encode(digest(owner_id,'sha256'),'hex')) THEN
    RAISE EXCEPTION 'personal agent owner deleted' USING ERRCODE='42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_registry'::regclass
      AND tgname='zy_personal_agent_provision_registry' AND tgenabled IN ('O','A')
      AND tgtype=27 AND tgnargs=0 AND tgqual IS NULL
      AND tgfoid='public.guard_personal_agent_provision_registry()'::regprocedure
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_registry'::regclass
      AND tgname='zz_personal_agent_erasure_registry' AND tgenabled IN ('O','A')
      AND tgtype=27 AND tgnargs=0 AND tgqual IS NULL
      AND tgfoid='public.guard_personal_agent_erasure_registry()'::regprocedure
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_registry'::regclass
      AND tgname='trg_reject_deleted_account_insert' AND tgenabled IN ('O','A')
      AND tgtype=7 AND tgnargs=1 AND tgqual IS NULL
      AND tgargs=decode('757365725f696400','hex') -- user_id, NUL-terminated trigger argument
      AND tgfoid='public.reject_deleted_account_identity_write()'::regprocedure
  ) THEN
    RAISE EXCEPTION 'personal agent provision guards unavailable' USING ERRCODE='42501';
  END IF;
  SELECT * INTO current_row FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
  row_exists := FOUND;
  IF row_exists THEN
    -- Cloud publication locks the setup job before the registry. If it owns
    -- that row, refuse immediately instead of waiting in the reverse order.
    PERFORM 1 FROM public.byoc_setup_jobs WHERE user_id=owner_id FOR UPDATE NOWAIT;
    IF jsonb_typeof(observed) IS DISTINCT FROM 'object'
       OR observed->>'user_id' IS DISTINCT FROM owner_id
       OR NOT (observed ?& ARRAY['user_id','hushh_id','status','backend_metadata',
           'external_agent_id','a2a_route','pod_pubkey','deployment_target',
           'user_cloud_project','user_cloud_region','user_cloud_bootstrap_sa',
           'user_cloud_authorized_at']) THEN
      RAISE EXCEPTION 'personal agent provision observation changed' USING ERRCODE='42501';
    END IF;
    expected_row := jsonb_populate_record(NULL::public.personal_agent_registry, observed);
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(observed) AS k(key)
               WHERE to_jsonb(current_row)->k.key IS DISTINCT FROM to_jsonb(expected_row)->k.key) THEN
      RAISE EXCEPTION 'personal agent provision observation changed' USING ERRCODE='42501';
    END IF;
    IF current_row.status NOT IN ('unprovisioned','pending','reaped','provisioning_failed')
       OR current_row.hushh_id IS DISTINCT FROM desired->>'hushh_id'
       OR current_row.external_agent_id IS NOT NULL
       -- A detached placement keeps the person's stable route; only that exact
       -- route, recorded by the newest detach for this identity, is admitted.
       OR (current_row.a2a_route IS NOT NULL AND (
         jsonb_typeof(current_row.backend_metadata->'detachedPlacements') IS DISTINCT FROM 'array'
         OR current_row.backend_metadata->'detachedPlacements'->-1->>'a2a_route'
              IS DISTINCT FROM current_row.a2a_route
         OR current_row.backend_metadata->'detachedPlacements'->-1->>'hushh_id'
              IS DISTINCT FROM current_row.hushh_id))
       OR current_row.pod_pubkey IS NOT NULL
       OR coalesce(current_row.backend_metadata,'{}'::jsonb)
            - ARRAY['observed','filesSetup','detachedPlacements'] <> '{}'::jsonb
       OR (current_row.backend_metadata ? 'detachedPlacements' AND (
         jsonb_typeof(current_row.backend_metadata->'detachedPlacements') IS DISTINCT FROM 'array'
         OR jsonb_array_length(current_row.backend_metadata->'detachedPlacements') = 0))
       OR (current_row.backend_metadata ? 'filesSetup' AND (
         jsonb_typeof(current_row.backend_metadata->'filesSetup') IS DISTINCT FROM 'object'
         OR (current_row.backend_metadata->'filesSetup')
              - ARRAY['version','enabled','project','bootstrapAccount','setupJobId'] <> '{}'::jsonb
         OR (
         current_row.deployment_target = 'user_gcp'
         AND current_row.user_cloud_project IS NOT NULL
         AND current_row.user_cloud_bootstrap_sa IS NOT NULL
         AND current_row.user_cloud_authorized_at IS NOT NULL
         AND current_row.backend_metadata->'filesSetup'->'version' = '1'::jsonb
         AND current_row.backend_metadata->'filesSetup'->'enabled' = 'true'::jsonb
         AND current_row.backend_metadata->'filesSetup'->>'project' = current_row.user_cloud_project
         AND current_row.backend_metadata->'filesSetup'->>'bootstrapAccount' = current_row.user_cloud_bootstrap_sa
         AND EXISTS (
           SELECT 1 FROM public.byoc_setup_jobs AS j
           WHERE j.user_id = owner_id
             AND j.job_id = current_row.backend_metadata->'filesSetup'->>'setupJobId'
             AND j.project_id = current_row.user_cloud_project
             AND j.status = 'recorded'
             AND j.stages @> '[{"stage":"files_selection","enabled":true,"version":1}]'::jsonb
         )
         ) IS NOT TRUE
       ))
       OR (current_row.deployment_target = 'user_gcp' AND EXISTS (
         SELECT 1 FROM public.byoc_setup_jobs AS j
         WHERE j.user_id = owner_id
           AND (j.status = 'running' OR
                (j.project_id = current_row.user_cloud_project AND j.status <> 'recorded'))
       )) THEN
      RAISE EXCEPTION 'personal agent provision requires reconciliation' USING ERRCODE='42501';
    END IF;
  ELSIF observed IS NOT NULL AND observed <> 'null'::jsonb THEN
    RAISE EXCEPTION 'personal agent provision observation changed' USING ERRCODE='42501';
  END IF;
  target := jsonb_populate_record(current_row, desired);
  IF row_exists AND current_row.backend_metadata ? 'filesSetup'
     AND (target.deployment_target IS DISTINCT FROM current_row.deployment_target
          OR target.model_credential_mode IS DISTINCT FROM current_row.model_credential_mode
          OR target.user_cloud_project IS DISTINCT FROM current_row.user_cloud_project
          OR target.user_cloud_region IS DISTINCT FROM current_row.user_cloud_region
          OR target.user_cloud_bootstrap_sa IS DISTINCT FROM current_row.user_cloud_bootstrap_sa) THEN
    RAISE EXCEPTION 'personal agent Files placement changed' USING ERRCODE='42501';
  END IF;
  reservation := jsonb_build_object('version',1,'ownerId',owner_id,'attemptId',attempt_id,
      'phase','reserved','intent',desired,'createdAt',clock_timestamp());
  INSERT INTO public.personal_agent_registry AS r (
    user_id,hushh_id,phone_e164_hash,billing_space_id,deployment_target,model_credential_mode,
    user_cloud_project,user_cloud_region,user_cloud_bootstrap_sa,pod_pubkey,pod_key_id,
    pod_key_wrapping_alg,status,backend_metadata,
    user_cloud_tenant_id,user_cloud_subscription_id,user_cloud_resource_group
  ) VALUES (
    owner_id,target.hushh_id,target.phone_e164_hash,target.billing_space_id,
    target.deployment_target,target.model_credential_mode,target.user_cloud_project,
    target.user_cloud_region,target.user_cloud_bootstrap_sa,target.pod_pubkey,
    target.pod_key_id,target.pod_key_wrapping_alg,'provisioning',
    coalesce(current_row.backend_metadata,'{}'::jsonb) || jsonb_build_object('provisionAttempt',reservation),
    -- CHECK constraints judge the proposed insert row before ON CONFLICT, so an
    -- Azure home's coordinates (948) must ride along; the update leaves them as-is.
    current_row.user_cloud_tenant_id,current_row.user_cloud_subscription_id,
    current_row.user_cloud_resource_group
  ) ON CONFLICT (user_id) DO UPDATE SET
    hushh_id=EXCLUDED.hushh_id,phone_e164_hash=EXCLUDED.phone_e164_hash,
    billing_space_id=EXCLUDED.billing_space_id,deployment_target=EXCLUDED.deployment_target,
    model_credential_mode=EXCLUDED.model_credential_mode,user_cloud_project=EXCLUDED.user_cloud_project,
    user_cloud_region=EXCLUDED.user_cloud_region,user_cloud_bootstrap_sa=EXCLUDED.user_cloud_bootstrap_sa,
    pod_pubkey=EXCLUDED.pod_pubkey,pod_key_id=EXCLUDED.pod_key_id,
    pod_key_wrapping_alg=EXCLUDED.pod_key_wrapping_alg,status='provisioning',
    backend_metadata=EXCLUDED.backend_metadata,updated_at=clock_timestamp()
    WHERE row_exists AND to_jsonb(r)=to_jsonb(current_row);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'personal agent provision observation changed' USING ERRCODE='42501';
  END IF;
  RETURN reservation;
END;
$$;
COMMIT;
