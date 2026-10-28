-- Dev only. Configuration binds two fixed owners/projects; the existing provision
-- journal remains the sole operation authority. No policy row is seeded.
-- These are trusted-control-plane coordination guards, not a boundary against
-- the migration/runtime database administrator (currently the same SQL role).
BEGIN;

CREATE OR REPLACE FUNCTION public.valid_hosted_preparation_contract(value jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT CASE WHEN jsonb_typeof(value)='object' THEN coalesce(
 value ?& ARRAY['parentType','parentId','billingAccount','operatorPrincipal','projectedWorkCents','steps']
 AND value-ARRAY['parentType','parentId','billingAccount','operatorPrincipal','projectedWorkCents','steps']='{}'::jsonb
 AND value->>'parentType'='folder'
 AND jsonb_typeof(value->'parentId')='string' AND value->>'parentId' ~ '^[1-9][0-9]{0,19}$'
 AND jsonb_typeof(value->'billingAccount')='string'
 AND value->>'billingAccount' ~ '^billingAccounts/[A-Z0-9]{6}-[A-Z0-9]{6}-[A-Z0-9]{6}$'
 AND jsonb_typeof(value->'operatorPrincipal')='string'
 AND value->>'operatorPrincipal' ~ '^(user|serviceAccount):[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+[.][A-Za-z]{2,}$'
 AND jsonb_typeof(value->'projectedWorkCents')='number'
 AND value->>'projectedWorkCents' ~ '^[0-9]{1,5}$'
 AND CASE WHEN jsonb_typeof(value->'projectedWorkCents')='number' AND value->>'projectedWorkCents' ~ '^[0-9]{1,5}$'
     THEN (value->>'projectedWorkCents')::numeric BETWEEN 1 AND 20000 ELSE false END
 AND value->'steps'='["create_project","link_billing","authorize_project","inference_vertex","inference_quota"]'::jsonb,
 false) ELSE false END;
$$;

CREATE OR REPLACE FUNCTION public.valid_hosted_bootstrap_contract(value jsonb, project text, region text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT CASE WHEN jsonb_typeof(value)='object' AND value ?& ARRAY['plan','steps']
   AND value-ARRAY['plan','steps']='{}'::jsonb
   AND jsonb_typeof(value->'plan')='object' AND jsonb_typeof(value->'steps')='array'
   AND octet_length(value::text)<=49152
 THEN coalesce(value->'plan'->'target'=jsonb_build_object('project',project,'region',region)
   AND value->'plan'->>'tenancy'='hussh-hosted'
   AND jsonb_array_length(value->'steps') BETWEEN 1 AND 64
   AND (SELECT count(*)=count(DISTINCT entry) AND bool_and(
       jsonb_typeof(entry)='string' AND entry#>>'{}' ~ '^[a-z][a-z0-9_]{0,100}$')
       FROM jsonb_array_elements(value->'steps') entry),false)
 ELSE false END;
$$;

CREATE OR REPLACE FUNCTION public.valid_hosted_pod_pilot_assignments(assignments jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT CASE WHEN jsonb_typeof(assignments)='array' AND jsonb_array_length(assignments)=2
 THEN (SELECT count(DISTINCT a->>'ownerHash')=2
       AND count(DISTINCT a->>'hushhId')=2 AND count(DISTINCT a->>'project')=2
       AND count(DISTINCT a->>'projectNumber')=count(a->>'projectNumber')
       AND bool_and(jsonb_typeof(a)='object'
         AND a ?& ARRAY['ownerHash','hushhId','project','projectNumber','region']
         AND a - ARRAY['ownerHash','hushhId','project','projectNumber','region','bootstrapContract','preparationContract']='{}'::jsonb
         AND (NOT (a ? 'preparationContract') OR public.valid_hosted_preparation_contract(a->'preparationContract'))
         AND (NOT (a ? 'bootstrapContract') OR public.valid_hosted_bootstrap_contract(
           a->'bootstrapContract',a->>'project',a->>'region'))
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
 current_row public.personal_agent_registry%ROWTYPE;
 expected_row public.personal_agent_registry%ROWTYPE;
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
   SELECT * INTO current_row FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
   reservation:=current_row.backend_metadata->'provisionAttempt';
   IF NOT FOUND OR jsonb_typeof(observed) IS DISTINCT FROM 'object'
   OR observed->>'user_id' IS DISTINCT FROM owner_id
   OR NOT (observed ?& ARRAY['user_id','hushh_id','status','backend_metadata',
       'external_agent_id','a2a_route','pod_pubkey','deployment_target',
       'user_cloud_project','user_cloud_region','user_cloud_bootstrap_sa','user_cloud_authorized_at'])
   OR current_row.status NOT IN ('provisioning','connecting')
   OR current_row.backend_metadata ? 'erasure'
   OR reservation->>'ownerId' IS DISTINCT FROM owner_id
   OR reservation->>'attemptId' IS DISTINCT FROM attempt_id
   OR (CASE WHEN slot=1 THEN policy.attempt_a ELSE policy.attempt_b END) IS DISTINCT FROM attempt_id
   OR reservation->>'phase' NOT IN ('reserved','substrate','host_requested','host_acknowledged','connecting')
   OR reservation->'intent' IS DISTINCT FROM desired
   OR reservation->'hostedAdmission'->'assignment' IS DISTINCT FROM assignment
   OR reservation->'hostedAdmission'->>'policyId' IS DISTINCT FROM policy.policy_id::text
   OR reservation->'hostedAdmission'->>'sourceRevision' IS DISTINCT FROM policy.source_revision
   OR reservation->'hostedAdmission'->>'imageDigest' IS DISTINCT FROM policy.image_digest
   OR reservation->'hostedAdmission'->'modelBinding' IS DISTINCT FROM policy.model_binding
   OR reservation->'evidence'->'reserved'->'hostedCheckpoint'->>'phase'='intent'
   OR reservation->'evidence'->'reserved'->'hostedPreparation'->>'phase'='intent'
   OR EXISTS(SELECT 1 FROM public.account_deletion_tombstones
      WHERE user_id_hash='sha256:'||encode(digest(owner_id,'sha256'),'hex')) THEN
     RAISE EXCEPTION 'hosted pilot attempt requires reconciliation' USING ERRCODE='42501';
   END IF;
   expected_row:=jsonb_populate_record(NULL::public.personal_agent_registry,observed);
   IF EXISTS(SELECT 1 FROM jsonb_object_keys(observed) AS k(key)
       WHERE to_jsonb(current_row)->k.key IS DISTINCT FROM to_jsonb(expected_row)->k.key)
   OR (SELECT count(*) FROM pg_trigger WHERE tgrelid='public.personal_agent_registry'::regclass
       AND tgenabled IN ('O','A') AND tgtype=27 AND tgnargs=0 AND tgqual IS NULL AND
       ((tgname='zy_personal_agent_provision_registry' AND tgfoid='public.guard_personal_agent_provision_registry()'::regprocedure)
        OR (tgname='zz_personal_agent_erasure_registry' AND tgfoid='public.guard_personal_agent_erasure_registry()'::regprocedure)))<>2
   OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_registry'::regclass
       AND tgname='trg_reject_deleted_account_insert' AND tgenabled IN ('O','A')
       AND tgtype=7 AND tgnargs=1 AND tgqual IS NULL AND tgargs=decode('757365725f696400','hex')
       AND tgfoid='public.reject_deleted_account_identity_write()'::regprocedure)
   THEN RAISE EXCEPTION 'hosted pilot attempt requires reconciliation' USING ERRCODE='42501'; END IF;
   RETURN reservation;
 END IF;
 reservation := public.claim_personal_agent_provision(
   owner_id,attempt_id,observed,desired);
 admission := jsonb_build_object(
   'version',1,'policyId',policy.policy_id,'environment',policy.environment,
   'sourceRevision',policy.source_revision,'imageDigest',policy.image_digest,
   'modelBinding',policy.model_binding,
   'assignment',assignment,'workBudgetCents',policy.work_budget_cents/2,
   'cleanupReserveCents',policy.cleanup_reserve_cents/2,'expiresAt',policy.expires_at);
 IF assignment ? 'bootstrapContract' THEN
   admission := admission || jsonb_build_object('bootstrapContractHash',
     encode(digest((assignment->'bootstrapContract')::text,'sha256'),'hex'));
 END IF;
 IF assignment ? 'preparationContract' THEN
   admission := admission || jsonb_build_object('preparationContractHash',
     encode(digest((assignment->'preparationContract')::text,'sha256'),'hex'));
 END IF;
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
 IF NOT FOUND
 -- Expiry stops new work, not retention of an already acknowledged creation.
 OR (p.expires_at<=clock_timestamp() AND NOT (
   attempt->'evidence'->'reserved'->'hostedPreparation'->>'phase'='observed'
   AND attempt->'evidence'->'reserved'->'hostedPreparation'->>'planDigest'=
       attempt->'hostedAdmission'->>'preparationContractHash'
   AND public.valid_hosted_preparation_result(attempt,
       attempt->'evidence'->'reserved'->'hostedPreparation'->'completed'->0) IS TRUE
   AND attempt->'evidence'->'reserved'->'hostedPreparation'->'completed'->0->>'step'='create_project'
   AND attempt->'evidence'->'reserved'->'hostedPreparation'->'completed'->0->'ok'='true'::jsonb
   AND observation=jsonb_build_object('projectId',
       attempt->'evidence'->'reserved'->'hostedPreparation'->'completed'->0->'resourceObservation'->'identity'->>'projectId',
       'projectNumber',attempt->'evidence'->'reserved'->'hostedPreparation'->'completed'->0->'resourceObservation'->'identity'->>'projectNumber',
       'lifecycleState','ACTIVE')
 ) IS TRUE)
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
                AND r.status IN ('provisioning','connecting')
                AND NOT (r.backend_metadata ? 'erasure')
                AND NOT EXISTS(SELECT 1 FROM public.account_deletion_tombstones t
                    WHERE t.user_id_hash='sha256:'||encode(digest(p_owner,'sha256'),'hex'))
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

-- One serialized bootstrap step in the existing operation. A duplicate intent
-- never authorizes a second mutation; a duplicate observed receipt is harmless.
CREATE OR REPLACE FUNCTION public.valid_hosted_policy_observation(
 observation jsonb, resource text, wanted_role text, wanted_member text, wanted_step text
) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT CASE WHEN jsonb_typeof(observation)='object' THEN coalesce(
 observation-ARRAY['step','policyResource','role','member','disposition','beforeEtag','afterEtag']='{}'::jsonb
 AND observation->>'step'=wanted_step AND observation->>'policyResource'=resource
 AND observation->>'role'=wanted_role AND observation->>'member'=wanted_member
 AND observation->>'disposition' IN ('added','already_present')
 AND (SELECT count(*)=7 AND bool_and(jsonb_typeof(x.value)='string' AND length(x.value#>>'{}') BETWEEN 1 AND 2048)
      FROM jsonb_each(observation) x)
 AND length(observation->>'beforeEtag')<=512 AND length(observation->>'afterEtag')<=512,
 false) ELSE false END;
$$;

CREATE OR REPLACE FUNCTION public.valid_hosted_preparation_result(attempt jsonb, result jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $$
DECLARE
 admission jsonb:=attempt->'hostedAdmission'; assignment jsonb:=admission->'assignment';
 contract jsonb:=assignment->'preparationContract'; plan jsonb:=assignment->'bootstrapContract'->'plan';
 project text:=assignment->>'project'; step text:=result->>'step'; identity jsonb; binding jsonb;
 bootstrap text:=plan->'federation'->'impersonation'->>'bootstrap_service_account';
 caller text:=plan->'federation'->'impersonation'->>'granted_to'; role text; observation jsonb;
BEGIN
 IF jsonb_typeof(result) IS DISTINCT FROM 'object'
 OR result-ARRAY['step','status','ok','resourceObservation','billingObservation','authorizationReceipt','bindingObservations']<>'{}'::jsonb
 OR jsonb_typeof(result->'ok') IS DISTINCT FROM 'boolean'
 THEN RETURN false; END IF;
 IF result->'ok'='true'::jsonb AND (result->>'status' IN ('200','201','202','204')) IS NOT TRUE THEN RETURN false; END IF;
 IF result->'ok'='false'::jsonb THEN
  RETURN result-ARRAY['step','status','ok']='{}'::jsonb;
 END IF;
 CASE step
 WHEN 'create_project' THEN
  observation:=result->'resourceObservation'; identity:=observation->'identity';
  RETURN coalesce(result-ARRAY['step','status','ok','resourceObservation']='{}'::jsonb
   AND observation-ARRAY['type','id','disposition','identity']='{}'::jsonb
   AND observation->>'type'='gcp_project' AND observation->>'id'=project
   AND observation->>'disposition'='created'
   AND identity->>'projectId'=project AND identity->>'projectNumber' ~ '^[1-9][0-9]{0,19}$'
   AND identity->>'lifecycleState'='ACTIVE'
   AND identity->'parent'=jsonb_build_object('type',contract->>'parentType','id',contract->>'parentId')
   AND identity->'labels'=jsonb_build_object('created-by','hussh-one','tenancy','hussh-hosted',
       'hussh-environment','dev','hussh-provision-attempt',attempt->>'attemptId'),false);
 WHEN 'link_billing' THEN
  RETURN coalesce(result-ARRAY['step','status','ok','billingObservation']='{}'::jsonb
   AND result->'billingObservation'=jsonb_build_object('projectId',project,
       'billingAccountName',contract->>'billingAccount','billingEnabled',true),false);
 WHEN 'authorize_project' THEN
  identity:=result->'authorizationReceipt'->'bootstrapIdentity';
  binding:=result->'authorizationReceipt'->'bindingObservation';
  RETURN coalesce(result-ARRAY['step','status','ok','authorizationReceipt']='{}'::jsonb
   AND (result->'authorizationReceipt')-ARRAY['bootstrapIdentity','bindingObservation']='{}'::jsonb
   AND identity-ARRAY['name','email','projectId','uniqueId']='{}'::jsonb
   AND identity->>'projectId'=project AND identity->>'email'=bootstrap
   AND identity->>'uniqueId' ~ '^[1-9][0-9]{0,31}$'
   AND identity->>'name' IN ('projects/'||project||'/serviceAccounts/'||bootstrap,
       'projects/'||project||'/serviceAccounts/'||(identity->>'uniqueId'))
   AND public.valid_hosted_policy_observation(binding,
       'https://iam.googleapis.com/v1/projects/'||project||'/serviceAccounts/'||bootstrap||':getIamPolicy',
       'roles/iam.serviceAccountTokenCreator','serviceAccount:'||caller,'authorize_bootstrap_impersonation'),false);
 WHEN 'inference_vertex','inference_quota' THEN
  IF jsonb_typeof(result->'bindingObservations') IS DISTINCT FROM 'array'
   OR jsonb_array_length(result->'bindingObservations')<>1 THEN RETURN false; END IF;
  identity:=result->'resourceObservation'->'identity'; binding:=result->'bindingObservations'->0;
  role:=CASE step WHEN 'inference_vertex' THEN 'roles/aiplatform.user' ELSE 'roles/serviceusage.serviceUsageConsumer' END;
  RETURN coalesce(result-ARRAY['step','status','ok','resourceObservation','bindingObservations']='{}'::jsonb
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(attempt->'evidence'->'reserved'->'hostedCheckpoint'->'completed') x
       WHERE x->>'step'='pod_service_account' AND x->'ok'='true'::jsonb
       AND x->'resourceObservation'=result->'resourceObservation')
   AND identity->>'projectId'=project
   AND public.valid_hosted_policy_observation(binding,
       'https://cloudresourcemanager.googleapis.com/v1/projects/'||(admission->'modelBinding'->>'project')||':getIamPolicy',
       role,'serviceAccount:'||(identity->>'email'),step),false);
 ELSE RETURN false;
 END CASE;
END;
$$;

CREATE OR REPLACE FUNCTION public.publish_hosted_pod_step_checkpoint(
 p_owner text, p_attempt text, checkpoint jsonb, checkpoint_kind text
) RETURNS boolean LANGUAGE plpgsql SET search_path=public AS $$
DECLARE
 r public.personal_agent_registry%ROWTYPE;
 attempt jsonb;
 admission jsonb;
 prior jsonb;
 contract jsonb;
 expected integer;
 prior_results jsonb;
 results jsonb;
 result jsonb;
 prior_setting text;
 journal_key text;
 contract_hash text;
BEGIN
 IF checkpoint_kind NOT IN ('bootstrap','preparation') OR checkpoint_kind IS NULL THEN RETURN false; END IF;
 journal_key:=CASE WHEN checkpoint_kind='bootstrap' THEN 'hostedCheckpoint' ELSE 'hostedPreparation' END;
 IF jsonb_typeof(checkpoint) IS DISTINCT FROM 'object'
 OR octet_length(checkpoint::text)>65536
 OR checkpoint-ARRAY['version','ownerId','attemptId','expectedGeneration','generation',
     'planDigest','phase','step','completed']<>'{}'::jsonb
 OR (checkpoint ?& ARRAY['version','ownerId','attemptId','expectedGeneration','generation',
     'planDigest','phase','step','completed']) IS NOT TRUE
 OR checkpoint->'version' IS DISTINCT FROM '1'::jsonb
 OR checkpoint->>'ownerId' IS DISTINCT FROM p_owner
 OR checkpoint->>'attemptId' IS DISTINCT FROM p_attempt
 OR (checkpoint->>'phase' IN ('intent','observed')) IS NOT TRUE
 OR jsonb_typeof(checkpoint->'step') IS DISTINCT FROM 'string'
 OR (checkpoint->>'step' ~ '^[a-z][a-z0-9_]{0,100}$') IS NOT TRUE
 OR jsonb_typeof(checkpoint->'planDigest') IS DISTINCT FROM 'string'
 OR jsonb_typeof(checkpoint->'expectedGeneration') IS DISTINCT FROM 'number'
 OR jsonb_typeof(checkpoint->'generation') IS DISTINCT FROM 'number'
 OR (checkpoint->>'expectedGeneration' ~ '^[0-9]{1,4}$') IS NOT TRUE
 OR (checkpoint->>'generation' ~ '^[1-9][0-9]{0,3}$') IS NOT TRUE
 OR jsonb_typeof(checkpoint->'completed') IS DISTINCT FROM 'array'
 THEN RETURN false; END IF;
 expected := (checkpoint->>'expectedGeneration')::integer;
 IF (checkpoint->>'generation')::integer<>expected+1 THEN RETURN false; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_owner,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(p_owner,198));
 SELECT * INTO r FROM public.personal_agent_registry WHERE user_id=p_owner FOR UPDATE;
 IF NOT FOUND OR r.deployment_target IS DISTINCT FROM 'gcp'
 OR r.backend_metadata ? 'erasure' THEN RETURN false; END IF;
 attempt := r.backend_metadata->'provisionAttempt';
 admission := attempt->'hostedAdmission';
 prior := attempt->'evidence'->'reserved'->journal_key;
 contract := admission->'assignment'->CASE WHEN checkpoint_kind='bootstrap' THEN 'bootstrapContract' ELSE 'preparationContract' END;
 contract_hash := admission->>CASE WHEN checkpoint_kind='bootstrap' THEN 'bootstrapContractHash' ELSE 'preparationContractHash' END;
 IF attempt->>'ownerId' IS DISTINCT FROM p_owner
 OR attempt->>'attemptId' IS DISTINCT FROM p_attempt
 OR attempt->>'phase' IS DISTINCT FROM 'reserved'
 OR (CASE WHEN checkpoint_kind='bootstrap' THEN public.valid_hosted_bootstrap_contract(contract,
    admission->'assignment'->>'project',admission->'assignment'->>'region')
    ELSE public.valid_hosted_preparation_contract(contract) END) IS NOT TRUE
 OR contract_hash IS DISTINCT FROM encode(digest(contract::text,'sha256'),'hex')
 OR checkpoint->>'planDigest' IS DISTINCT FROM contract_hash
 THEN RETURN false; END IF;
 IF prior=checkpoint THEN RETURN checkpoint->>'phase'='observed'; END IF;
 IF expected<>coalesce((prior->>'generation')::integer,0) THEN RETURN false; END IF;
 prior_results := coalesce(prior->'completed','[]'::jsonb);
 results := checkpoint->'completed';
 IF checkpoint->>'phase'='intent' THEN
   IF public.hosted_pod_pilot_admission_current(p_owner,p_attempt,admission,
       coalesce(attempt->'evidence'->'reserved'->'projectObservation','null'::jsonb)) IS NOT TRUE
   OR (prior IS NOT NULL AND prior->>'phase'<>'observed')
   OR results<>prior_results
   OR EXISTS (SELECT 1 FROM jsonb_array_elements(results) entry WHERE entry->'ok' IS DISTINCT FROM 'true'::jsonb)
   OR contract->'steps'->>jsonb_array_length(results) IS DISTINCT FROM checkpoint->>'step'
   THEN RETURN false; END IF;
   IF checkpoint_kind='preparation' AND checkpoint->>'step' IN ('inference_vertex','inference_quota') THEN
    IF attempt->'evidence'->'reserved'->'hostedCheckpoint'->>'phase' IS DISTINCT FROM 'observed'
    OR jsonb_array_length(attempt->'evidence'->'reserved'->'hostedCheckpoint'->'completed')
       IS DISTINCT FROM jsonb_array_length(admission->'assignment'->'bootstrapContract'->'steps')
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(attempt->'evidence'->'reserved'->'hostedCheckpoint'->'completed') x
       WHERE x->'ok' IS DISTINCT FROM 'true'::jsonb)
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(attempt->'evidence'->'reserved'->'hostedCheckpoint'->'completed') x
       WHERE x->>'step'='pod_service_account' AND x->'ok'='true'::jsonb
       AND x->'resourceObservation'->>'type'='service_account'
       AND x->'resourceObservation'->>'id'=x->'resourceObservation'->'identity'->>'email'
       AND x->'resourceObservation'->'identity'->>'projectId'=admission->'assignment'->>'project')
    THEN RETURN false; END IF;
   END IF;
 ELSE
   -- Retain an already-authorized result after expiry. This permits no new work.
   IF prior->>'phase' IS DISTINCT FROM 'intent'
   OR prior->>'step' IS DISTINCT FROM checkpoint->>'step'
   OR jsonb_array_length(results)<>jsonb_array_length(prior_results)+1
   OR results-(jsonb_array_length(results)-1)<>prior_results THEN RETURN false; END IF;
   result := results->(jsonb_array_length(results)-1);
   IF jsonb_typeof(result) IS DISTINCT FROM 'object'
   OR (checkpoint_kind='bootstrap' AND result-ARRAY['step','status','ok','skipped','resourceObservation',
        'bindingObservations','operatorBindingObservations']<>'{}'::jsonb)
   OR (checkpoint_kind='preparation' AND public.valid_hosted_preparation_result(attempt,result) IS NOT TRUE)
   OR result->>'step' IS DISTINCT FROM checkpoint->>'step'
   OR jsonb_typeof(result->'ok') IS DISTINCT FROM 'boolean'
   OR jsonb_typeof(result->'status') IS DISTINCT FROM 'number'
   OR (result->>'status' ~ '^[0-9]{1,3}$') IS NOT TRUE
   OR (result->>'status')::integer>599 THEN RETURN false; END IF;
 END IF;
 prior_setting := current_setting('hussh.provision_attempt',true);
 PERFORM set_config('hussh.provision_attempt',p_attempt,true);
 attempt := attempt || jsonb_build_object('evidence',coalesce(attempt->'evidence','{}'::jsonb) ||
   jsonb_build_object('reserved',coalesce(attempt->'evidence'->'reserved','{}'::jsonb) ||
      jsonb_build_object(journal_key,checkpoint)));
 UPDATE public.personal_agent_registry SET backend_metadata=jsonb_set(
     backend_metadata,'{provisionAttempt}',attempt),updated_at=clock_timestamp() WHERE user_id=p_owner;
 PERFORM set_config('hussh.provision_attempt',coalesce(prior_setting,''),true);
 RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.publish_hosted_pod_bootstrap_checkpoint(
 p_owner text, p_attempt text, checkpoint jsonb
) RETURNS boolean LANGUAGE sql SET search_path=public AS $$
 SELECT public.publish_hosted_pod_step_checkpoint(p_owner,p_attempt,checkpoint,'bootstrap');
$$;

CREATE OR REPLACE FUNCTION public.publish_hosted_pod_preparation_checkpoint(
 p_owner text, p_attempt text, checkpoint jsonb
) RETURNS boolean LANGUAGE sql SET search_path=public AS $$
 SELECT public.publish_hosted_pod_step_checkpoint(p_owner,p_attempt,checkpoint,'preparation');
$$;

COMMIT;
