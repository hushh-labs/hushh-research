-- Dev only. Configuration binds two fixed owners/projects; the existing provision
-- journal remains the sole operation authority. No policy row is seeded.
-- These are trusted-control-plane coordination guards, not a boundary against
-- the migration/runtime database administrator (currently the same SQL role).
BEGIN;

CREATE OR REPLACE FUNCTION public.valid_hosted_pod_pilot_assignments(assignments jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT CASE WHEN jsonb_typeof(assignments)='array' AND jsonb_array_length(assignments)=2
 THEN (SELECT count(DISTINCT a->>'ownerHash')=2
       AND count(DISTINCT a->>'hushhId')=2 AND count(DISTINCT a->>'project')=2
       AND count(DISTINCT a->>'projectNumber')=count(a->>'projectNumber')
       AND bool_and(jsonb_typeof(a)='object'
         AND a ?& ARRAY['ownerHash','hushhId','project','projectNumber','region']
         AND a - ARRAY['ownerHash','hushhId','project','projectNumber','region']='{}'::jsonb
         AND jsonb_typeof(a->'ownerHash')='string'
         AND a->>'ownerHash' ~ '^sha256:[a-f0-9]{64}$'
         AND jsonb_typeof(a->'hushhId')='string'
         AND a->>'hushhId' ~ '^[A-Za-z0-9_-]{1,128}$'
         AND jsonb_typeof(a->'project')='string'
         AND a->>'project' ~ '^[a-z][a-z0-9-]{4,28}[a-z0-9]$'
         AND (a->'projectNumber'='null'::jsonb OR (
           jsonb_typeof(a->'projectNumber')='string'
           AND a->>'projectNumber' ~ '^[1-9][0-9]{0,19}$'))
         AND jsonb_typeof(a->'region')='string'
         AND a->>'region' ~ '^[a-z]+-[a-z]+[0-9]+$')
       FROM jsonb_array_elements(assignments) AS a)
 ELSE false END;
$$;

CREATE TABLE IF NOT EXISTS public.hosted_pod_pilot_policy (
 singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
 policy_id uuid NOT NULL UNIQUE,
 environment text NOT NULL CHECK (environment='dev'),
 source_revision text NOT NULL CHECK (source_revision ~ '^[a-f0-9]{40}$'),
 image_digest text NOT NULL CHECK (image_digest ~ '^sha256:[a-f0-9]{64}$'),
 model_binding jsonb NOT NULL CHECK ((
   jsonb_typeof(model_binding)='object'
   AND model_binding ?& ARRAY['provider','model','project','profileHash']
   AND model_binding-ARRAY['provider','model','project','profileHash']='{}'::jsonb
   AND jsonb_typeof(model_binding->'provider')='string'
   AND jsonb_typeof(model_binding->'model')='string'
   AND jsonb_typeof(model_binding->'project')='string'
   AND jsonb_typeof(model_binding->'profileHash')='string'
   AND model_binding->>'provider'='gemini'
   AND model_binding->>'model' ~ '^gemini-[A-Za-z0-9._-]{1,100}$'
   AND model_binding->>'project' ~ '^[a-z][a-z0-9-]{4,28}[a-z0-9]$'
   AND model_binding->>'profileHash' ~ '^[a-f0-9]{64}$') IS TRUE),
 assignments jsonb NOT NULL CHECK (public.valid_hosted_pod_pilot_assignments(assignments) IS TRUE),
 attempt_a text CHECK (attempt_a ~ '^[a-f0-9]{32}$'),
 attempt_b text CHECK (attempt_b ~ '^[a-f0-9]{32}$'),
 CHECK (attempt_a IS NULL OR attempt_b IS NULL OR attempt_a<>attempt_b),
 work_budget_cents integer NOT NULL CHECK (work_budget_cents=40000),
 cleanup_reserve_cents integer NOT NULL CHECK (cleanup_reserve_cents=10000),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 CHECK (expires_at>created_at AND expires_at<=created_at+interval '7 days')
);
COMMENT ON TABLE public.hosted_pod_pilot_policy IS
 'One non-renewable $500 dev pilot allocation, including $100 cleanup. Each owner holds $200 work and $50 cleanup. Hash-only assignments; no credentials. Existing provisionAttempt owns operations. These ceilings are not measured usage or provider spend enforcement; billable activation requires bounded operation/cost admission.';

CREATE OR REPLACE FUNCTION public.guard_hosted_pod_pilot_policy()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF TG_OP='UPDATE' AND to_jsonb(NEW)-ARRAY['attempt_a','attempt_b'] =
    to_jsonb(OLD)-ARRAY['attempt_a','attempt_b'] THEN
   IF OLD.attempt_a IS NULL AND NEW.attempt_a IS NOT NULL
      AND NEW.attempt_b IS NOT DISTINCT FROM OLD.attempt_b
      AND current_setting('hussh.hosted_pilot_reservation',true)=
          NEW.policy_id::text || ':' || NEW.attempt_a THEN RETURN NEW; END IF;
   IF OLD.attempt_b IS NULL AND NEW.attempt_b IS NOT NULL
      AND NEW.attempt_a IS NOT DISTINCT FROM OLD.attempt_a
      AND current_setting('hussh.hosted_pilot_reservation',true)=
          NEW.policy_id::text || ':' || NEW.attempt_b THEN RETURN NEW; END IF;
 END IF;
 RAISE EXCEPTION 'hosted pod pilot allocation is retained' USING ERRCODE='42501';
END;
$$;
DROP TRIGGER IF EXISTS hosted_pod_pilot_policy_retained ON public.hosted_pod_pilot_policy;
CREATE TRIGGER hosted_pod_pilot_policy_retained BEFORE UPDATE OR DELETE
ON public.hosted_pod_pilot_policy FOR EACH ROW
EXECUTE FUNCTION public.guard_hosted_pod_pilot_policy();
DROP TRIGGER IF EXISTS hosted_pod_pilot_policy_truncate ON public.hosted_pod_pilot_policy;
CREATE TRIGGER hosted_pod_pilot_policy_truncate BEFORE TRUNCATE
ON public.hosted_pod_pilot_policy FOR EACH STATEMENT
EXECUTE FUNCTION public.guard_hosted_pod_pilot_policy();

CREATE OR REPLACE FUNCTION public.claim_hosted_pod_pilot_provision(
 owner_id text, attempt_id text, observed jsonb, desired jsonb
) RETURNS jsonb LANGUAGE plpgsql SET search_path=public AS $$
DECLARE
 policy public.hosted_pod_pilot_policy%ROWTYPE;
 assignment jsonb;
 slot integer;
 reservation jsonb;
 admission jsonb;
 prior_setting text;
BEGIN
 IF desired->>'deployment_target' IS DISTINCT FROM 'gcp' THEN
   RAISE EXCEPTION 'hosted pilot requires explicit managed placement' USING ERRCODE='42501';
 END IF;
 -- Retain the existing owner/erasure lock ordering before policy observation.
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 SELECT * INTO policy FROM public.hosted_pod_pilot_policy WHERE singleton FOR UPDATE;
 IF NOT FOUND OR policy.expires_at<=clock_timestamp()
    OR desired ?| ARRAY['user_cloud_project','user_cloud_region','user_cloud_bootstrap_sa']
 THEN RAISE EXCEPTION 'hosted pod pilot admission unavailable' USING ERRCODE='42501'; END IF;
 SELECT a,ordinality INTO assignment,slot FROM jsonb_array_elements(policy.assignments) WITH ORDINALITY AS entries(a,ordinality)
 WHERE a->>'ownerHash'='sha256:' || encode(digest(owner_id,'sha256'),'hex')
   AND a->>'hushhId'=desired->>'hushh_id';
 IF assignment IS NULL THEN
   RAISE EXCEPTION 'hosted pod owner is not admitted' USING ERRCODE='42501';
 END IF;
 IF (slot=1 AND policy.attempt_a IS NOT NULL) OR (slot=2 AND policy.attempt_b IS NOT NULL) THEN
   RAISE EXCEPTION 'hosted pilot attempt requires reconciliation' USING ERRCODE='42501';
 END IF;
 reservation := public.claim_personal_agent_provision(
   owner_id,attempt_id,observed,desired);
 admission := jsonb_build_object(
   'version',1,'policyId',policy.policy_id,'environment',policy.environment,
   'sourceRevision',policy.source_revision,'imageDigest',policy.image_digest,
   'modelBinding',policy.model_binding,
   'assignment',assignment,'workBudgetCents',policy.work_budget_cents/2,
   'cleanupReserveCents',policy.cleanup_reserve_cents/2,'expiresAt',policy.expires_at);
 reservation := reservation || jsonb_build_object('hostedAdmission',admission);
 prior_setting := current_setting('hussh.hosted_pilot_reservation',true);
 PERFORM set_config('hussh.hosted_pilot_reservation',policy.policy_id::text || ':' || attempt_id,true);
 UPDATE public.hosted_pod_pilot_policy
 SET attempt_a=CASE WHEN slot=1 THEN attempt_id ELSE attempt_a END,
     attempt_b=CASE WHEN slot=2 THEN attempt_id ELSE attempt_b END WHERE singleton;
 PERFORM set_config('hussh.hosted_pilot_reservation',coalesce(prior_setting,''),true);
 prior_setting := current_setting('hussh.provision_attempt',true);
 PERFORM set_config('hussh.provision_attempt',attempt_id,true);
 UPDATE public.personal_agent_registry SET backend_metadata=jsonb_set(
   backend_metadata,'{provisionAttempt}',reservation)
 WHERE user_id=owner_id AND backend_metadata->'provisionAttempt'->>'attemptId'=attempt_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'hosted pod reservation changed' USING ERRCODE='42501'; END IF;
 PERFORM set_config('hussh.provision_attempt',coalesce(prior_setting,''),true);
 RETURN reservation;
END;
$$;

-- Independently read back Resource Manager identity after project creation. Keep
-- policy assignments and spend slots immutable; the operation owns this fact.
CREATE OR REPLACE FUNCTION public.retain_hosted_pod_project_observation(
 owner_id text, attempt_id text, observation jsonb
) RETURNS boolean LANGUAGE plpgsql SET search_path=public AS $$
DECLARE
 r public.personal_agent_registry%ROWTYPE;
 p public.hosted_pod_pilot_policy%ROWTYPE;
 attempt jsonb;
 assignment jsonb;
 prior_setting text;
BEGIN
 IF jsonb_typeof(observation) IS DISTINCT FROM 'object'
 OR observation - ARRAY['projectId','projectNumber','lifecycleState'] <> '{}'::jsonb
 OR (observation ?& ARRAY['projectId','projectNumber','lifecycleState']) IS NOT TRUE
 OR jsonb_typeof(observation->'projectId') IS DISTINCT FROM 'string'
 OR jsonb_typeof(observation->'projectNumber') IS DISTINCT FROM 'string'
 OR (observation->>'projectNumber' ~ '^[1-9][0-9]{0,19}$') IS NOT TRUE
 OR observation->>'lifecycleState' IS DISTINCT FROM 'ACTIVE' THEN RETURN false; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 SELECT * INTO r FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 IF NOT FOUND OR r.deployment_target IS DISTINCT FROM 'gcp'
 OR r.backend_metadata ? 'erasure' THEN RETURN false; END IF;
 attempt := r.backend_metadata->'provisionAttempt';
 assignment := attempt->'hostedAdmission'->'assignment';
 IF attempt->>'ownerId' IS DISTINCT FROM owner_id
 OR attempt->>'attemptId' IS DISTINCT FROM attempt_id
 OR attempt->>'phase' IS DISTINCT FROM 'reserved'
 OR assignment->>'project' IS DISTINCT FROM observation->>'projectId'
 OR (assignment->>'projectNumber' IS NOT NULL AND
     assignment->>'projectNumber' IS DISTINCT FROM observation->>'projectNumber')
 THEN RETURN false; END IF;
 SELECT * INTO p FROM public.hosted_pod_pilot_policy WHERE singleton FOR UPDATE;
 IF NOT FOUND OR p.expires_at<=clock_timestamp()
 OR p.policy_id::text IS DISTINCT FROM attempt->'hostedAdmission'->>'policyId'
 OR p.source_revision IS DISTINCT FROM attempt->'hostedAdmission'->>'sourceRevision'
 OR p.image_digest IS DISTINCT FROM attempt->'hostedAdmission'->>'imageDigest'
 OR p.model_binding IS DISTINCT FROM attempt->'hostedAdmission'->'modelBinding'
 OR NOT EXISTS (
   SELECT 1 FROM jsonb_array_elements(p.assignments) WITH ORDINALITY AS x(a,n)
   WHERE a=assignment AND a->>'hushhId'=r.hushh_id
   AND a->>'ownerHash'='sha256:' || encode(digest(owner_id,'sha256'),'hex')
   AND CASE WHEN n=1 THEN p.attempt_a ELSE p.attempt_b END=attempt_id
 ) THEN RETURN false; END IF;
 IF attempt->'evidence'->'reserved' ? 'projectObservation' THEN
   RETURN attempt->'evidence'->'reserved'->'projectObservation'=observation;
 END IF;
 prior_setting := current_setting('hussh.provision_attempt',true);
 PERFORM set_config('hussh.provision_attempt',attempt_id,true);
 attempt := attempt || jsonb_build_object('evidence',coalesce(attempt->'evidence','{}'::jsonb) ||
   jsonb_build_object('reserved',coalesce(attempt->'evidence'->'reserved','{}'::jsonb) ||
     jsonb_build_object('projectObservation',observation)));
 UPDATE public.personal_agent_registry SET backend_metadata=jsonb_set(
   backend_metadata,'{provisionAttempt}',attempt),updated_at=clock_timestamp() WHERE user_id=owner_id;
 PERFORM set_config('hussh.provision_attempt',coalesce(prior_setting,''),true);
 RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.hosted_pod_pilot_admission_current(
 p_owner text, p_attempt text, p_admission jsonb, p_observation jsonb
) RETURNS boolean LANGUAGE sql SET search_path=public AS $$
 SELECT EXISTS (
              SELECT 1 FROM public.personal_agent_registry r
              JOIN public.hosted_pod_pilot_policy p ON p.singleton
              WHERE r.user_id=p_owner AND r.deployment_target='gcp'
                AND NOT (r.backend_metadata ? 'erasure')
                AND p.environment='dev' AND p.expires_at>clock_timestamp()
                AND r.backend_metadata->'provisionAttempt'->>'ownerId'=r.user_id
                AND r.backend_metadata->'provisionAttempt'->>'attemptId'=p_attempt
                AND r.backend_metadata->'provisionAttempt'->>'phase' IN
                  ('reserved','substrate','host_requested','host_acknowledged','connecting')
                AND r.backend_metadata->'provisionAttempt'->'hostedAdmission'=p_admission
                AND p.policy_id::text=p_admission->>'policyId'
                AND p.source_revision=p_admission->>'sourceRevision'
                AND p.image_digest=p_admission->>'imageDigest'
                AND p.model_binding=p_admission->'modelBinding'
                AND coalesce(r.backend_metadata->'provisionAttempt'->'evidence'->'reserved'->'projectObservation','null'::jsonb)=p_observation
                AND EXISTS (
                  SELECT 1 FROM jsonb_array_elements(p.assignments) WITH ORDINALITY AS x(a,n)
                  WHERE a=p_admission->'assignment'
                    AND a->>'hushhId'=r.hushh_id
                    AND a->>'ownerHash'='sha256:' || encode(digest(r.user_id,'sha256'),'hex')
                    AND CASE WHEN n=1 THEN p.attempt_a ELSE p.attempt_b END=p_attempt)
            );
$$;

COMMIT;
