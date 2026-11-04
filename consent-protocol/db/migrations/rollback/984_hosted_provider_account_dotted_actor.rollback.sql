-- Remove the dotted-actor validator only when no transition evidence is retained.
BEGIN;

LOCK TABLE public.personal_agent_registry IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.personal_agent_deletion_tombstones IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.personal_agent_cloud_removals IN SHARE ROW EXCLUSIVE MODE;

DO $provider_account_dotted_actor_rollback_evidence$
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
$provider_account_dotted_actor_rollback_evidence$;

DO $provider_account_dotted_actor_rollback_precondition$
DECLARE definition text;
BEGIN
 SELECT pg_get_functiondef('public.valid_hosted_provider_account_transition_intent(jsonb,jsonb)'::regprocedure)
  INTO definition;
 IF definition IS NULL
  OR encode(sha256(convert_to(definition,'UTF8')),'hex')<>'1e6e47e1b467fbe95a0c7c16a6643ae71580c8c36d96038bac6f7bdc869578f1' THEN
  RAISE EXCEPTION 'Provider account actor validator changed before rollback';
 END IF;
END;
$provider_account_dotted_actor_rollback_precondition$;

CREATE OR REPLACE FUNCTION public.valid_hosted_provider_account_transition_intent(
 p_row jsonb, p_intent jsonb
) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=public AS $$
DECLARE metadata jsonb:=p_row->'backend_metadata'; attempt jsonb:=metadata->'provisionAttempt';
        admission jsonb:=attempt->'hostedAdmission'; assignment jsonb:=admission->'assignment';
        prep_contract jsonb:=assignment->'preparationContract';
        prep jsonb:=attempt->'evidence'->'reserved'->'hostedPreparation';
        completed jsonb:=prep->'completed'; creation jsonb; billing jsonb;
        actor_verification jsonb:=p_intent->'actorVerification';
BEGIN
 IF jsonb_typeof(p_row) IS DISTINCT FROM 'object'
 OR jsonb_typeof(p_intent) IS DISTINCT FROM 'object'
 OR p_intent-ARRAY['version','ownerId','attemptId','placementEpoch','operationId','projectId',
      'projectNumber','oldBillingAccount','targetBillingAccount','actorPrincipal','actorVerification',
      'serviceUid','runtimePrincipal','minimumSourceRevision','imageDigest','intentAt']<>'{}'::jsonb
 OR p_intent->'version' IS DISTINCT FROM '1'::jsonb
 OR p_intent->>'ownerId' IS DISTINCT FROM p_row->>'user_id'
 OR p_intent->>'attemptId' IS DISTINCT FROM attempt->>'attemptId'
 OR attempt->>'ownerId' IS DISTINCT FROM p_row->>'user_id'
 OR attempt->'intent'->>'user_id' IS DISTINCT FROM p_row->>'user_id'
 OR attempt->'intent'->>'hushh_id' IS DISTINCT FROM p_row->>'hushh_id'
 OR admission->>'environment' IS DISTINCT FROM 'dev'
 OR (attempt->'providerAccountTransition' IS NULL
     AND public.hosted_pod_retained_admitted(p_row->>'user_id',p_row) IS NOT TRUE)
 OR p_intent->'placementEpoch' IS DISTINCT FROM p_row->'placement_epoch'
 OR coalesce(p_intent->>'operationId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
 OR p_intent->>'projectId' IS DISTINCT FROM assignment->>'project'
 OR p_intent->>'projectId' IS DISTINCT FROM metadata->>'project'
 OR p_intent->>'projectNumber' IS DISTINCT FROM attempt->'evidence'->'reserved'->'projectObservation'->>'projectNumber'
 OR (assignment->>'projectNumber' IS NOT NULL
     AND p_intent->>'projectNumber' IS DISTINCT FROM assignment->>'projectNumber')
 OR p_intent->>'oldBillingAccount' IS DISTINCT FROM prep_contract->>'billingAccount'
 OR p_intent->>'targetBillingAccount' IS NOT DISTINCT FROM p_intent->>'oldBillingAccount'
 OR p_intent->>'targetBillingAccount' !~ '^billingAccounts/[A-Z0-9]{6}-[A-Z0-9]{6}-[A-Z0-9]{6}$'
 OR p_intent->>'actorPrincipal' IS DISTINCT FROM 'user:kushaltrivedi97@gmail.com'
 OR jsonb_typeof(actor_verification) IS DISTINCT FROM 'object'
 OR actor_verification->'principal' IS DISTINCT FROM p_intent->'actorPrincipal'
 OR actor_verification->>'email' IS DISTINCT FROM 'kushaltrivedi97@gmail.com'
 OR actor_verification->'emailVerified' IS DISTINCT FROM 'true'::jsonb
 OR coalesce(actor_verification->>'subject','') !~ '^[A-Za-z0-9_-]{1,255}$'
 OR jsonb_typeof(actor_verification->'verifiedAt') IS DISTINCT FROM 'string'
 OR NOT (
      ((actor_verification-ARRAY['version','provider','verificationMethod',
          'verificationEndpoint','subject','principal','email','emailVerified','verifiedAt'])='{}'::jsonb
       AND actor_verification->'version' IS NOT DISTINCT FROM '1'::jsonb
       AND actor_verification->>'provider' IS NOT DISTINCT FROM 'google'
       AND actor_verification->>'verificationMethod'
            IS NOT DISTINCT FROM 'google_userinfo_access_token_verified'
       AND actor_verification->>'verificationEndpoint'
            IS NOT DISTINCT FROM 'https://openidconnect.googleapis.com/v1/userinfo')
      OR
      ((actor_verification-ARRAY['version','provider','issuer','subject','principal',
          'email','emailVerified','audience','verificationMethod','tokenSha256','verifiedAt'])='{}'::jsonb
       AND attempt->'providerAccountTransition'->'intent' IS NOT DISTINCT FROM p_intent
       AND actor_verification->'version' IS NOT DISTINCT FROM '1'::jsonb
       AND actor_verification->>'provider' IS NOT DISTINCT FROM 'google'
       AND actor_verification->>'issuer' IS NOT DISTINCT FROM 'https://accounts.google.com'
       AND actor_verification->>'verificationMethod' IS NOT DISTINCT FROM 'google_id_token_verified'
       AND coalesce(actor_verification->>'tokenSha256','') ~ '^[a-f0-9]{64}$'
       AND coalesce(actor_verification->>'audience','')<>''
       AND octet_length(actor_verification->>'audience')<=256)
    )
 OR p_intent->>'serviceUid' IS DISTINCT FROM metadata->>'serviceUid'
 OR p_intent->>'runtimePrincipal' IS DISTINCT FROM metadata->>'runtime_service_account'
 OR coalesce(p_intent->>'minimumSourceRevision','') !~ '^[a-f0-9]{40}$'
 OR p_intent->>'imageDigest' IS DISTINCT FROM 'sha256:639958a5d5a9adf12c5a93839afaa3a8a1a86421896291b746b4e8c257ffc8a1'
 OR p_intent->>'projectId' NOT IN ('hussh-hp-7da5778b-261027a','hussh-hp-a3a6730e-261027b')
 OR assignment->>'ownerHash' IS DISTINCT FROM
      'sha256:'||encode(digest(p_row->>'user_id','sha256'),'hex')
 OR assignment->>'hushhId' IS DISTINCT FROM p_row->>'hushh_id'
 OR jsonb_typeof(p_intent->'intentAt') IS DISTINCT FROM 'string'
 OR jsonb_typeof(completed) IS DISTINCT FROM 'array'
 OR jsonb_array_length(completed)<>5
 OR (SELECT array_agg(x->>'step' ORDER BY n)
       FROM jsonb_array_elements(completed) WITH ORDINALITY AS item(x,n))
      IS DISTINCT FROM ARRAY['create_project','link_billing','authorize_project',
                             'inference_vertex','inference_quota']::text[]
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(completed) AS item(x)
      WHERE x->'ok' IS DISTINCT FROM 'true'::jsonb
         OR public.valid_hosted_preparation_result(attempt,x) IS NOT TRUE)
 OR prep->>'phase' IS DISTINCT FROM 'observed'
 OR prep->'version' IS DISTINCT FROM '1'::jsonb
 OR prep->>'ownerId' IS DISTINCT FROM p_row->>'user_id'
 OR prep->>'attemptId' IS DISTINCT FROM attempt->>'attemptId'
 OR prep->'generation' IS DISTINCT FROM '10'::jsonb
 OR prep->>'step' IS DISTINCT FROM 'inference_quota'
 OR prep->>'planDigest' IS DISTINCT FROM admission->>'preparationContractHash'
 OR prep->>'planDigest' IS DISTINCT FROM encode(digest(prep_contract::text,'sha256'),'hex')
 OR prep_contract IS NULL
 THEN RETURN false; END IF;
 IF (CASE p_intent->>'projectId'
  WHEN 'hussh-hp-7da5778b-261027a' THEN
   p_intent->>'projectNumber'='1010592650891'
   AND p_intent->>'attemptId'='95af9d1fdab94601a1e45554e4774fd3'
   AND p_intent->>'operationId'='777fe0a3-eaa2-42b3-97d2-3b6549a20290'
   AND p_row->>'hushh_id'='ha1_t6cqxavpt6sumlllpfcjrwkh4fztw5zq'
   AND p_intent->>'serviceUid'='fec811ba-2456-495d-ab66-a0d926077ae1'
   AND p_intent->>'runtimePrincipal'='one-pod-ha1-t6cqxavpt-rkntchve@hussh-hp-7da5778b-261027a.iam.gserviceaccount.com'
  WHEN 'hussh-hp-a3a6730e-261027b' THEN
   p_intent->>'projectNumber'='349132050484'
   AND p_intent->>'attemptId'='67ce0564b4b541a69abb31b336e51352'
   AND p_intent->>'operationId'='9df62f66-f271-491d-ab34-406823292f5d'
   AND p_row->>'hushh_id'='ha1_sdhll3ua5kg4o6cmo2imyijcmygnwzqh'
   AND p_intent->>'serviceUid'='e14040de-505a-4fc6-9a4a-e391ea1d6026'
   AND p_intent->>'runtimePrincipal'='one-pod-ha1-sdhll3ua5-rqghnwhy@hussh-hp-a3a6730e-261027b.iam.gserviceaccount.com'
  ELSE false END) IS NOT TRUE THEN RETURN false; END IF;
 IF p_intent->>'oldBillingAccount' IS DISTINCT FROM 'billingAccounts/014D7F-FD970D-D2459E'
 OR p_intent->>'targetBillingAccount' IS DISTINCT FROM 'billingAccounts/013848-8258FA-2D068F'
 THEN RETURN false; END IF;
 creation:=completed->0->'resourceObservation'->'identity';
 billing:=completed->1->'billingObservation';
 RETURN creation->>'projectId'=p_intent->>'projectId'
  AND creation->>'projectNumber'=p_intent->>'projectNumber'
  AND billing->>'projectId'=p_intent->>'projectId'
  AND billing->>'billingAccountName'=p_intent->>'oldBillingAccount'
  AND billing->'billingEnabled'='true'::jsonb
  AND metadata->>'serviceUid' IS NOT NULL
  AND metadata->>'runtime_service_account' IS NOT NULL
  AND p_row->>'status'='provisioned'
  AND p_row->>'deployment_target'='gcp'
  AND coalesce(metadata->>'tenancy','hussh-hosted')='hussh-hosted'
  AND (actor_verification->>'verifiedAt')::timestamptz<=(p_intent->>'intentAt')::timestamptz+interval '5 seconds';
EXCEPTION WHEN data_exception THEN RETURN false;
END;
$$;

COMMIT;
