-- Dev-pilot refinement. Existing BYOC/Azure receipt contracts remain authoritative.
-- No hosted assignment, IAM grant or cloud resource is activated by this migration.
BEGIN;

DO $hosted_custody_predecessors$
DECLARE spec record; definition text;
BEGIN
 FOR spec IN SELECT * FROM (VALUES
 ('erasure_authorization_history(jsonb,jsonb)',ARRAY['229ae3dadf31ae73f9c84e55ad4be9c57da79e8dece62838fc6b663c07ab2bad']::text[]),
 ('erasure_managed_model_grants_complete(jsonb)',ARRAY['ab7ad9ac87b2a2acd524de7d8f794b1a9ba3c0bffa39996c2c9fa21333a6fcba']::text[]),
 ('erasure_private_coordinates(jsonb)',ARRAY['1390d7709aef509377b352995a8354ce9d25c60f871e3f7b9d05ad72ebb5ffe5']::text[]),
 ('expected_erasure_bootstrap_release(text,jsonb,text)',ARRAY['5f147b9ea109568a120653b39373d1f607986b0cbd1f9b3133c851ad73d99eb5','9c7df549d997f7e00af73bdc28816ca337452ff340ea232b0acf27a486b04897']::text[]),
 ('guard_personal_agent_erasure_registry()',ARRAY['28050839ef93e010d92cd5289dda40b6adb020aaf3717f4b23c513aa4503f30a','ad1098a0ec4bef6691a40bb4b9a34bf98a2bfcbdb4cec71100113f1b7948618b','acee347ae543bdb182fc5cbfe1090a788f8f31213ab09569be5509aac3707ee9','c7f509dc6824e9a0ab66ae6e30b98e2afdd48483d72754a00c36cb15d0d3f521']::text[]),
 ('guard_project_grant_registry_admission()',ARRAY['1912f59585796ac340a29f56fa7875726e742531b716fa9b98612a555cc3a6ca','38822c10a774c8c8602cf8b2788436a83958167b7bcfb302d37eef3bcb9e3d54']::text[]),
 ('hosted_pod_cleanup_admitted(text,text,jsonb)',ARRAY['8c9507d2151caede029d26b1784c3772bc7c4e959b3bf3e8a8766f8865e51735']::text[]),
 ('hosted_pod_execution_admitted(text,text,jsonb,jsonb,text)',ARRAY['8361affe67f04eb6269e2bbec93d43b2893c8fbfb9681e5db0f69907cccdd166']::text[]),
 ('hosted_pod_retained_admitted(text,jsonb)',ARRAY['7886341ac8363c3ef491746978e5d4863c24a74b84531ebd2ce29a7d7c7ba954']::text[]),
 ('hosted_pod_upgrade_admitted(text,text,jsonb,boolean)',ARRAY['a3b2321d76a773ae76378fe640eca1f65a70445c25feb64a37b0c90e70e47455']::text[]),
 ('hosted_preparation_cleanup_admitted(text,text,jsonb)',ARRAY['087392d6dd4740ecbe1cc43e19e8da6a01d578570c7bd4257881e97d10ae8777']::text[]),
 ('managed_preparation_cleanup_coordinates(jsonb)',ARRAY['4876286e5b7e1d3f69d534b55aec8961dd8c5d38c58af1a6514da1333f9693d1']::text[]),
 ('personal_agent_erasure_archive(jsonb,jsonb)',ARRAY['1139e56bb652ecfcab21e859685bcbabaa1fb77b6600fb644ab1b0f579aeb812','64014a7954dca3c882c634eee8baaae4ea7a5a9f33a69b1a8dc176e47645e957','e43bad73e40984d01c4ea5a01872dc76ce3ba77fce05c48eaffd95118d398685']::text[]),
 ('personal_agent_erasure_archived(text,jsonb,jsonb)',ARRAY['842f2a6bfa25429a970a2508c9ef84e525175c7e69e91875f18fcb7253b4d7f8','869752af19ff5735ad84cfefcb7cdfdc3036646bf137d64e16e04ce57f984bab','ac8763439ef913b66287f4b69c2493b6572922b1ed7adba729539fbd5d05d700']::text[]),
 ('personal_agent_erasure_complete(text)',ARRAY['6783be49623801f45983a4eed88ba4473ab1e853fd20bec6bd82020cb613eb9e','d1e653a9c5323c12e558ed2b2d5483487e50d745424f5d512b91c687cd94dd2d','d6e6864d75ed2e06b36f1ec52a6428017a92477ff4f70941b4105474416646a8']::text[]),
 ('private_gcp_coordinates(jsonb)',ARRAY['1276132589bc5b003fb031bb84e5f8a5b7e4b9c5b2ab707c1f3576823e86e03c']::text[]),
 ('project_grant_release_is_exclusive(text,text)',ARRAY['2443acc5b64dd4866dba2f0814a1abad38f031dee12f1f4e2f69e78fb4a8a9f9','600d73daf4d90be870860e24fc5e7ee8130acf2a46afac5ae1a72def433e6a1e']::text[]),
 ('reserve_erasure_grant_release(text,text,jsonb)',ARRAY['31773f73b7057b12261573a9a42f0c3838046723a49598fad1f3c2dfe92506fc','6a2e27053b8c0d2e3abef78c446a1fd653bf93d1ad2d3edb800f6f3a5b400855']::text[]),
 ('reserve_personal_agent_erasure(text,text)',ARRAY['adb9e04bbda14bdd2d0d0373d014efc288760f7d3eacb227551de7677b682498','cd9672f048b220109cb23cd12e97921f11afddf1616d3bea7fcec10f0eb26195']::text[]),
 ('retain_erasure_managed_model_grant_receipt(text,text,jsonb,text,text,jsonb)',ARRAY['ba959ceb4ac55f3b3b93ada3fac883faf2fd697cb5dbe083b3160a9e202d4912']::text[]),
 ('retain_erasure_managed_project_retirement(text,text,jsonb,text,jsonb)',ARRAY['1c83c62a23b3f8e050c3d15ec76153c9ffc5a7b0f874b515443645585f54a50b']::text[]),
 ('retain_hosted_pod_project_authorization(text,text)',ARRAY['69a3a70f7793e2a2936d14143defde00cf01534eb8abb08f75210519ac1da862']::text[]),
 ('retain_managed_preparation_cleanup(text,text,jsonb,text,jsonb)',ARRAY['4ca371403a38e1e05da0478862fc5d8c2560ed1b1be0f0c01f45db67a874467d']::text[]),
 ('valid_erasure_files_receipt(jsonb,text,text,jsonb)',ARRAY['dc0122b80000b4c4698f132b11377676b6cb18a31efd5c7e49fd8137428f9ab5','e253b257558adc05bd7c5170f5da9f67dca039800aba75234180a03ea27f964a']::text[]),
 ('valid_erasure_gcp_files_upgrade_observation(jsonb,jsonb)',ARRAY['38a8ec11f7099b60c25ed7380f74144d5a14e0f8c42fca42e56ca58689eefa46','96d97d4f2f66d3bcd2555805b21bd712f1b973daae20657053f17652856d0742']::text[]),
 ('valid_erasure_grant_release(jsonb,jsonb)',ARRAY['11b5843638035e5e4ac935d43e74b143f4e653a27ed8b19332570307afe4a9a9','4100815e7449e23a730dbb3bedd45c9e8fd736363ef725e956e881183fdb5b6f']::text[]),
 ('valid_erasure_kms_receipt(jsonb,text,jsonb)',ARRAY['0de93e902fcf50d4464a7c764808dd32912d35b37a1077615616aa4ee55e5234','219024beeb264de779933d7f66adb11c6f5a5db010822ef7226e6fd3ec2b4766','d0aa90c25eee793106f325983887305a032202012fe02ca74a55b4bb11b2eac2']::text[]),
 ('valid_erasure_mail_receipt(jsonb,text,text,jsonb)',ARRAY['4d4b33ec24b3fff696c7bcc52aa17a8479e0ec4100bff80a58bb226883656ed8','c45434340e8580324d55116242f70e569f426288c2c6e4350c3dde9bd168804f','e11aa98f323fb42d4b5724f23e20e5b86f26dc77a4f5d2506266e31cdfd84fc2']::text[]),
 ('valid_erasure_managed_model_grant_append(jsonb,jsonb)',ARRAY['c6806e3be69d9420f6a57044cadd68ff698be50d5ed2c3c2f5ed50295ad9e0ff']::text[]),
 ('valid_erasure_managed_model_grant_receipt(jsonb,text,text,jsonb)',ARRAY['072534ad1f221b060b490dc330e0bf2db061502b5d3186f257c78ae85226a749']::text[]),
 ('valid_erasure_managed_project_retirement(jsonb,text,jsonb)',ARRAY['6a0728cbf7cd714089199427d2d85d16017c6e95a8d5dd4ef02a6fdd59da0349']::text[]),
 ('valid_erasure_managed_retirement_append(jsonb,jsonb)',ARRAY['69320963e61384d21aceb1840d22b825da549c9d7c16e72ad4da6705a7565c11']::text[]),
 ('valid_erasure_repository_grant_receipt(jsonb,text,jsonb)',ARRAY['663385d8d225862521cd03892744732cc628ffbd54ac477e648db201ae7b667b','6d57969cb359757416e6918f061ff95c08b15d1cc39499e1fe571d9a97a30715','8ad9954e5381703965b6700056acebf77d4f07624fe778fcec87192245de5799']::text[]),
 ('valid_erasure_repository_inventory(jsonb,jsonb)',ARRAY['6c2d5f82d86f8a97001f252860d3d770744e43bedd07c5b04eef8cfa99f69d3e','ce792c145b70c2f5515221a2e3cc93add5e2c0ae0182800bce30aafa9ec2ffe4']::text[]),
 ('valid_erasure_secret_receipt(jsonb,text,jsonb)',ARRAY['40f47265300102f0b7d1f8420820948406b1748b61cba2ca2543aa2a763e0ae3','9fd18377bf2d060aac9d7236c708dacefe2b674b19a381b0778ddac15be0672c']::text[]),
 ('valid_erasure_writer_receipt(jsonb,text,jsonb)',ARRAY['b1f78ff6cc79b6a8cb1ca2a2c8f5be2f7bf1699ab5b1d9df585f42e6490bdd81','c25e11f3a85b63082a3adcbd08bf93cd6c9f7f439c0db262df42ac49575cd041']::text[]),
 ('valid_managed_preparation_cleanup(jsonb,text,jsonb)',ARRAY['2a6e52470a9c63d38d1b3565e3216d86e1a51359ed506da73b5db331f41b7ef6']::text[]),
 ('valid_managed_preparation_cleanup_append(jsonb,jsonb)',ARRAY['7fb22e756f1ca75aa7b475d8cb80a690646a1520487afa3da771cddf71eb8cb5']::text[])) AS expected(signature,allowed) LOOP
  SELECT pg_get_functiondef(to_regprocedure('public.'||spec.signature)) INTO definition;
  IF definition IS NOT NULL AND NOT encode(sha256(convert_to(definition,'UTF8')),'hex')=ANY(spec.allowed) THEN
   RAISE EXCEPTION 'Unqualified managed custody predecessor: %',spec.signature;
  END IF;
 END LOOP;
END;
$hosted_custody_predecessors$;


CREATE OR REPLACE FUNCTION public.private_gcp_coordinates(snapshot jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $$
DECLARE
 metadata jsonb:=snapshot->'backend_metadata';
 attempt jsonb:=metadata->'provisionAttempt';
 admission jsonb:=attempt->'hostedAdmission';
 assignment jsonb:=admission->'assignment';
 plan jsonb:=assignment->'bootstrapContract'->'plan';
 observed jsonb:=attempt->'evidence'->'reserved'->'projectObservation';
 grant_authorization jsonb:=attempt->'evidence'->'reserved'->'projectAuthorization';
 identity jsonb:=grant_authorization->'receipt'->'bootstrapIdentity';
 binding jsonb:=grant_authorization->'receipt'->'bindingObservation';
 project text:=assignment->>'project'; region text:=assignment->>'region';
 bootstrap text:=plan->'federation'->'impersonation'->>'bootstrap_service_account';
 caller text:=plan->'federation'->'impersonation'->>'granted_to';
BEGIN
 IF jsonb_typeof(snapshot) IS DISTINCT FROM 'object' THEN RETURN NULL; END IF;
 IF snapshot->>'deployment_target'='user_gcp' THEN
  RETURN jsonb_build_object('project',snapshot->>'user_cloud_project',
    'region',snapshot->>'user_cloud_region','bootstrap',snapshot->>'user_cloud_bootstrap_sa');
 END IF;
 IF jsonb_typeof(metadata) IS DISTINCT FROM 'object'
 OR jsonb_typeof(attempt) IS DISTINCT FROM 'object'
 OR jsonb_typeof(admission) IS DISTINCT FROM 'object'
 OR jsonb_typeof(assignment) IS DISTINCT FROM 'object'
 OR jsonb_typeof(observed) IS DISTINCT FROM 'object'
 OR jsonb_typeof(grant_authorization) IS DISTINCT FROM 'object'
 OR jsonb_typeof(grant_authorization->'receipt') IS DISTINCT FROM 'object'
 OR jsonb_typeof(identity) IS DISTINCT FROM 'object'
 OR jsonb_typeof(binding) IS DISTINCT FROM 'object'
 THEN RETURN NULL; END IF;
 IF snapshot->>'deployment_target' IS DISTINCT FROM 'gcp'
 OR coalesce(metadata->>'tenancy','hussh-hosted') IS DISTINCT FROM 'hussh-hosted'
 OR jsonb_typeof(snapshot) IS DISTINCT FROM 'object'
 OR admission->'version' IS DISTINCT FROM '1'::jsonb
 OR admission->>'environment' IS DISTINCT FROM 'dev'
 OR attempt->>'ownerId' IS DISTINCT FROM snapshot->>'user_id'
 OR attempt->'intent'->>'user_id' IS DISTINCT FROM snapshot->>'user_id'
 OR attempt->'intent'->>'hushh_id' IS DISTINCT FROM snapshot->>'hushh_id'
 OR assignment->>'hushhId' IS DISTINCT FROM snapshot->>'hushh_id'
 OR coalesce(snapshot->>'user_id','')=''
 OR assignment->>'ownerHash' IS DISTINCT FROM 'sha256:'||encode(digest(snapshot->>'user_id','sha256'),'hex')
 OR coalesce(attempt->>'attemptId','') !~ '^[a-f0-9]{32}$'
 OR coalesce(admission->>'policyId','') !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
 OR coalesce(admission->>'sourceRevision','') !~ '^[a-f0-9]{40}$'
 OR coalesce(admission->>'imageDigest','') !~ '^sha256:[a-f0-9]{64}$'
 OR admission->'workBudgetCents' IS DISTINCT FROM '20000'::jsonb
 OR admission->'cleanupReserveCents' IS DISTINCT FROM '5000'::jsonb
 OR jsonb_typeof(admission->'modelBinding') IS DISTINCT FROM 'object'
 OR admission->'modelBinding'->>'provider' IS DISTINCT FROM 'gemini'
 OR coalesce(admission->'modelBinding'->>'project','') !~ '^[a-z][a-z0-9-]{4,28}[a-z0-9]$'
 OR coalesce(admission->'modelBinding'->>'model','') !~ '^gemini-[A-Za-z0-9._-]{1,100}$'
 OR coalesce(admission->'modelBinding'->>'profileHash','') !~ '^[a-f0-9]{64}$'
 OR coalesce(project,'') !~ '^[a-z][a-z0-9-]{4,28}[a-z0-9]$'
 OR coalesce(region,'') !~ '^[a-z]+-[a-z]+[0-9]+$'
 OR public.valid_hosted_bootstrap_contract(assignment->'bootstrapContract',project,region) IS NOT TRUE
 OR admission->>'bootstrapContractHash' IS DISTINCT FROM encode(digest((assignment->'bootstrapContract')::text,'sha256'),'hex')
 OR observed->>'projectId' IS DISTINCT FROM project
 OR observed->>'lifecycleState' IS DISTINCT FROM 'ACTIVE'
 OR coalesce(observed->>'projectNumber','') !~ '^[1-9][0-9]{0,19}$'
 OR (assignment->>'projectNumber' IS NOT NULL AND assignment->>'projectNumber' IS DISTINCT FROM observed->>'projectNumber')
 OR EXISTS(SELECT 1 FROM jsonb_each(snapshot) x WHERE starts_with(x.key,'user_cloud_') AND x.value<>'null'::jsonb)
 OR grant_authorization->'intent' IS DISTINCT FROM jsonb_build_object(
    'ownerId',snapshot->>'user_id','jobId',attempt->>'attemptId','project',project,'callerEmail',caller)
 OR grant_authorization-ARRAY['intent','receipt']<>'{}'::jsonb
 OR (grant_authorization->'receipt')-ARRAY['bootstrapIdentity','bindingObservation']<>'{}'::jsonb
 OR identity-ARRAY['name','projectId','email','uniqueId']<>'{}'::jsonb
 OR binding-ARRAY['step','policyResource','role','member','disposition','beforeEtag','afterEtag']<>'{}'::jsonb
 OR binding->>'step' IS DISTINCT FROM 'authorize_bootstrap_impersonation'
 OR coalesce(bootstrap,'') !~ ('^[a-z][a-z0-9-]{4,28}[a-z0-9]@'||project||'[.]iam[.]gserviceaccount[.]com$')
 OR coalesce(caller,'') !~ '^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9][.]iam[.]gserviceaccount[.]com$'
 OR identity->>'projectId' IS DISTINCT FROM project OR identity->>'email' IS DISTINCT FROM bootstrap
 OR coalesce(identity->>'uniqueId','') !~ '^[1-9][0-9]{0,31}$'
 OR (identity->>'name' IN ('projects/'||project||'/serviceAccounts/'||bootstrap,
     'projects/'||project||'/serviceAccounts/'||(identity->>'uniqueId'))) IS NOT TRUE
 OR binding->>'role' IS DISTINCT FROM 'roles/iam.serviceAccountTokenCreator'
 OR binding->>'member' IS DISTINCT FROM 'serviceAccount:'||caller
 OR binding->>'policyResource' IS DISTINCT FROM 'https://iam.googleapis.com/v1/projects/'||project||'/serviceAccounts/'||bootstrap||':getIamPolicy'
 OR coalesce(binding->>'disposition','') NOT IN ('added','already_present')
 OR coalesce(binding->>'beforeEtag','')='' OR coalesce(binding->>'afterEtag','')=''
 THEN RETURN NULL; END IF;
 -- Frozen interpretation only: expiry/current model configuration cannot strand cleanup.
 RETURN jsonb_build_object('project',project,'region',region,'bootstrap',bootstrap,
  'projectNumber',observed->>'projectNumber','provisionAttemptId',attempt->>'attemptId');
END;
$$;

CREATE OR REPLACE FUNCTION public.erasure_private_coordinates(r jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=public AS $$
 SELECT public.private_gcp_coordinates(r->'registrySnapshot')
 WHERE r->>'ownerId'=r->'registrySnapshot'->>'user_id'
 AND r->>'hushhId'=r->'registrySnapshot'->>'hushh_id';
$$;

CREATE OR REPLACE FUNCTION public.retain_hosted_pod_project_authorization(p_owner text,p_attempt text)
RETURNS boolean LANGUAGE plpgsql SET search_path=public AS $$
DECLARE r public.personal_agent_registry%ROWTYPE; attempt jsonb; result jsonb; retained jsonb;
 updated jsonb; prior_setting text; caller text;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(p_owner,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(p_owner,198));
 SELECT * INTO r FROM public.personal_agent_registry WHERE user_id=p_owner FOR UPDATE;
 IF NOT FOUND OR r.deployment_target IS DISTINCT FROM 'gcp' OR r.backend_metadata ? 'erasure' THEN RETURN false; END IF;
 attempt:=r.backend_metadata->'provisionAttempt';
 IF attempt->>'ownerId' IS DISTINCT FROM p_owner OR attempt->>'attemptId' IS DISTINCT FROM p_attempt
 OR attempt->>'phase' IS DISTINCT FROM 'reserved' THEN RETURN false; END IF;
 SELECT x INTO result FROM jsonb_array_elements(attempt->'evidence'->'reserved'->'hostedPreparation'->'completed') x
 WHERE x->>'step'='authorize_project';
 IF result->'ok' IS DISTINCT FROM 'true'::jsonb
 OR public.valid_hosted_preparation_result(attempt,result) IS NOT TRUE THEN RETURN false; END IF;
 caller:=attempt->'hostedAdmission'->'assignment'->'bootstrapContract'->'plan'->'federation'->'impersonation'->>'granted_to';
 retained:=jsonb_build_object('intent',jsonb_build_object('ownerId',p_owner,'jobId',p_attempt,
    'project',attempt->'hostedAdmission'->'assignment'->>'project','callerEmail',caller),
    'receipt',result->'authorizationReceipt');
 IF attempt->'evidence'->'reserved' ? 'projectAuthorization' THEN
  RETURN attempt->'evidence'->'reserved'->'projectAuthorization'=retained;
 END IF;
 updated:=jsonb_set(attempt,'{evidence,reserved,projectAuthorization}',retained,true);
 IF public.private_gcp_coordinates(jsonb_set(to_jsonb(r),'{backend_metadata,provisionAttempt}',updated)) IS NULL
 THEN RETURN false; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.hosted_pod_pilot_policy p,
   jsonb_array_elements(p.assignments) WITH ORDINALITY x(a,n)
   WHERE p.singleton AND p.policy_id::text=attempt->'hostedAdmission'->>'policyId'
   AND p.source_revision=attempt->'hostedAdmission'->>'sourceRevision'
   AND p.image_digest=attempt->'hostedAdmission'->>'imageDigest'
   AND p.model_binding=attempt->'hostedAdmission'->'modelBinding'
   AND x.a=attempt->'hostedAdmission'->'assignment'
   AND CASE WHEN n=1 THEN p.attempt_a ELSE p.attempt_b END=p_attempt)
 THEN RETURN false; END IF;
 prior_setting:=current_setting('hussh.provision_attempt',true);
 PERFORM set_config('hussh.provision_attempt',p_attempt,true);
 UPDATE public.personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata,'{provisionAttempt}',updated),
  updated_at=clock_timestamp() WHERE user_id=p_owner;
 PERFORM set_config('hussh.provision_attempt',coalesce(prior_setting,''),true);
 RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.hosted_pod_execution_admitted(
 p_owner text,p_attempt text,p_admission jsonb,p_observation jsonb,purpose text
) RETURNS boolean LANGUAGE sql SET search_path=public AS $$
 SELECT public.hosted_pod_pilot_admission_current(p_owner,p_attempt,p_admission,p_observation)
 AND purpose IN ('bootstrap','provision') AND EXISTS(
  SELECT 1 FROM public.personal_agent_registry r
  CROSS JOIN LATERAL (SELECT r.backend_metadata->'provisionAttempt'->'evidence'->'reserved'->'hostedPreparation' AS value) c
  WHERE r.user_id=p_owner AND public.private_gcp_coordinates(to_jsonb(r)) IS NOT NULL
  AND c.value->>'phase'='observed' AND c.value->>'ownerId'=p_owner AND c.value->>'attemptId'=p_attempt
  AND c.value->>'planDigest'=p_admission->>'preparationContractHash'
  AND jsonb_array_length(c.value->'completed') BETWEEN 3 AND 5
  AND (purpose='bootstrap' OR jsonb_array_length(c.value->'completed')=5)
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(c.value->'completed') x WHERE x->'ok' IS DISTINCT FROM 'true'::jsonb)
  AND (SELECT jsonb_agg(x.value->>'step' ORDER BY n)
       FROM jsonb_array_elements(c.value->'completed') WITH ORDINALITY x(value,n))=
      (SELECT jsonb_agg(x.value ORDER BY n)
       FROM jsonb_array_elements(p_admission->'assignment'->'preparationContract'->'steps') WITH ORDINALITY x(value,n)
       WHERE n<=jsonb_array_length(c.value->'completed'))
 );
$$;

CREATE OR REPLACE FUNCTION public.erasure_authorization_history(r jsonb, supplied jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $$
DECLARE coordinates jsonb; attempt jsonb;
BEGIN
 IF r->'registrySnapshot'->>'deployment_target' IS DISTINCT FROM 'gcp' THEN RETURN supplied; END IF;
 IF public.managed_preparation_cleanup_coordinates(r) IS NOT NULL THEN RETURN '{}'::jsonb; END IF;
 coordinates:=public.erasure_private_coordinates(r);
 IF coordinates IS NULL THEN RETURN NULL; END IF;
 attempt:=r->'registrySnapshot'->'backend_metadata'->'provisionAttempt';
 RETURN jsonb_build_object(attempt->>'attemptId',attempt->'evidence'->'reserved'->'projectAuthorization');
END;
$$;

-- A project created before authorization has no bootstrap identity to borrow.
-- Its operator-owned cleanup is admitted from the exact preparation prefix instead.
CREATE OR REPLACE FUNCTION public.managed_preparation_cleanup_coordinates(r jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $$
DECLARE snapshot jsonb:=r->'registrySnapshot'; a jsonb:=snapshot->'backend_metadata'->'provisionAttempt';
 admission jsonb:=a->'hostedAdmission'; assignment jsonb:=admission->'assignment';
 checkpoint jsonb:=a->'evidence'->'reserved'->'hostedPreparation';
 completed jsonb:=checkpoint->'completed'; project text:=assignment->>'project'; identity jsonb;
BEGIN
 IF jsonb_typeof(completed) IS DISTINCT FROM 'array' THEN RETURN NULL; END IF;
 IF admission->'version' IS DISTINCT FROM '1'::jsonb
 OR admission->>'environment' IS DISTINCT FROM 'dev'
 OR admission->'workBudgetCents' IS DISTINCT FROM '20000'::jsonb
 OR admission->'cleanupReserveCents' IS DISTINCT FROM '5000'::jsonb
 OR project=admission->'modelBinding'->>'project'
 OR coalesce(assignment->'bootstrapContract'->'plan'->'federation'->'impersonation'->>'bootstrap_service_account','') !~ ('^[a-z][a-z0-9-]{4,28}[a-z0-9]@'||project||'[.]iam[.]gserviceaccount[.]com$')
 OR coalesce(assignment->'bootstrapContract'->'plan'->'federation'->'impersonation'->>'granted_to','') !~ '^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9][.]iam[.]gserviceaccount[.]com$'
 OR project=regexp_replace(split_part(assignment->'bootstrapContract'->'plan'->'federation'->'impersonation'->>'granted_to','@',2),'[.]iam[.]gserviceaccount[.]com$','')
 OR snapshot->>'deployment_target' IS DISTINCT FROM 'gcp'
 OR snapshot->>'user_id' IS DISTINCT FROM r->>'ownerId'
 OR snapshot->>'hushh_id' IS DISTINCT FROM r->>'hushhId'
 OR a->>'ownerId' IS DISTINCT FROM r->>'ownerId'
 OR a->'intent'->>'user_id' IS DISTINCT FROM r->>'ownerId'
 OR a->'intent'->>'hushh_id' IS DISTINCT FROM r->>'hushhId'
 OR assignment->>'hushhId' IS DISTINCT FROM r->>'hushhId'
 OR assignment->>'ownerHash' IS DISTINCT FROM 'sha256:'||encode(digest(r->>'ownerId','sha256'),'hex')
 OR a->>'phase' IS DISTINCT FROM 'reserved'
 OR checkpoint->>'phase' IS DISTINCT FROM 'observed'
 OR checkpoint->>'planDigest' IS DISTINCT FROM admission->>'preparationContractHash'
 OR admission->>'preparationContractHash' IS DISTINCT FROM encode(digest((assignment->'preparationContract')::text,'sha256'),'hex')
 OR public.valid_hosted_preparation_contract(assignment->'preparationContract') IS NOT TRUE
 OR jsonb_array_length(completed) NOT IN (1,2)
 OR completed->0->>'step' IS DISTINCT FROM 'create_project'
 OR (jsonb_array_length(completed)=2 AND completed->1->>'step' IS DISTINCT FROM 'link_billing')
 OR a->'evidence'->'reserved' ?| ARRAY['hostedCheckpoint','projectAuthorization']
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(completed) x
    WHERE public.valid_hosted_preparation_result(a,x) IS NOT TRUE OR x->'ok' IS DISTINCT FROM 'true'::jsonb)
 THEN RETURN NULL; END IF;
 identity:=completed->0->'resourceObservation'->'identity';
 IF a->'evidence'->'reserved'->'projectObservation' IS DISTINCT FROM
    jsonb_build_object('projectId',project,'projectNumber',identity->>'projectNumber','lifecycleState','ACTIVE')
 THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('project',project,'projectNumber',identity->>'projectNumber',
   'operatorPrincipal',assignment->'preparationContract'->>'operatorPrincipal','projectIdentity',identity,
   'bootstrap',assignment->'bootstrapContract'->'plan'->'federation'->'impersonation'->>'bootstrap_service_account');
END;
$$;

CREATE OR REPLACE FUNCTION public.hosted_preparation_cleanup_admitted(p_owner text,p_attempt text,expected jsonb)
RETURNS boolean LANGUAGE sql SET search_path=public AS $$
 SELECT public.managed_preparation_cleanup_coordinates(expected) IS NOT NULL AND EXISTS(
 SELECT 1 FROM public.personal_agent_registry r JOIN public.hosted_pod_pilot_policy p ON p.singleton
 CROSS JOIN LATERAL (SELECT expected->'registrySnapshot'->'backend_metadata'->'provisionAttempt' AS value) a
 WHERE r.user_id=p_owner AND r.status='suspended' AND r.deployment_target='gcp'
 AND r.backend_metadata->'erasure'=expected AND expected->>'ownerId'=p_owner
 AND expected->>'attemptId'=p_attempt AND expected->>'hushhId'=r.hushh_id
 AND p.environment='dev' AND p.policy_id::text=a.value->'hostedAdmission'->>'policyId'
 AND p.source_revision=a.value->'hostedAdmission'->>'sourceRevision'
 AND p.image_digest=a.value->'hostedAdmission'->>'imageDigest'
 AND p.model_binding=a.value->'hostedAdmission'->'modelBinding'
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(p.assignments) WITH ORDINALITY x(assignment,n)
  WHERE x.assignment=a.value->'hostedAdmission'->'assignment'
  AND CASE WHEN n=1 THEN p.attempt_a ELSE p.attempt_b END=a.value->>'attemptId'));
$$;

CREATE OR REPLACE FUNCTION public.valid_managed_preparation_cleanup(r jsonb,stage text,receipt jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $$
DECLARE coordinates jsonb:=public.managed_preparation_cleanup_coordinates(r); wanted jsonb;
BEGIN
 IF coordinates IS NULL OR jsonb_typeof(receipt) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 wanted:=jsonb_build_object('ownerId',r->>'ownerId','attemptId',r->>'attemptId',
  'project',coordinates->>'project','projectNumber',coordinates->>'projectNumber',
  'operatorPrincipal',coordinates->>'operatorPrincipal');
 IF stage='admission' THEN RETURN receipt=wanted||jsonb_build_object('status','admitted'); END IF;
 IF stage='acknowledgement' THEN RETURN receipt=wanted||jsonb_build_object('status','acknowledged'); END IF;
 IF stage='deletion' THEN RETURN receipt=wanted||jsonb_build_object('status','retirement_pending_provider_purge',
  'projectIdentity',jsonb_set(coordinates->'projectIdentity','{lifecycleState}','"DELETE_REQUESTED"'::jsonb),
  'billingObservation',jsonb_build_object('projectId',coordinates->>'project','billingAccountName','','billingEnabled',false),
  'bootstrapIdentity',jsonb_build_object('email',coordinates->>'bootstrap','status','observed_absent'),
  'resourceInventory',jsonb_build_object('cloud_run_services','[]'::jsonb,'buckets','[]'::jsonb,
    'kms_keys','[]'::jsonb,'secrets','[]'::jsonb,'memory_banks','[]'::jsonb,'connector_credentials','[]'::jsonb)); END IF;
 RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.valid_managed_preparation_cleanup_append(old_r jsonb,new_r jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $$
DECLARE prior jsonb:=coalesce(old_r->'managedPreparationCleanup','{}'::jsonb); next jsonb:=new_r->'managedPreparationCleanup';
 stage text; changed integer:=0;
BEGIN
 IF new_r-'managedPreparationCleanup' IS DISTINCT FROM old_r-'managedPreparationCleanup'
 OR jsonb_typeof(prior) IS DISTINCT FROM 'object' OR jsonb_typeof(next) IS DISTINCT FROM 'object'
 OR prior ? 'deletion' OR next-ARRAY['admission','acknowledgement','deletion']<>'{}'::jsonb THEN RETURN false; END IF;
 FOREACH stage IN ARRAY ARRAY['admission','acknowledgement','deletion'] LOOP
  IF prior ? stage THEN IF next->stage IS DISTINCT FROM prior->stage THEN RETURN false; END IF;
  ELSIF next ? stage THEN
   changed:=changed+1;
   IF public.valid_managed_preparation_cleanup(old_r,stage,next->stage) IS NOT TRUE
   OR (stage<>'admission' AND NOT prior ? 'admission') THEN RETURN false; END IF;
  END IF;
 END LOOP;
 RETURN changed=1;
END;
$$;

CREATE OR REPLACE FUNCTION public.retain_managed_preparation_cleanup(
 p_owner text,p_attempt text,expected jsonb,p_stage text,receipt jsonb
) RETURNS boolean LANGUAGE plpgsql SET search_path=public AS $$
DECLARE row_state public.personal_agent_registry%ROWTYPE; r jsonb; updated jsonb;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' OR p_stage NOT IN ('admission','acknowledgement','deletion') THEN RETURN false; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_owner,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(p_owner,198));
 SELECT * INTO row_state FROM public.personal_agent_registry WHERE user_id=p_owner FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 r:=row_state.backend_metadata->'erasure';
 IF public.hosted_preparation_cleanup_admitted(p_owner,p_attempt,r) IS NOT TRUE THEN RETURN false; END IF;
 IF r->'managedPreparationCleanup' ? p_stage THEN RETURN r->'managedPreparationCleanup'->p_stage=receipt; END IF;
 IF r IS DISTINCT FROM expected THEN RETURN false; END IF;
 updated:=jsonb_set(r,'{managedPreparationCleanup}',coalesce(r->'managedPreparationCleanup','{}'::jsonb)||jsonb_build_object(p_stage,receipt));
 IF public.valid_managed_preparation_cleanup_append(r,updated) IS NOT TRUE THEN RETURN false; END IF;
 UPDATE public.personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata,'{erasure}',updated) WHERE user_id=p_owner;
 RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.hosted_pod_cleanup_admitted(
 p_owner text, p_attempt text, expected jsonb
) RETURNS boolean LANGUAGE sql SET search_path=public AS $$
 SELECT EXISTS (
  SELECT 1 FROM public.personal_agent_registry r
  JOIN public.hosted_pod_pilot_policy p ON p.singleton
  CROSS JOIN LATERAL (SELECT expected->'registrySnapshot'->'backend_metadata'->'provisionAttempt' AS value) a
  WHERE r.user_id=p_owner AND r.status='suspended' AND r.deployment_target='gcp'
  AND r.backend_metadata->'erasure'=expected
  AND expected->>'ownerId'=p_owner AND expected->>'attemptId'=p_attempt
  AND expected->>'hushhId'=r.hushh_id
  AND public.erasure_private_coordinates(expected) IS NOT NULL
  AND a.value->>'ownerId'=p_owner
  AND p.environment='dev' AND p.policy_id::text=a.value->'hostedAdmission'->>'policyId'
  AND p.source_revision=a.value->'hostedAdmission'->>'sourceRevision'
  AND p.image_digest=a.value->'hostedAdmission'->>'imageDigest'
  AND p.model_binding=a.value->'hostedAdmission'->'modelBinding'
  AND coalesce(a.value->'evidence'->'reserved'->'hostedCheckpoint'->>'phase','')<>'intent'
  AND coalesce(a.value->'evidence'->'reserved'->'hostedPreparation'->>'phase','')<>'intent'
  AND EXISTS (
   SELECT 1 FROM jsonb_array_elements(p.assignments) WITH ORDINALITY x(assignment,n)
   WHERE x.assignment=a.value->'hostedAdmission'->'assignment'
   AND CASE WHEN n=1 THEN p.attempt_a ELSE p.attempt_b END=a.value->>'attemptId'
  )
 );
$$;

-- Forward refinement of canonical420; other cloud branches unchanged.
CREATE OR REPLACE FUNCTION public.valid_erasure_writer_receipt(reservation jsonb, stage text, receipt jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE snapshot jsonb; inventory jsonb; runtime_identity jsonb; bootstrap_identity jsonb; project text; bootstrap_ref text;
BEGIN
 snapshot := reservation->'registrySnapshot'; inventory := reservation->'substrateInventory';
 IF public.valid_erasure_substrate_inventory(reservation,inventory) IS DISTINCT FROM true
    OR stage NOT IN ('writerAdmission','writerDisabled') OR stage IS NULL
    OR jsonb_typeof(receipt) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 runtime_identity := receipt->'runtimeIdentity'; bootstrap_identity := receipt->'bootstrapIdentity';
 project := (public.private_gcp_coordinates(snapshot)->>'project');
 bootstrap_ref := regexp_replace((public.private_gcp_coordinates(snapshot)->>'bootstrap'),'^serviceAccount:','');
 IF project IS NULL OR project !~ '^[a-z][a-z0-9-]{4,61}[a-z0-9]$'
    OR receipt->>'ownerId' IS DISTINCT FROM reservation->>'ownerId'
    OR receipt->>'attemptId' IS DISTINCT FROM reservation->>'attemptId'
    OR receipt - ARRAY['ownerId','attemptId','runtimeIdentity','bootstrapIdentity','status'] <> '{}'::jsonb
    OR jsonb_typeof(runtime_identity) IS DISTINCT FROM 'object'
    OR jsonb_typeof(bootstrap_identity) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 IF runtime_identity->>'projectId' IS DISTINCT FROM project
    OR bootstrap_identity->>'projectId' IS DISTINCT FROM project
    OR runtime_identity->>'email' IS DISTINCT FROM snapshot->'backend_metadata'->>'runtime_service_account'
    OR runtime_identity->>'uniqueId' IS NULL OR runtime_identity->>'uniqueId' !~ '^[1-9][0-9]{0,31}$'
    OR bootstrap_identity->>'uniqueId' IS NULL OR bootstrap_identity->>'uniqueId' !~ '^[1-9][0-9]{0,31}$'
    OR runtime_identity->>'uniqueId' = bootstrap_identity->>'uniqueId'
    OR bootstrap_ref IS NULL
    OR bootstrap_ref NOT IN (bootstrap_identity->>'email',bootstrap_identity->>'uniqueId') THEN RETURN false; END IF;
 IF bootstrap_identity - ARRAY['name','email','projectId','uniqueId'] <> '{}'::jsonb
    OR bootstrap_identity->>'email' IS NULL
    OR bootstrap_identity->>'email' NOT LIKE '%@' || project || '.iam.gserviceaccount.com'
    OR bootstrap_identity->>'name' IS NULL
    OR bootstrap_identity->>'name' NOT IN ('projects/' || project || '/serviceAccounts/' || (bootstrap_identity->>'email'),
                                         'projects/' || project || '/serviceAccounts/' || (bootstrap_identity->>'uniqueId')) THEN RETURN false; END IF;
 IF jsonb_typeof(inventory->'resourceObservations') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 IF (SELECT count(*) FROM jsonb_array_elements(inventory->'resourceObservations') AS r
     WHERE r->>'type'='service_account' AND r->>'disposition'='created'
       AND r->>'id'=runtime_identity->>'email' AND r->'identity'=runtime_identity) <> 1
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(inventory->'plannedResources') AS r
                   WHERE r->>'type'='service_account' AND r->>'id'=runtime_identity->>'email') THEN RETURN false; END IF;
 IF stage='writerAdmission' THEN RETURN receipt->>'status'='admitted'; END IF;
 RETURN receipt->>'status'='disabled'
    AND public.valid_erasure_writer_receipt(reservation,'writerAdmission',reservation->'writerAdmission')
    AND receipt - 'status' = (reservation->'writerAdmission') - 'status';
END;
$function$;

-- Forward refinement of canonical420; other cloud branches unchanged.
CREATE OR REPLACE FUNCTION public.valid_erasure_kms_receipt(r jsonb, stage text, receipt jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE obs jsonb; ident jsonb; inv jsonb; captured jsonb; version_name text; key_name text; kind text;
BEGIN
 IF stage IS NULL OR stage NOT IN ('inventory','admission','acknowledgement','destruction','completion')
 OR jsonb_typeof(receipt) IS DISTINCT FROM 'object'
 OR public.valid_erasure_bucket_receipt(r,'bucketDeletion',r->'bucketDeletion') IS DISTINCT FROM true THEN RETURN false; END IF;
 -- 956: every independently named mail resource must be deleted before key destruction.
 IF public.erasure_mail_resources_deleted(r) IS DISTINCT FROM true THEN RETURN false; END IF;
 inv:=r->'substrateInventory'; obs:=receipt->'resourceObservation'; ident:=obs->'identity';
 key_name:='projects/' || ((public.erasure_private_coordinates(r)->>'project')) || '/locations/' || ((public.erasure_private_coordinates(r)->>'region')) || '/keyRings/hushh-one/cryptoKeys/' || (obs->>'id');
 IF receipt->>'ownerId' IS DISTINCT FROM r->>'ownerId' OR receipt->>'attemptId' IS DISTINCT FROM r->>'attemptId'
 OR jsonb_typeof(obs) IS DISTINCT FROM 'object' OR obs - ARRAY['type','id','disposition','identity'] <> '{}'::jsonb
 OR obs->>'type' IS DISTINCT FROM 'kms_key' OR obs->>'disposition' IS DISTINCT FROM 'created'
 OR obs->>'id' IS NULL OR obs->>'id' !~ '^[A-Za-z0-9_-]{1,63}$'
 OR jsonb_typeof(ident) IS DISTINCT FROM 'object' OR ident - ARRAY['name','purpose','createTime'] <> '{}'::jsonb
 OR key_name IS NULL OR ident->>'name' IS DISTINCT FROM key_name OR ident->>'purpose' IS DISTINCT FROM 'ENCRYPT_DECRYPT'
 OR jsonb_typeof(ident->'createTime') IS DISTINCT FROM 'string' OR length(ident->>'createTime') NOT BETWEEN 1 AND 64
 OR (SELECT count(*) FROM jsonb_array_elements(inv->'plannedResources') x WHERE x->>'type'='kms_key') <> 1
 OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(inv->'plannedResources') x WHERE x->>'type'='kms_key' AND x->>'id'=obs->>'id')
 OR (SELECT count(*) FROM jsonb_array_elements(inv->'resourceObservations') x WHERE x=obs) <> 1 THEN RETURN false; END IF;
 IF stage='inventory' THEN
  IF receipt - ARRAY['ownerId','attemptId','resourceObservation','versionNames'] <> '{}'::jsonb
  OR jsonb_typeof(receipt->'versionNames') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(receipt->'versionNames') > 32000 THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(receipt->'versionNames') x WHERE jsonb_typeof(x) <> 'string'
    OR left(x #>> '{}',length(key_name || '/cryptoKeyVersions/')) <> key_name || '/cryptoKeyVersions/'
    OR substring(x #>> '{}' FROM length(key_name || '/cryptoKeyVersions/')+1) !~ '^[0-9]{1,20}$') THEN RETURN false; END IF;
  RETURN (SELECT count(*)=count(DISTINCT x) FROM jsonb_array_elements(receipt->'versionNames') x);
 END IF;
 captured:=r->'kmsErasure'->'inventory';
 IF public.valid_erasure_kms_receipt(r,'inventory',captured) IS DISTINCT FROM true
 OR receipt->'resourceObservation' IS DISTINCT FROM captured->'resourceObservation' THEN RETURN false; END IF;
 IF stage='completion' THEN
  IF receipt - 'status' IS DISTINCT FROM captured OR receipt->>'status' IS DISTINCT FROM 'destroyed' THEN RETURN false; END IF;
  FOR version_name IN SELECT jsonb_array_elements_text(captured->'versionNames') LOOP
   IF public.valid_erasure_kms_receipt(r,'destruction',r->'kmsErasure'->'versions'->version_name->'destruction') IS DISTINCT FROM true THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
 END IF;
 version_name:=receipt->>'versionName';
 IF receipt - ARRAY['ownerId','attemptId','resourceObservation','versionName','status'] <> '{}'::jsonb
 OR version_name IS NULL OR NOT (captured->'versionNames' ? version_name) THEN RETURN false; END IF;
 IF stage='admission' THEN RETURN receipt->>'status'='admitted'; END IF;
 IF stage='destruction' THEN RETURN receipt->>'status'='destroyed'; END IF;
 RETURN receipt->>'status'='scheduled'
 AND public.valid_erasure_kms_receipt(r,'admission',r->'kmsErasure'->'versions'->version_name->'admission') IS TRUE;
END;
$function$;

-- Forward refinement of canonical420; other cloud branches unchanged.
CREATE OR REPLACE FUNCTION public.valid_erasure_secret_receipt(r jsonb, stage text, receipt jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE obs jsonb; ident jsonb; inv jsonb; admitted jsonb; project text;
BEGIN
 IF stage IS NULL OR stage NOT IN ('admission','acknowledgement','deletion')
 OR jsonb_typeof(receipt) IS DISTINCT FROM 'object'
 OR public.valid_erasure_kms_receipt(r,'completion',r->'kmsErasure'->'completion') IS DISTINCT FROM true THEN RETURN false; END IF;
 obs:=receipt->'resourceObservation'; ident:=obs->'identity'; inv:=r->'substrateInventory'; project:=(public.erasure_private_coordinates(r)->>'project');
 IF receipt - ARRAY['ownerId','attemptId','resourceObservation','etag','status'] <> '{}'::jsonb
 OR receipt->>'ownerId' IS DISTINCT FROM r->>'ownerId' OR receipt->>'attemptId' IS DISTINCT FROM r->>'attemptId'
 OR jsonb_typeof(receipt->'etag') IS DISTINCT FROM 'string' OR length(btrim(receipt->>'etag')) NOT BETWEEN 1 AND 512
 OR jsonb_typeof(obs) IS DISTINCT FROM 'object' OR obs - ARRAY['type','id','disposition','identity'] <> '{}'::jsonb
 OR obs->>'type' IS DISTINCT FROM 'secret' OR obs->>'disposition' IS DISTINCT FROM 'created'
 OR obs->>'id' IS NULL OR obs->>'id' !~ '^[A-Za-z0-9_-]{1,255}$'
 OR jsonb_typeof(ident) IS DISTINCT FROM 'object' OR ident - ARRAY['name','projectId','projectNumber','createTime'] <> '{}'::jsonb
 OR project IS NULL OR ident->>'projectId' IS DISTINCT FROM project
 OR jsonb_typeof(ident->'createTime') IS DISTINCT FROM 'string' OR length(ident->>'createTime') NOT BETWEEN 1 AND 64
 OR (SELECT count(*) FROM jsonb_array_elements(inv->'plannedResources') x WHERE x->>'type'='secret') <> 1
 OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(inv->'plannedResources') x WHERE x->>'type'='secret' AND x->>'id'=obs->>'id')
 OR (SELECT count(*) FROM jsonb_array_elements(inv->'resourceObservations') x WHERE x=obs) <> 1 THEN RETURN false; END IF;
 IF ident ? 'projectNumber' AND (jsonb_typeof(ident->'projectNumber') IS DISTINCT FROM 'string' OR ident->>'projectNumber' !~ '^[1-9][0-9]{0,19}$') THEN RETURN false; END IF;
 IF ident->>'name' IS DISTINCT FROM 'projects/' || project || '/secrets/' || (obs->>'id')
 AND (NOT (ident ? 'projectNumber') OR ident->>'name' IS DISTINCT FROM 'projects/' || (ident->>'projectNumber') || '/secrets/' || (obs->>'id')) THEN RETURN false; END IF;
 IF stage='admission' THEN RETURN receipt->>'status'='admitted'; END IF;
 admitted:=r->'secretErasure'->'admission';
 IF jsonb_typeof(admitted) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 IF admitted->>'status' IS DISTINCT FROM 'admitted' OR receipt - 'status' IS DISTINCT FROM admitted - 'status' THEN RETURN false; END IF;
 IF stage='acknowledgement' THEN RETURN receipt->>'status'='acknowledged'; END IF;
 admitted:=r->'secretErasure'->'acknowledgement';
 IF jsonb_typeof(admitted) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 RETURN receipt->>'status'='absent' AND admitted->>'status' IS NOT DISTINCT FROM 'acknowledged'
   AND receipt - 'status' IS NOT DISTINCT FROM admitted - 'status';
END;
$function$;

-- Forward refinement of canonical420; other cloud branches unchanged.
CREATE OR REPLACE FUNCTION public.valid_erasure_files_receipt(r jsonb, kind text, stage text, receipt jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE inv jsonb:=r->'substrateInventory'; obs jsonb:=receipt->'resourceObservation'; identity jsonb:=obs->'identity';
 project text:=(public.erasure_private_coordinates(r)->>'project'); region text:=(public.erasure_private_coordinates(r)->>'region');
 slug text:='one-files-'||left(encode(sha256(convert_to(r->>'hushhId','UTF8')),'hex'),20);
 rid text; rtype text; admitted jsonb;
BEGIN
 IF kind IS NULL OR kind NOT IN ('queue','worker') OR stage IS NULL OR stage NOT IN ('admission','quiescence','acknowledgement','deletion')
 OR public.valid_erasure_writer_receipt(r,'writerDisabled',r->'writerDisabled') IS DISTINCT FROM true
 OR public.valid_erasure_compute_receipt(r,'computeDeletion',r->'computeDeletion') IS DISTINCT FROM true
 OR jsonb_typeof(receipt) IS DISTINCT FROM 'object'
 OR receipt-ARRAY['ownerId','attemptId','resourceObservation','status']<>'{}'::jsonb
 OR receipt->>'ownerId' IS DISTINCT FROM r->>'ownerId' OR receipt->>'attemptId' IS DISTINCT FROM r->>'attemptId'
 OR public.erasure_private_coordinates(r) IS NULL
 OR project IS NULL OR region IS NULL OR slug IS NULL
 OR jsonb_typeof(obs) IS DISTINCT FROM 'object' OR obs-ARRAY['type','id','disposition','identity']<>'{}'::jsonb
 OR obs->>'disposition' IS DISTINCT FROM 'created' THEN RETURN false; END IF;
 rtype:=CASE kind WHEN 'queue' THEN 'cloud_tasks_queue' ELSE 'service_account' END;
 rid:=CASE kind WHEN 'queue' THEN slug ELSE slug||'@'||project||'.iam.gserviceaccount.com' END;
 IF obs->>'type' IS DISTINCT FROM rtype OR obs->>'id' IS DISTINCT FROM rid
 OR (SELECT count(*) FROM jsonb_array_elements(inv->'plannedResources') x WHERE x->>'type'=rtype AND x->>'id'=rid)<>1
 OR (SELECT count(*) FROM jsonb_array_elements(inv->'resourceObservations') x WHERE x=obs)<>1 THEN RETURN false; END IF;
 IF kind='queue' THEN
   IF identity IS DISTINCT FROM jsonb_build_object('name','projects/'||project||'/locations/'||region||'/queues/'||rid,
     'rateLimits',jsonb_build_object('maxDispatchesPerSecond',1,'maxConcurrentDispatches',1),
     'retryConfig',jsonb_build_object('maxAttempts',3,'maxRetryDuration','0s','minBackoff','10s','maxBackoff','60s','maxDoublings',2)) THEN RETURN false; END IF;
 ELSE
   IF jsonb_typeof(identity) IS DISTINCT FROM 'object' OR identity-ARRAY['name','email','projectId','uniqueId']<>'{}'::jsonb
    OR (identity->>'name' IS DISTINCT FROM 'projects/'||project||'/serviceAccounts/'||rid AND identity->>'name' IS DISTINCT FROM 'projects/'||project||'/serviceAccounts/'||(identity->>'uniqueId'))
    OR identity->>'email' IS DISTINCT FROM rid OR identity->>'projectId' IS DISTINCT FROM project
    OR (coalesce(identity->>'uniqueId','') !~ '^[0-9]{1,32}$' OR identity->>'uniqueId' !~ '[1-9]')
    OR identity->>'email'=r->'writerDisabled'->'runtimeIdentity'->>'email'
    OR public.valid_erasure_files_receipt(r,'queue','deletion',r->'filesErasure'->'queue'->'deletion') IS DISTINCT FROM true THEN RETURN false; END IF;
 END IF;
 IF stage='admission' THEN RETURN receipt->>'status'='admitted'; END IF;
 admitted:=r->'filesErasure'->kind->'admission';
 IF public.valid_erasure_files_receipt(r,kind,'admission',admitted) IS DISTINCT FROM true OR receipt-'status' IS DISTINCT FROM admitted-'status' THEN RETURN false; END IF;
 IF stage='quiescence' THEN RETURN receipt->>'status'='quiesced'; END IF;
 IF public.valid_erasure_files_receipt(r,kind,'quiescence',r->'filesErasure'->kind->'quiescence') IS DISTINCT FROM true THEN RETURN false; END IF;
 IF stage='acknowledgement' THEN RETURN receipt->>'status'='acknowledged'; END IF;
 RETURN receipt->>'status'='absent' AND public.valid_erasure_files_receipt(r,kind,'acknowledgement',r->'filesErasure'->kind->'acknowledgement') IS TRUE;
END;
$function$;

-- Forward refinement of canonical420; other cloud branches unchanged.
CREATE OR REPLACE FUNCTION public.valid_erasure_gcp_files_upgrade_observation(r jsonb, observation jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE snapshot jsonb:=r->'registrySnapshot'; metadata jsonb:=snapshot->'backend_metadata';
 approval jsonb:=metadata->'upgradeApproval'; plan jsonb:=approval->'capabilityPlan';
 intent jsonb:=metadata->'filesUpgradeCheckpoint'; prefix jsonb:=intent->'completed';
 completed jsonb:=observation->'completed'; result jsonb; resource jsonb; ident jsonb; binding jsonb;
 project text:=plan->>'project'; region text:=plan->>'region'; step text:=intent->>'step';
 slug text:='one-files-'||left(encode(sha256(convert_to(r->>'hushhId','UTF8')),'hex'),20);
 worker text; queue text; expected_role text; expected_url text; expected_member text; project_number text;
 steps text[]:=ARRAY['enable_services','generate_files_task_identity','iam_files_task_identity',
  'iam_files_queue_admin','files_worker_account','files_queue','iam_files_enqueuer','iam_files_worker_actas',
  'iam_files_bucket_metadata','iam_files_invoker'];
BEGIN
 IF jsonb_typeof(observation) IS DISTINCT FROM 'object'
 OR observation-ARRAY['version','planDigest','operationId','attemptId','phase','step','completed']<>'{}'::jsonb
 OR observation->'version' IS DISTINCT FROM '1'::jsonb OR observation->>'phase' IS DISTINCT FROM 'observed'
 OR octet_length(observation::text)>65536
 OR r->>'ownerId' IS DISTINCT FROM snapshot->>'user_id'
 OR public.private_gcp_coordinates(snapshot) IS NULL
 OR plan->>'ownerId' IS DISTINCT FROM r->>'ownerId' OR plan->>'hushhId' IS DISTINCT FROM r->>'hushhId'
 OR plan->>'serviceUid' IS DISTINCT FROM metadata->>'serviceUid'
 OR plan->>'targetImage' IS DISTINCT FROM approval->>'targetImage'
 OR plan->>'project' IS DISTINCT FROM (public.private_gcp_coordinates(snapshot)->>'project')
 OR plan->>'region' IS DISTINCT FROM (public.private_gcp_coordinates(snapshot)->>'region')
 OR plan->>'service' IS DISTINCT FROM snapshot->>'external_agent_id'
 OR plan->>'runtimeAccount' IS DISTINCT FROM metadata->>'runtime_service_account'
 OR plan->>'bootstrapAccount' IS DISTINCT FROM (public.private_gcp_coordinates(snapshot)->>'bootstrap')
 OR coalesce(metadata->>'upgradeLease','')='' OR intent->>'phase' IS DISTINCT FROM 'intent'
 OR intent->>'planDigest' IS DISTINCT FROM approval->>'capabilityPlanDigest'
 OR coalesce(intent->>'planDigest','') !~ '^[a-f0-9]{64}$'
 OR intent->>'operationId' IS DISTINCT FROM approval->>'operationId'
 OR coalesce(intent->>'operationId','')=''
 OR intent->>'attemptId' IS DISTINCT FROM encode(sha256(convert_to(metadata->>'upgradeLease','UTF8')),'hex')
 OR observation-ARRAY['phase','completed'] IS DISTINCT FROM intent-ARRAY['phase','completed']
 OR jsonb_typeof(prefix) IS DISTINCT FROM 'array' OR jsonb_typeof(completed) IS DISTINCT FROM 'array'
 THEN RETURN false; END IF;
 IF jsonb_array_length(prefix)>=cardinality(steps)
 OR step IS DISTINCT FROM steps[jsonb_array_length(prefix)+1]
 OR jsonb_array_length(completed)<>jsonb_array_length(prefix)+1
 OR completed-(jsonb_array_length(completed)-1) IS DISTINCT FROM prefix THEN RETURN false; END IF;
 result:=completed->-1;
 IF jsonb_typeof(result) IS DISTINCT FROM 'object'
 OR result-ARRAY['step','status','ok','skipped','resourceObservation','bindingObservations']<>'{}'::jsonb
 OR result->>'step' IS DISTINCT FROM step OR jsonb_typeof(result->'ok') IS DISTINCT FROM 'boolean'
 OR jsonb_typeof(result->'status') IS DISTINCT FROM 'number'
 OR coalesce(result->>'status','') !~ '^[0-9]{1,3}$'
 OR (result ? 'skipped' AND result->'skipped' IS DISTINCT FROM 'false'::jsonb)
 THEN RETURN false; END IF;
 SELECT x->'identity'->>'projectNumber' INTO project_number
 FROM jsonb_array_elements(metadata->'substrateReceipt'->'resourceObservations') x
 WHERE x->>'type'='gcs_bucket' AND x->>'id'=plan->>'bucket'
 AND x->'identity'->>'name'=plan->>'bucket';
 IF coalesce(project_number,'') !~ '^[1-9][0-9]{0,19}$' THEN RETURN false; END IF;
 worker:=slug||'@'||project||'.iam.gserviceaccount.com';
 queue:='projects/'||project||'/locations/'||region||'/queues/'||slug;
 resource:=result->'resourceObservation';
 IF resource IS NOT NULL THEN
  IF result->'ok' IS DISTINCT FROM 'true'::jsonb OR result->>'status' NOT IN ('200','201')
  OR jsonb_typeof(resource) IS DISTINCT FROM 'object'
  OR resource-ARRAY['type','id','disposition','identity']<>'{}'::jsonb
  OR resource->>'disposition' IS DISTINCT FROM 'created'
  OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(metadata->'substrateReceipt'->'plannedResources') x
     WHERE x=jsonb_build_object('type',resource->>'type','id',resource->>'id')) THEN RETURN false; END IF;
  ident:=resource->'identity';
  IF step='files_queue' THEN
   IF resource->>'type' IS DISTINCT FROM 'cloud_tasks_queue' OR resource->>'id' IS DISTINCT FROM slug
   OR ident IS DISTINCT FROM jsonb_build_object('name',queue,
    'rateLimits',jsonb_build_object('maxDispatchesPerSecond',1,'maxConcurrentDispatches',1),
    'retryConfig',jsonb_build_object('maxAttempts',3,'maxRetryDuration','0s','minBackoff','10s','maxBackoff','60s','maxDoublings',2))
   THEN RETURN false; END IF;
  ELSIF step='files_worker_account' THEN
   IF resource->>'type' IS DISTINCT FROM 'service_account' OR resource->>'id' IS DISTINCT FROM worker
   OR jsonb_typeof(ident) IS DISTINCT FROM 'object' OR ident-ARRAY['name','email','projectId','uniqueId']<>'{}'::jsonb
   OR ident->>'email' IS DISTINCT FROM worker OR ident->>'projectId' IS DISTINCT FROM project
   OR (coalesce(ident->>'uniqueId','') !~ '^[0-9]{1,32}$' OR ident->>'uniqueId' !~ '[1-9]')
   OR (ident->>'name' IS DISTINCT FROM 'projects/'||project||'/serviceAccounts/'||worker
       AND ident->>'name' IS DISTINCT FROM 'projects/'||project||'/serviceAccounts/'||(ident->>'uniqueId'))
   THEN RETURN false; END IF;
  ELSE RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(metadata->'substrateReceipt'->'resourceObservations','[]'::jsonb)) x
    WHERE x->>'type'=resource->>'type' AND x->>'id'=resource->>'id' AND x<>resource) THEN RETURN false; END IF;
 END IF;
 IF result ? 'bindingObservations' THEN
  IF jsonb_typeof(result->'bindingObservations') IS DISTINCT FROM 'array'
  OR jsonb_array_length(result->'bindingObservations')>1 THEN RETURN false; END IF;
  IF jsonb_array_length(result->'bindingObservations')>0 AND
    (result->'ok' IS DISTINCT FROM 'true'::jsonb OR result->>'status' NOT IN ('200','201')) THEN RETURN false; END IF;
  CASE step
   WHEN 'iam_files_queue_admin' THEN
    expected_role:='roles/cloudtasks.queueAdmin'; expected_member:='serviceAccount:'||(plan->>'bootstrapAccount');
    expected_url:='https://cloudresourcemanager.googleapis.com/v1/projects/'||project||':getIamPolicy';
   WHEN 'iam_files_task_identity' THEN
    expected_role:='roles/cloudtasks.serviceAgent'; expected_member:='serviceAccount:service-'||project_number||'@gcp-sa-cloudtasks.iam.gserviceaccount.com';
    expected_url:='https://cloudresourcemanager.googleapis.com/v1/projects/'||project||':getIamPolicy';
   WHEN 'iam_files_enqueuer' THEN
    expected_role:='roles/cloudtasks.enqueuer'; expected_member:='serviceAccount:'||(plan->>'runtimeAccount');
    expected_url:='https://cloudtasks.googleapis.com/v2/'||queue||':getIamPolicy';
   WHEN 'iam_files_worker_actas' THEN
    expected_role:='roles/iam.serviceAccountUser'; expected_member:='serviceAccount:'||(plan->>'runtimeAccount');
    expected_url:='https://iam.googleapis.com/v1/projects/'||project||'/serviceAccounts/'||worker||':getIamPolicy';
   WHEN 'iam_files_bucket_metadata' THEN
    expected_role:='roles/storage.legacyBucketReader'; expected_member:='serviceAccount:'||(plan->>'runtimeAccount');
    expected_url:='https://storage.googleapis.com/storage/v1/b/'||(plan->>'bucket')||'/iam';
   WHEN 'iam_files_invoker' THEN
    expected_role:='roles/run.invoker'; expected_member:='serviceAccount:'||worker;
    expected_url:='https://'||region||'-run.googleapis.com/v1/projects/'||project||'/locations/'||region||'/services/'||(plan->>'service')||':getIamPolicy';
   ELSE RETURN false;
  END CASE;
  FOR binding IN SELECT value FROM jsonb_array_elements(result->'bindingObservations') LOOP
   IF jsonb_typeof(binding) IS DISTINCT FROM 'object'
   OR binding-ARRAY['step','policyResource','role','member','disposition','beforeEtag','afterEtag']<>'{}'::jsonb
   OR binding->>'step' IS DISTINCT FROM step OR binding->>'policyResource' IS DISTINCT FROM expected_url
   OR binding->>'role' IS DISTINCT FROM expected_role
   OR coalesce(binding->>'disposition','') NOT IN ('added','already_present')
   OR jsonb_typeof(binding->'beforeEtag') IS DISTINCT FROM 'string' OR length(binding->>'beforeEtag') NOT BETWEEN 1 AND 512
   OR jsonb_typeof(binding->'afterEtag') IS DISTINCT FROM 'string' OR length(binding->>'afterEtag') NOT BETWEEN 1 AND 512
   OR (expected_member IS NOT NULL AND binding->>'member' IS DISTINCT FROM expected_member)
   OR (expected_member IS NULL AND coalesce(binding->>'member','') !~ '^serviceAccount:service-[1-9][0-9]*@gcp-sa-cloudtasks[.]iam[.]gserviceaccount[.]com$')
   THEN RETURN false; END IF;
  END LOOP;
 END IF;
 RETURN true;
END;
$function$;

-- Forward refinement of canonical420; other cloud branches unchanged.
CREATE OR REPLACE FUNCTION public.valid_erasure_mail_receipt(reservation jsonb, kind text, stage text, receipt jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE inventory jsonb; observation jsonb; identity jsonb; project text; resource_name text; dependency text; admitted jsonb; dependency_resource jsonb; states jsonb; terms jsonb; origin text;
BEGIN
 IF public.valid_erasure_writer_receipt(reservation,'writerDisabled',reservation->'writerDisabled') IS DISTINCT FROM true
    OR kind IS NULL OR kind NOT IN ('cloud_scheduler_job','pubsub_subscription','pubsub_topic')
    OR stage IS NULL OR stage NOT IN ('admission','acknowledgement','deletion')
    OR jsonb_typeof(receipt) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 inventory:=reservation->'substrateInventory'; observation:=receipt->'resourceObservation'; identity:=observation->'identity';
 project:=(public.erasure_private_coordinates(reservation)->>'project');
 terms:=reservation->'registrySnapshot'->'backend_metadata'->'notificationCheckpoint';
 IF receipt->>'ownerId' IS DISTINCT FROM reservation->>'ownerId'
    OR receipt->>'attemptId' IS DISTINCT FROM reservation->>'attemptId'
    OR receipt - ARRAY['ownerId','attemptId','resourceObservation','status'] <> '{}'::jsonb
    OR jsonb_typeof(observation) IS DISTINCT FROM 'object'
    OR observation - ARRAY['type','id','disposition','identity'] <> '{}'::jsonb
    OR observation->>'type' IS DISTINCT FROM kind OR observation->>'disposition' IS DISTINCT FROM 'created'
    OR observation->>'id' IS NULL OR (observation->>'id' !~ '^[A-Za-z0-9_.~-]{1,255}$' AND (
      kind='pubsub_topic' AND terms->>'ownerId'=reservation->>'ownerId'
      AND terms->>'hushhId'=reservation->>'hushhId' AND terms->>'project'=project
      AND observation->>'id'='projects/'||(terms->'plan'->>'oauthProject')||'/topics/one-mail-'||
        left(trim(both '-' from regexp_replace(lower(reservation->>'hushhId'),'[^a-z0-9-]+','-','g')),40)) IS NOT TRUE)
    OR jsonb_typeof(identity) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 resource_name := CASE WHEN kind='pubsub_topic' AND starts_with(observation->>'id','projects/')
 THEN observation->>'id' ELSE 'projects/' || project || '/' || CASE kind
    WHEN 'cloud_scheduler_job' THEN 'locations/' || ((public.erasure_private_coordinates(reservation)->>'region')) || '/jobs/'
    WHEN 'pubsub_subscription' THEN 'subscriptions/' ELSE 'topics/' END || (observation->>'id') END;
 IF resource_name IS NULL OR identity->>'name' IS DISTINCT FROM resource_name THEN RETURN false; END IF;
 IF starts_with(observation->>'id','projects/') AND public.operator_mail_grants_qualified(reservation,observation->>'id') IS NOT TRUE THEN RETURN false; END IF;
 IF (SELECT count(*) FROM jsonb_array_elements(inventory->'plannedResources') AS r WHERE r->>'type'=kind AND r->>'id'=observation->>'id') <> 1
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(inventory->'plannedResources') AS r WHERE r->>'type'=kind AND r->>'id'=observation->>'id')
    OR (SELECT count(*) FROM jsonb_array_elements(inventory->'resourceObservations') AS r WHERE r=observation) <> 1 THEN RETURN false; END IF;
 IF kind='pubsub_topic' AND identity - 'name' <> '{}'::jsonb THEN RETURN false; END IF;
 -- 956: a direct subscription may attach only to this operation's operator topic.
 terms:=reservation->'registrySnapshot'->'backend_metadata'->'notificationCheckpoint';
 IF kind='pubsub_subscription' AND (identity - ARRAY['name','topic'] <> '{}'::jsonb
    OR (EXISTS (SELECT 1 FROM jsonb_array_elements(inventory->'plannedResources') AS r WHERE r->>'type'='pubsub_topic' AND identity->>'topic'='projects/' || project || '/topics/' || (r->>'id'))
      OR (terms->>'ownerId'=reservation->>'ownerId' AND terms->>'hushhId'=reservation->>'hushhId' AND terms->>'project'=project
       AND observation->>'id'='one-mail-'||left(trim(both '-' from regexp_replace(lower(reservation->>'hushhId'),'[^a-z0-9-]+','-','g')),40)||'-direct-sub'
       AND identity->>'topic'='projects/'||(terms->'plan'->>'oauthProject')||'/topics/one-mail-'||left(trim(both '-' from regexp_replace(lower(reservation->>'hushhId'),'[^a-z0-9-]+','-','g')),40))) IS DISTINCT FROM true) THEN RETURN false; END IF;
 IF kind='cloud_scheduler_job' AND NOT (identity ? 'httpTarget') AND (identity - ARRAY['name','pubsubTarget','schedule','timeZone'] <> '{}'::jsonb
    OR jsonb_typeof(identity->'pubsubTarget') IS DISTINCT FROM 'object'
    OR (identity->'pubsubTarget') - 'topicName' <> '{}'::jsonb
    OR jsonb_typeof(identity->'schedule') IS DISTINCT FROM 'string' OR length(identity->>'schedule') NOT BETWEEN 1 AND 128
    OR jsonb_typeof(identity->'timeZone') IS DISTINCT FROM 'string' OR length(identity->>'timeZone') NOT BETWEEN 1 AND 128
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(inventory->'plannedResources') AS r WHERE r->>'type'='pubsub_topic' AND identity->'pubsubTarget'->>'topicName'='projects/' || project || '/topics/' || (r->>'id'))) THEN RETURN false; END IF;
 IF kind='cloud_scheduler_job' AND identity ? 'httpTarget' THEN
  origin:=identity->'httpTarget'->'oidcToken'->>'audience';
  IF terms->>'ownerId' IS DISTINCT FROM reservation->>'ownerId' OR terms->>'project' IS DISTINCT FROM project
   OR terms->>'serviceUid' IS DISTINCT FROM reservation->'registrySnapshot'->'backend_metadata'->>'serviceUid'
   OR coalesce(origin,'') !~ '^https://[a-z0-9][a-z0-9.-]+$'
   OR identity IS DISTINCT FROM jsonb_build_object('name',resource_name,'schedule','0 4 * * *','timeZone','Etc/UTC',
      'httpTarget',jsonb_build_object('uri',origin||'/api/one/pod/maintenance/tick','httpMethod','POST',
       'oidcToken',jsonb_build_object('audience',origin,'serviceAccountEmail',terms->'plan'->>'runtimeAccount')))
   OR origin IS DISTINCT FROM rtrim(reservation->'registrySnapshot'->'backend_metadata'->>'url','/') THEN RETURN false; END IF;
 END IF;
 IF stage='admission' THEN
    dependency := CASE kind WHEN 'pubsub_subscription' THEN 'cloud_scheduler_job' WHEN 'pubsub_topic' THEN 'pubsub_subscription' ELSE NULL END;
    -- 956: every dependent resource needs its own qualified deletion.
    IF dependency IS NOT NULL THEN
     FOR dependency_resource IN SELECT value FROM jsonb_array_elements(inventory->'plannedResources') x WHERE x->>'type'=dependency LOOP
      states:=public.erasure_mail_resource_state(reservation,dependency,dependency_resource->>'id');
      IF public.valid_erasure_mail_receipt(reservation,dependency,'deletion',states->'deletion') IS DISTINCT FROM true THEN RETURN false; END IF;
     END LOOP;
    END IF;
    RETURN receipt->>'status'='admitted';
 END IF;
 states:=public.erasure_mail_resource_state(reservation,kind,observation->>'id');
 admitted:=states->'admission';
 IF public.valid_erasure_mail_receipt(reservation,kind,'admission',admitted) IS DISTINCT FROM true
    OR receipt - 'status' IS DISTINCT FROM admitted - 'status' THEN RETURN false; END IF;
 IF stage='acknowledgement' THEN RETURN receipt->>'status'='acknowledged'; END IF;
 RETURN receipt->>'status'='absent' AND public.valid_erasure_mail_receipt(reservation,kind,'acknowledgement',states->'acknowledgement');
END;
$function$;

-- Forward refinement of canonical420; other cloud branches unchanged.
CREATE OR REPLACE FUNCTION public.valid_erasure_grant_release(r jsonb, receipt jsonb)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
 SELECT jsonb_typeof(receipt)='object'
 AND receipt - ARRAY['ownerId','attemptId','project','status']='{}'::jsonb
 AND receipt->>'ownerId'=r->>'ownerId' AND receipt->>'attemptId'=r->>'attemptId'
 AND receipt->>'project'=(public.erasure_private_coordinates(r)->>'project')
 AND receipt->>'project' ~ '^[a-z][a-z0-9-]{4,61}[a-z0-9]$'
 AND receipt->>'status'='reserved'
 AND public.valid_erasure_account_receipt(r,'deletion',r->'accountErasure'->'deletion') IS TRUE;
$function$;

-- Forward refinement of canonical420; other cloud branches unchanged.
CREATE OR REPLACE FUNCTION public.valid_erasure_repository_grant_receipt(r jsonb, stage text, receipt jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE binding jsonb; identity jsonb; admitted jsonb;
BEGIN
 IF stage IS NULL OR stage NOT IN ('admission','acknowledgement','deletion') OR jsonb_typeof(receipt) IS DISTINCT FROM 'object'
 OR public.valid_erasure_grant_release(r,r->'grantRelease') IS DISTINCT FROM true THEN RETURN false; END IF;
 IF public.erasure_runtime_grants_complete(r) IS DISTINCT FROM true THEN RETURN false; END IF;
 identity:=receipt->'repositoryIdentity'; binding:=receipt->'bindingObservation';
 IF jsonb_typeof(identity) IS DISTINCT FROM 'object'
 OR identity - ARRAY['name','format','createTime']<>'{}'::jsonb
 OR identity->>'name' IS DISTINCT FROM 'projects/'||(r->'grantRelease'->>'project')||'/locations/'||((public.erasure_private_coordinates(r)->>'region'))||'/repositories/one-pod'
 OR identity->>'format' IS DISTINCT FROM 'DOCKER'
 OR (identity->>'createTime' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$') IS DISTINCT FROM true
 OR (SELECT count(*) FROM jsonb_array_elements(r->'substrateInventory'->'plannedResources') p WHERE p->>'type'='artifact_repository' AND p->>'id'='one-pod')<>1
 OR (SELECT count(*) FROM jsonb_array_elements(r->'substrateInventory'->'resourceObservations') o WHERE o=jsonb_build_object('type','artifact_repository','id','one-pod','disposition','created','identity',identity))<>1 THEN RETURN false; END IF;
 IF receipt - ARRAY['ownerId','attemptId','repositoryIdentity','bindingObservation','status']<>'{}'::jsonb
 OR receipt->>'ownerId' IS DISTINCT FROM r->>'ownerId' OR receipt->>'attemptId' IS DISTINCT FROM r->>'attemptId'
 OR receipt->'repositoryIdentity' IS DISTINCT FROM identity OR jsonb_typeof(binding) IS DISTINCT FROM 'object'
 OR binding - ARRAY['step','policyResource','role','member','disposition','beforeEtag','afterEtag']<>'{}'::jsonb
 OR binding->>'step' IS DISTINCT FROM 'artifact_repo_grant_copy_writer' OR binding->>'role' IS DISTINCT FROM 'roles/artifactregistry.writer'
 OR binding->>'disposition' IS DISTINCT FROM 'added'
 OR (binding->>'member' ~ '^serviceAccount:[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.gserviceaccount\.com$') IS DISTINCT FROM true
 OR binding->>'policyResource' IS DISTINCT FROM 'https://artifactregistry.googleapis.com/v1/'||(identity->>'name')||':getIamPolicy'
 OR coalesce(length(binding->>'beforeEtag'),0) NOT BETWEEN 1 AND 512 OR coalesce(length(binding->>'afterEtag'),0) NOT BETWEEN 1 AND 512
 OR (SELECT count(*) FROM jsonb_array_elements(r->'substrateInventory'->'bindingObservations') b WHERE b=binding)<>1 THEN RETURN false; END IF;
 IF stage='admission' THEN RETURN receipt->>'status'='admitted'; END IF;
 admitted:=r->'repositoryGrantErasure'->'admission';
 IF public.valid_erasure_repository_grant_receipt(r,'admission',admitted) IS DISTINCT FROM true OR receipt - 'status' IS DISTINCT FROM admitted - 'status' THEN RETURN false; END IF;
 IF stage='acknowledgement' THEN RETURN receipt->>'status'='acknowledged'; END IF;
 -- Fresh observed absence may reconcile a lost write acknowledgement; never fabricate it.
 RETURN receipt->>'status'='observed_absent';
END;
$function$;

-- Forward refinement of canonical420; other cloud branches unchanged.
CREATE OR REPLACE FUNCTION public.valid_erasure_repository_inventory(r jsonb, receipt jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE ident jsonb; image jsonb; prefix text; name_prefix text; admitted jsonb; deleted jsonb;
BEGIN
 -- The immutable predecessor was validated on its original guarded append.
 -- This unresolved observation adds no cleanup authority; do not recursively
 -- revalidate every earlier KMS/mail/account checkpoint for an inventory read.
 admitted:=r->'repositoryGrantErasure'->'admission'; deleted:=r->'repositoryGrantErasure'->'deletion';
 IF jsonb_typeof(admitted) IS DISTINCT FROM 'object' OR jsonb_typeof(deleted) IS DISTINCT FROM 'object'
 OR admitted->>'ownerId' IS DISTINCT FROM r->>'ownerId' OR admitted->>'attemptId' IS DISTINCT FROM r->>'attemptId'
 OR admitted->>'status' IS DISTINCT FROM 'admitted' OR deleted->>'status' IS DISTINCT FROM 'observed_absent'
 OR deleted - 'status' IS DISTINCT FROM admitted - 'status'
 OR jsonb_typeof(r->'substrateInventory'->'resourceObservations') IS DISTINCT FROM 'array'
 OR jsonb_typeof(receipt) IS DISTINCT FROM 'object' 
 OR receipt - ARRAY['ownerId','attemptId','repositoryIdentity','images','paginationComplete','classification']<>'{}'::jsonb
 OR receipt->>'ownerId' IS DISTINCT FROM r->>'ownerId'
 OR receipt->>'attemptId' IS DISTINCT FROM r->>'attemptId'
 OR receipt->'paginationComplete' IS DISTINCT FROM 'true'::jsonb
 OR receipt->>'classification' IS DISTINCT FROM 'unresolved'
 OR receipt->'repositoryIdentity' IS DISTINCT FROM r->'repositoryGrantErasure'->'deletion'->'repositoryIdentity'
 OR jsonb_typeof(receipt->'images') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 ident:=receipt->'repositoryIdentity';
 IF jsonb_typeof(ident) IS DISTINCT FROM 'object'
 OR ident->>'name' IS DISTINCT FROM 'projects/'||((public.erasure_private_coordinates(r)->>'project'))||'/locations/'||((public.erasure_private_coordinates(r)->>'region'))||'/repositories/one-pod'
 OR (SELECT count(*) FROM jsonb_array_elements(r->'substrateInventory'->'resourceObservations') o
     WHERE o=jsonb_build_object('type','artifact_repository','id','one-pod','disposition','created','identity',ident))<>1 THEN RETURN false; END IF;
 prefix:=((public.erasure_private_coordinates(r)->>'region'))||'-docker.pkg.dev/'||(r->'grantRelease'->>'project')||'/one-pod/';
 name_prefix:=(ident->>'name')||'/dockerImages/';
 IF jsonb_array_length(receipt->'images')>10000 THEN RETURN false; END IF;
 FOR image IN SELECT * FROM jsonb_array_elements(receipt->'images') LOOP
  IF jsonb_typeof(image) IS DISTINCT FROM 'object' OR image - ARRAY['name','uri']<>'{}'::jsonb
  OR jsonb_typeof(image->'name') IS DISTINCT FROM 'string' OR jsonb_typeof(image->'uri') IS DISTINCT FROM 'string'
  OR length(image->>'name') NOT BETWEEN 1 AND 2048 OR length(image->>'uri') NOT BETWEEN 1 AND 2048
  OR left(image->>'name',length(name_prefix)) IS DISTINCT FROM name_prefix
  OR left(image->>'uri',length(prefix)) IS DISTINCT FROM prefix
  OR (substring(image->>'uri' FROM length(prefix)+1) ~ '^[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$') IS DISTINCT FROM true
  OR substring(image->>'name' FROM length(name_prefix)+1) IS DISTINCT FROM substring(image->>'uri' FROM length(prefix)+1) THEN RETURN false; END IF;
 END LOOP;
 RETURN (SELECT count(*)=count(DISTINCT x->>'name') AND count(*)=count(DISTINCT x->>'uri') FROM jsonb_array_elements(receipt->'images') x);
END;
$function$;

-- Forward refinement of canonical420; other cloud branches unchanged.
CREATE OR REPLACE FUNCTION public.reserve_erasure_grant_release(owner_id text, attempt_id text, expected jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE current_row public.personal_agent_registry%ROWTYPE; r jsonb; project_id text; receipt jsonb;
BEGIN
 IF current_setting('transaction_isolation') <> 'read committed' THEN RETURN false; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 SELECT * INTO current_row FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 IF NOT FOUND OR current_row.status IS DISTINCT FROM 'suspended' THEN RETURN false; END IF;
 r:=current_row.backend_metadata->'erasure'; project_id:=(public.erasure_private_coordinates(r)->>'project');
 IF r->'registrySnapshot'->>'deployment_target'='gcp'
 AND public.hosted_pod_cleanup_admitted(owner_id,attempt_id,r) IS NOT TRUE THEN RETURN false; END IF;
 receipt:=jsonb_build_object('ownerId',owner_id,'attemptId',attempt_id,'project',project_id,'status','reserved');
 IF public.valid_erasure_grant_release(r,receipt) IS DISTINCT FROM true THEN RETURN false; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(project_id,205));
 IF NOT public.project_grant_release_is_exclusive(owner_id,project_id) THEN RETURN false; END IF;
 IF r ? 'grantRelease' THEN RETURN r->'grantRelease'=receipt; END IF;
 IF r IS DISTINCT FROM expected THEN RETURN false; END IF;
 UPDATE public.personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata,ARRAY['erasure','grantRelease'],receipt,true) WHERE user_id=owner_id;
 RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION public.valid_erasure_managed_model_grant_receipt(
 r jsonb, kind text, stage text, receipt jsonb
) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $$
DECLARE attempt jsonb:=r->'registrySnapshot'->'backend_metadata'->'provisionAttempt';
 result jsonb; identity jsonb; binding jsonb; base jsonb; entry jsonb;
BEGIN
 IF public.erasure_private_coordinates(r) IS NULL
 OR kind NOT IN ('vertex','quota') OR kind IS NULL
 OR stage NOT IN ('admission','acknowledgement','deletion') OR stage IS NULL
 OR jsonb_typeof(receipt) IS DISTINCT FROM 'object'
 OR public.valid_erasure_writer_receipt(r,'writerDisabled',r->'writerDisabled') IS NOT TRUE
 THEN RETURN false; END IF;
 SELECT x INTO result FROM jsonb_array_elements(attempt->'evidence'->'reserved'->'hostedPreparation'->'completed') x
 WHERE x->>'step'=CASE kind WHEN 'vertex' THEN 'inference_vertex' ELSE 'inference_quota' END;
 IF result->'ok' IS DISTINCT FROM 'true'::jsonb
 OR public.valid_hosted_preparation_result(attempt,result) IS NOT TRUE THEN RETURN false; END IF;
 identity:=result->'resourceObservation'->'identity'; binding:=result->'bindingObservations'->0;
 IF identity IS DISTINCT FROM r->'writerDisabled'->'runtimeIdentity' THEN RETURN false; END IF;
 base:=jsonb_build_object('ownerId',r->>'ownerId','attemptId',r->>'attemptId',
   'provisionAttemptId',attempt->>'attemptId','runtimeIdentity',identity,'bindingObservation',binding);
 IF receipt-'status' IS DISTINCT FROM base THEN RETURN false; END IF;
 IF stage='admission' THEN RETURN receipt->>'status'='admitted'; END IF;
 entry:=r->'managedModelGrantErasure'->kind;
 IF entry->'admission' IS DISTINCT FROM base||jsonb_build_object('status','admitted') THEN RETURN false; END IF;
 IF stage='acknowledgement' THEN
  RETURN binding->>'disposition'='added' AND receipt->>'status'='acknowledged';
 END IF;
 RETURN receipt->>'status'=CASE binding->>'disposition'
  WHEN 'added' THEN 'observed_absent' WHEN 'already_present' THEN 'preserved_preexisting' END;
END;
$$;

CREATE OR REPLACE FUNCTION public.valid_erasure_managed_model_grant_append(old_r jsonb,new_r jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $$
DECLARE kind text; stage text; old_map jsonb:=coalesce(old_r->'managedModelGrantErasure','{}'::jsonb);
 new_map jsonb:=new_r->'managedModelGrantErasure'; old_entry jsonb; new_entry jsonb;
BEGIN
 IF old_r-'managedModelGrantErasure' IS DISTINCT FROM new_r-'managedModelGrantErasure'
 OR jsonb_typeof(old_map) IS DISTINCT FROM 'object' OR jsonb_typeof(new_map) IS DISTINCT FROM 'object'
 OR new_map-ARRAY['vertex','quota']<>'{}'::jsonb THEN RETURN false; END IF;
 FOREACH kind IN ARRAY ARRAY['vertex','quota'] LOOP
  old_entry:=coalesce(old_map->kind,'{}'::jsonb); new_entry:=new_map->kind;
  IF new_entry IS NULL OR jsonb_typeof(old_entry)<>'object' OR jsonb_typeof(new_entry)<>'object'
   OR old_map-kind IS DISTINCT FROM new_map-kind
   OR new_entry-ARRAY['admission','acknowledgement','deletion']<>'{}'::jsonb THEN CONTINUE; END IF;
  FOREACH stage IN ARRAY ARRAY['admission','acknowledgement','deletion'] LOOP
   IF old_entry ? stage OR NOT (new_entry ? stage)
    OR new_entry-stage IS DISTINCT FROM old_entry OR old_entry ? 'deletion' THEN CONTINUE; END IF;
   IF stage='admission' AND old_entry<>'{}'::jsonb THEN CONTINUE; END IF;
   IF stage<>'admission' AND NOT (old_entry ? 'admission') THEN CONTINUE; END IF;
   IF public.valid_erasure_managed_model_grant_receipt(new_r,kind,stage,new_entry->stage) IS TRUE
   THEN RETURN true; END IF;
  END LOOP;
 END LOOP;
 RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.retain_erasure_managed_model_grant_receipt(
 p_owner text,p_attempt text,expected jsonb,kind text,stage text,receipt jsonb
) RETURNS boolean LANGUAGE plpgsql SET search_path=public AS $$
DECLARE r jsonb; updated jsonb; stages jsonb; grants jsonb;
BEGIN
 IF kind NOT IN ('vertex','quota') OR kind IS NULL
 OR stage NOT IN ('admission','acknowledgement','deletion') OR stage IS NULL THEN RETURN false; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_owner,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(p_owner,198));
 SELECT backend_metadata->'erasure' INTO r FROM public.personal_agent_registry WHERE user_id=p_owner FOR UPDATE;
 IF r IS DISTINCT FROM expected OR public.hosted_pod_cleanup_admitted(p_owner,p_attempt,r) IS NOT TRUE THEN RETURN false; END IF;
 IF r->'managedModelGrantErasure'->kind ? stage THEN
  RETURN r->'managedModelGrantErasure'->kind->stage=receipt
   AND public.valid_erasure_managed_model_grant_receipt(r,kind,stage,receipt) IS TRUE;
 END IF;
 stages:=coalesce(r->'managedModelGrantErasure'->kind,'{}'::jsonb)||jsonb_build_object(stage,receipt);
 grants:=coalesce(r->'managedModelGrantErasure','{}'::jsonb)||jsonb_build_object(kind,stages);
 updated:=r||jsonb_build_object('managedModelGrantErasure',grants);
 IF public.valid_erasure_managed_model_grant_append(r,updated) IS NOT TRUE THEN RETURN false; END IF;
 UPDATE public.personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata,'{erasure}',updated)
 WHERE user_id=p_owner;
 RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.erasure_managed_model_grants_complete(r jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $$
DECLARE attempt jsonb:=r->'registrySnapshot'->'backend_metadata'->'provisionAttempt';
 checkpoint jsonb:=attempt->'evidence'->'reserved'->'hostedPreparation';
 steps jsonb; grants jsonb:=coalesce(r->'managedModelGrantErasure','{}'::jsonb); kind text;
BEGIN
 IF public.erasure_private_coordinates(r) IS NULL
 OR checkpoint->>'phase' IS DISTINCT FROM 'observed'
 OR checkpoint->>'planDigest' IS DISTINCT FROM attempt->'hostedAdmission'->>'preparationContractHash'
 OR jsonb_typeof(checkpoint->'completed') IS DISTINCT FROM 'array'
 OR jsonb_typeof(grants) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
 SELECT jsonb_agg(x->>'step' ORDER BY n) INTO steps
 FROM jsonb_array_elements(checkpoint->'completed') WITH ORDINALITY t(x,n);
 IF steps NOT IN ('["create_project","link_billing","authorize_project"]'::jsonb,
  '["create_project","link_billing","authorize_project","inference_vertex"]'::jsonb,
  '["create_project","link_billing","authorize_project","inference_vertex","inference_quota"]'::jsonb)
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(checkpoint->'completed') x WHERE x->'ok' IS DISTINCT FROM 'true'::jsonb)
 THEN RETURN false; END IF;
 IF grants-ARRAY['vertex','quota']<>'{}'::jsonb THEN RETURN false; END IF;
 FOREACH kind IN ARRAY ARRAY['vertex','quota'] LOOP
  IF jsonb_array_length(steps)<(CASE kind WHEN 'vertex' THEN 4 ELSE 5 END) THEN
   IF grants ? kind THEN RETURN false; END IF;
  ELSE
   IF public.valid_erasure_managed_model_grant_receipt(r,kind,'deletion',grants->kind->'deletion') IS NOT TRUE
   THEN RETURN false; END IF;
  END IF;
 END LOOP;
 RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.reserve_personal_agent_erasure(owner_id text, attempt_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  current_row public.personal_agent_registry%ROWTYPE;
  reservation jsonb;
BEGIN
  IF owner_id IS NULL OR btrim(owner_id) = '' OR attempt_id IS NULL OR btrim(attempt_id) = '' THEN
    RAISE EXCEPTION 'invalid personal agent erasure admission' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(owner_id, 171));
  PERFORM pg_advisory_xact_lock(hashtextextended(owner_id, 198));
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_registry'::regclass
      AND tgname='zz_personal_agent_erasure_registry' AND tgenabled IN ('O','A')
      AND tgtype=27 AND tgnargs=0 AND tgqual IS NULL
      AND tgfoid='public.guard_personal_agent_erasure_registry()'::regprocedure
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid='public.consent_audit'::regclass
      AND tgname='zy_personal_agent_erasure_grant' AND tgenabled IN ('O','A')
      AND tgtype=7 AND tgnargs=0 AND tgqual IS NULL
      AND tgfoid='public.guard_personal_agent_erasure_grant()'::regprocedure
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid='public.consent_audit'::regclass
      AND tgname='trg_reject_deleted_account_insert' AND tgenabled IN ('O','A')
      AND tgfoid='public.reject_deleted_account_identity_write()'::regprocedure
  ) THEN
    RAISE EXCEPTION 'personal agent erasure guards unavailable' USING ERRCODE='42501';
  END IF;
  SELECT * INTO current_row FROM public.personal_agent_registry WHERE user_id = owner_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'personal agent erasure registry unavailable' USING ERRCODE = '42501';
  END IF;
  IF current_row.backend_metadata IS NOT NULL AND jsonb_typeof(current_row.backend_metadata) <> 'object' THEN
    RAISE EXCEPTION 'personal agent erasure metadata invalid' USING ERRCODE = '42501';
  END IF;
  IF current_row.backend_metadata ? 'erasure' THEN
    RETURN current_row.backend_metadata->'erasure';
  END IF;
  -- Do not freeze an unknown provider outcome into incomplete cleanup inventory.
  -- Account-erasure's tombstone independently prevents new provision intents.
  IF current_row.deployment_target='gcp' AND (
    current_row.backend_metadata->'provisionAttempt'->'evidence'->'reserved'->'hostedCheckpoint'->>'phase'='intent'
    OR current_row.backend_metadata->'provisionAttempt'->'evidence'->'reserved'->'hostedPreparation'->>'phase'='intent') THEN
    RAISE EXCEPTION 'managed provision observation requires reconciliation' USING ERRCODE='42501';
  END IF;
  reservation := jsonb_build_object(
    'version', 1, 'ownerId', owner_id, 'attemptId', attempt_id,
    'hushhId', current_row.hushh_id, 'phase', 'reserved',
    'registrySnapshot', to_jsonb(current_row)
  );
  UPDATE public.personal_agent_registry SET
    backend_metadata = coalesce(backend_metadata, '{}'::jsonb) || jsonb_build_object('erasure', reservation),
    status = 'suspended', updated_at = clock_timestamp()
  WHERE user_id = owner_id;
  RETURN reservation;
END;
$function$;

CREATE OR REPLACE FUNCTION public.guard_personal_agent_erasure_registry()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE reservation jsonb; snapshot jsonb; cancel_allowed boolean;
BEGIN
  -- Preserve421's reviewed cloud-removal cancellation and restore barriers.
  IF TG_OP='UPDATE' AND to_regprocedure('public.cloud_removal_cancel_restore_allowed(jsonb,jsonb)') IS NOT NULL THEN
    EXECUTE 'SELECT public.cloud_removal_cancel_restore_allowed($1,$2)' INTO cancel_allowed USING to_jsonb(OLD),to_jsonb(NEW);
    IF cancel_allowed IS TRUE THEN RETURN NEW; END IF;
  END IF;
  IF TG_OP='DELETE' AND public.personal_agent_erasure_archived(OLD.user_id,OLD.backend_metadata->'erasure') IS TRUE THEN RETURN OLD; END IF;
  IF OLD.backend_metadata ? 'erasure' THEN
    reservation := OLD.backend_metadata->'erasure';
    snapshot := reservation->'registrySnapshot';

    -- 962: one validated append to the existing owner resource-cleanup receipt.
    IF TG_OP='UPDATE' AND to_jsonb(NEW)-'backend_metadata'=to_jsonb(OLD)-'backend_metadata'
       AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
       AND public.valid_azure_erasure_append(OLD.user_id,OLD.backend_metadata->'erasure',
           NEW.backend_metadata->'erasure') IS TRUE THEN RETURN NEW; END IF;

    -- 956: one qualified receipt for the exact notification mutation frozen by erasure.
    IF TG_OP='UPDATE' AND to_jsonb(NEW)-'backend_metadata'=to_jsonb(OLD)-'backend_metadata'
       AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
       AND (NEW.backend_metadata->'erasure')-'lateNotificationObservation'=OLD.backend_metadata->'erasure'
       AND NOT (OLD.backend_metadata->'erasure' ? 'lateNotificationObservation')
       AND NOT (OLD.backend_metadata->'erasure' ? 'substrateInventory')
       AND public.valid_erasure_notification_observation(OLD.backend_metadata->'erasure',
           NEW.backend_metadata->'erasure'->'lateNotificationObservation') IS TRUE THEN RETURN NEW; END IF;

    IF TG_OP='UPDATE'
       AND to_jsonb(NEW)-'backend_metadata'=to_jsonb(OLD)-'backend_metadata'
       AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
       AND (NEW.backend_metadata->'erasure')-'lateFilesUpgradeObservation'=OLD.backend_metadata->'erasure'
       AND NOT (OLD.backend_metadata->'erasure' ? 'lateFilesUpgradeObservation')
       AND NOT (OLD.backend_metadata->'erasure' ? 'substrateInventory')
       AND public.valid_erasure_files_upgrade_observation(OLD.backend_metadata->'erasure',
           NEW.backend_metadata->'erasure'->'lateFilesUpgradeObservation') IS TRUE THEN RETURN NEW;
    END IF;

    IF TG_OP='UPDATE' AND public.hosted_preparation_cleanup_admitted(OLD.user_id,reservation->>'attemptId',reservation) IS TRUE
       AND to_jsonb(NEW)-'backend_metadata'=to_jsonb(OLD)-'backend_metadata'
       AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
       AND public.valid_managed_preparation_cleanup_append(reservation,NEW.backend_metadata->'erasure') IS TRUE
       THEN RETURN NEW; END IF;

    -- Managed cleanup uses its retained policy slot, without a new-work expiry test.
    IF snapshot->>'deployment_target'='gcp' AND
       public.hosted_pod_cleanup_admitted(OLD.user_id,reservation->>'attemptId',reservation) IS NOT TRUE
       AND public.hosted_preparation_cleanup_admitted(OLD.user_id,reservation->>'attemptId',reservation) IS NOT TRUE THEN
      RAISE EXCEPTION 'managed erasure authority requires reconciliation' USING ERRCODE='42501';
    END IF;
    IF TG_OP='UPDATE' AND snapshot->>'deployment_target'='gcp'
       AND to_jsonb(NEW)-'backend_metadata'=to_jsonb(OLD)-'backend_metadata'
       AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
       AND public.valid_erasure_managed_model_grant_append(reservation,NEW.backend_metadata->'erasure') IS TRUE
       THEN RETURN NEW; END IF;

    IF TG_OP='UPDATE' AND snapshot->>'deployment_target'='gcp'
       AND to_jsonb(NEW)-'backend_metadata'=to_jsonb(OLD)-'backend_metadata'
       AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
       AND public.valid_erasure_managed_retirement_append(reservation,NEW.backend_metadata->'erasure') IS TRUE
       THEN RETURN NEW; END IF;

    -- The transaction-local marker coordinates the restore, but is caller-settable.
    -- Independently enforce the identity, tombstone and setup barriers here.
    IF TG_OP = 'UPDATE'
       AND NOT EXISTS(SELECT 1 FROM public.personal_agent_cloud_removals c
        WHERE c.user_id=OLD.user_id AND c.attempt_id=reservation->>'attemptId')
       AND current_setting('hussh.erasure_restore_attempt', true) = reservation->>'attemptId'
       AND reservation - ARRAY['version','ownerId','attemptId','hushhId','phase','registrySnapshot'] = '{}'::jsonb
       AND reservation->>'ownerId' = OLD.user_id
       AND OLD.status = 'suspended'
       AND snapshot->>'user_id' = OLD.user_id
       AND snapshot->>'hushh_id' = OLD.hushh_id
       AND reservation->>'phase' = 'reserved'
       AND snapshot->>'status' = 'provisioned'
       AND jsonb_typeof(snapshot->'backend_metadata') = 'object'
       AND NOT (snapshot->'backend_metadata' ? 'erasure')
       AND to_jsonb(NEW) - 'updated_at' = snapshot - 'updated_at'
    THEN
      IF current_setting('transaction_isolation') NOT IN ('read committed','read uncommitted') THEN
        RAISE EXCEPTION 'erasure restore requires a current snapshot' USING ERRCODE='42501';
      END IF;
      -- Match account erasure's owner-lock order. A direct writer holding the row
      -- must refuse a lock conflict rather than invert that order and deadlock.
      IF NOT pg_try_advisory_xact_lock(hashtextextended(OLD.user_id,171))
         OR NOT pg_try_advisory_xact_lock(hashtextextended(OLD.user_id,198)) THEN
        RAISE EXCEPTION 'erasure restore owner busy' USING ERRCODE='42501';
      END IF;
      IF EXISTS (SELECT 1 FROM public.personal_agent_deletion_tombstones WHERE hushh_id=OLD.hushh_id)
         OR EXISTS (SELECT 1 FROM public.account_deletion_tombstones
            WHERE user_id_hash='sha256:'||encode(sha256(convert_to(OLD.user_id,'UTF8')),'hex'))
         OR NOT EXISTS (SELECT 1 FROM public.byoc_setup_jobs
            WHERE user_id=OLD.user_id AND status='recorded' AND authorization_attempts='{}'::jsonb) THEN
        RAISE EXCEPTION 'erasure restore authority unavailable' USING ERRCODE='42501';
      END IF;
      RETURN NEW;
    END IF;

    IF TG_OP='UPDATE' AND to_jsonb(NEW)-'backend_metadata'=to_jsonb(OLD)-'backend_metadata'
       AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
       AND public.valid_erasure_files_append(OLD.backend_metadata->'erasure',NEW.backend_metadata->'erasure') IS TRUE THEN RETURN NEW; END IF;
    -- Only a bound late acknowledgement may be appended. It is not a terminal
    -- cleanup result and cannot alter identity, custody, status or the reservation.
    IF TG_OP = 'UPDATE'
       AND to_jsonb(NEW) - 'backend_metadata' = to_jsonb(OLD) - 'backend_metadata'
       AND NEW.backend_metadata - 'erasure' = OLD.backend_metadata - 'erasure'
       AND (NEW.backend_metadata->'erasure') - 'lateUpgradeAcknowledgement' =
           (OLD.backend_metadata->'erasure') - 'lateUpgradeAcknowledgement'
       AND NOT ((OLD.backend_metadata->'erasure') ? 'lateUpgradeAcknowledgement')
       AND public.valid_erasure_upgrade_ack(
           OLD.backend_metadata->'erasure', NEW.backend_metadata->'erasure'->'lateUpgradeAcknowledgement') THEN
      RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE'
       AND to_jsonb(NEW) - 'backend_metadata' = to_jsonb(OLD) - 'backend_metadata'
       AND NEW.backend_metadata - 'erasure' = OLD.backend_metadata - 'erasure'
       AND (NEW.backend_metadata->'erasure') - 'lateProvisionAcknowledgement' =
           (OLD.backend_metadata->'erasure') - 'lateProvisionAcknowledgement'
       AND NOT ((OLD.backend_metadata->'erasure') ? 'lateProvisionAcknowledgement')
       AND public.valid_erasure_provision_ack(OLD.backend_metadata->'erasure',
           NEW.backend_metadata->'erasure'->'lateProvisionAcknowledgement') THEN
      RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE'
       AND to_jsonb(NEW) - 'backend_metadata' = to_jsonb(OLD) - 'backend_metadata'
       AND NEW.backend_metadata - 'erasure' = OLD.backend_metadata - 'erasure'
       AND (NEW.backend_metadata->'erasure') - 'memoryBinding' =
           (OLD.backend_metadata->'erasure') - 'memoryBinding'
       AND NOT ((OLD.backend_metadata->'erasure') ? 'memoryBinding')
       AND public.valid_erasure_memory_binding(OLD.backend_metadata->'erasure',
           NEW.backend_metadata->'erasure'->'memoryBinding') THEN
      RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE'
       AND to_jsonb(NEW) - 'backend_metadata' = to_jsonb(OLD) - 'backend_metadata'
       AND NEW.backend_metadata - 'erasure' = OLD.backend_metadata - 'erasure'
       AND (NEW.backend_metadata->'erasure') - 'memoryDeletion' = (OLD.backend_metadata->'erasure') - 'memoryDeletion'
       AND NOT ((OLD.backend_metadata->'erasure') ? 'memoryDeletion')
       AND public.valid_erasure_memory_deletion(OLD.backend_metadata->'erasure',
           NEW.backend_metadata->'erasure'->'memoryDeletion') THEN RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE'
       AND to_jsonb(NEW) - 'backend_metadata' = to_jsonb(OLD) - 'backend_metadata'
       AND NEW.backend_metadata - 'erasure' = OLD.backend_metadata - 'erasure'
       AND public.valid_erasure_compute_append(OLD.backend_metadata->'erasure',NEW.backend_metadata->'erasure') THEN
      RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE'
       AND to_jsonb(NEW) - 'backend_metadata' = to_jsonb(OLD) - 'backend_metadata'
       AND NEW.backend_metadata - 'erasure' = OLD.backend_metadata - 'erasure'
       AND NOT (OLD.backend_metadata->'erasure' ? 'substrateInventory')
       AND (NEW.backend_metadata->'erasure') - 'substrateInventory' = OLD.backend_metadata->'erasure'
       AND public.valid_erasure_substrate_inventory(OLD.backend_metadata->'erasure',
           NEW.backend_metadata->'erasure'->'substrateInventory') THEN RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE'
       AND to_jsonb(NEW) - 'backend_metadata' = to_jsonb(OLD) - 'backend_metadata'
       AND NEW.backend_metadata - 'erasure' = OLD.backend_metadata - 'erasure'
       AND public.valid_erasure_writer_append(OLD.backend_metadata->'erasure',NEW.backend_metadata->'erasure') THEN
      RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE'
       AND to_jsonb(NEW) - 'backend_metadata' = to_jsonb(OLD) - 'backend_metadata'
       AND NEW.backend_metadata - 'erasure' = OLD.backend_metadata - 'erasure'
       AND public.valid_erasure_bucket_append(OLD.backend_metadata->'erasure',NEW.backend_metadata->'erasure') THEN
      RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE'
       AND to_jsonb(NEW) - 'backend_metadata' = to_jsonb(OLD) - 'backend_metadata'
       AND NEW.backend_metadata - 'erasure' = OLD.backend_metadata - 'erasure'
       AND public.valid_erasure_mail_append(OLD.backend_metadata->'erasure',NEW.backend_metadata->'erasure') THEN RETURN NEW; END IF;
    IF TG_OP = 'UPDATE'
       AND to_jsonb(NEW) - 'backend_metadata' = to_jsonb(OLD) - 'backend_metadata'
       AND NEW.backend_metadata - 'erasure' = OLD.backend_metadata - 'erasure'
       AND public.valid_erasure_kms_append(OLD.backend_metadata->'erasure',NEW.backend_metadata->'erasure') THEN RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE'
       AND to_jsonb(NEW) - 'backend_metadata' = to_jsonb(OLD) - 'backend_metadata'
       AND NEW.backend_metadata - 'erasure' = OLD.backend_metadata - 'erasure'
       AND public.valid_erasure_secret_append(OLD.backend_metadata->'erasure',NEW.backend_metadata->'erasure') THEN RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE'
       AND to_jsonb(NEW) - 'backend_metadata' = to_jsonb(OLD) - 'backend_metadata'
       AND NEW.backend_metadata - 'erasure' = OLD.backend_metadata - 'erasure'
       AND public.valid_erasure_account_append(OLD.backend_metadata->'erasure',NEW.backend_metadata->'erasure') THEN RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE'
       AND to_jsonb(NEW) - 'backend_metadata' = to_jsonb(OLD) - 'backend_metadata'
       AND NEW.backend_metadata - 'erasure' = OLD.backend_metadata - 'erasure'
       AND NOT (OLD.backend_metadata->'erasure' ? 'grantRelease')
       AND (NEW.backend_metadata->'erasure') - 'grantRelease'=OLD.backend_metadata->'erasure'
       AND public.valid_erasure_grant_release(OLD.backend_metadata->'erasure',NEW.backend_metadata->'erasure'->'grantRelease') IS TRUE
       AND public.project_grant_release_is_exclusive(OLD.user_id,NEW.backend_metadata->'erasure'->'grantRelease'->>'project') IS TRUE THEN RETURN NEW;
    END IF;
    IF TG_OP='UPDATE' AND to_jsonb(NEW)-'backend_metadata'=to_jsonb(OLD)-'backend_metadata'
       AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
       AND public.valid_erasure_runtime_grant_append(OLD.backend_metadata->'erasure',NEW.backend_metadata->'erasure') IS TRUE
       AND public.project_grant_release_is_exclusive(OLD.user_id,OLD.backend_metadata->'erasure'->'grantRelease'->>'project') IS TRUE THEN RETURN NEW; END IF;
    IF TG_OP = 'UPDATE'
       AND to_jsonb(NEW) - 'backend_metadata' = to_jsonb(OLD) - 'backend_metadata'
       AND NEW.backend_metadata - 'erasure' = OLD.backend_metadata - 'erasure'
       AND public.valid_erasure_repository_grant_append(OLD.backend_metadata->'erasure',NEW.backend_metadata->'erasure') IS TRUE
       AND public.project_grant_release_is_exclusive(OLD.user_id,OLD.backend_metadata->'erasure'->'grantRelease'->>'project') IS TRUE THEN RETURN NEW; END IF;
    IF TG_OP='UPDATE' AND to_jsonb(NEW)-'backend_metadata'=to_jsonb(OLD)-'backend_metadata'
       AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
       AND NOT (OLD.backend_metadata->'erasure' ? 'repositoryInventory')
       AND (NEW.backend_metadata->'erasure')-'repositoryInventory'=OLD.backend_metadata->'erasure'
       AND public.valid_erasure_repository_inventory(OLD.backend_metadata->'erasure',NEW.backend_metadata->'erasure'->'repositoryInventory') IS TRUE
       AND public.project_grant_release_is_exclusive(OLD.user_id,OLD.backend_metadata->'erasure'->'grantRelease'->>'project') IS TRUE THEN RETURN NEW; END IF;
    IF TG_OP='UPDATE' AND to_jsonb(NEW)-'backend_metadata'=to_jsonb(OLD)-'backend_metadata'
       AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
       AND NOT (OLD.backend_metadata->'erasure' ? 'repositoryRetention')
       AND (NEW.backend_metadata->'erasure')-'repositoryRetention'=OLD.backend_metadata->'erasure'
       AND public.valid_erasure_repository_retention(OLD.backend_metadata->'erasure',NEW.backend_metadata->'erasure'->'repositoryRetention') IS TRUE
       AND public.project_grant_release_is_exclusive(OLD.user_id,OLD.backend_metadata->'erasure'->'grantRelease'->>'project') IS TRUE THEN RETURN NEW; END IF;
    IF TG_OP='UPDATE' AND to_jsonb(NEW)-'backend_metadata'=to_jsonb(OLD)-'backend_metadata'
       AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
       AND NOT (OLD.backend_metadata->'erasure' ? 'bootstrapGrantRelease')
       AND (NEW.backend_metadata->'erasure')-'bootstrapGrantRelease'=OLD.backend_metadata->'erasure'
       AND NEW.backend_metadata->'erasure'->'bootstrapGrantRelease'=public.expected_erasure_bootstrap_release(OLD.user_id,OLD.backend_metadata->'erasure',NEW.backend_metadata->'erasure'->'bootstrapGrantRelease'->>'recoveryMember')
       AND public.project_grant_release_is_exclusive(OLD.user_id,OLD.backend_metadata->'erasure'->'grantRelease'->>'project') IS TRUE THEN RETURN NEW; END IF;
    IF TG_OP='UPDATE' AND to_jsonb(NEW)-'backend_metadata'=to_jsonb(OLD)-'backend_metadata'
       AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
       AND public.valid_erasure_bootstrap_append(OLD.backend_metadata->'erasure',NEW.backend_metadata->'erasure') IS TRUE
       AND public.project_grant_release_is_exclusive(OLD.user_id,OLD.backend_metadata->'erasure'->'grantRelease'->>'project') IS TRUE THEN RETURN NEW; END IF;
    -- Owner-access erasure (949): the pod's confirmation, once, before any revocation.
    IF TG_OP='UPDATE' AND to_jsonb(NEW)-'backend_metadata'=to_jsonb(OLD)-'backend_metadata'
       AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
       AND NOT (OLD.backend_metadata->'erasure' ? 'agentCryptoErase')
       AND NOT (OLD.backend_metadata->'erasure' ? 'ownerAccessErasure')
       AND (NEW.backend_metadata->'erasure')-'agentCryptoErase'=OLD.backend_metadata->'erasure'
       AND public.valid_erasure_owner_access_checkpoint(OLD.backend_metadata->'erasure',
           NEW.backend_metadata->'erasure'->'agentCryptoErase') IS TRUE THEN RETURN NEW; END IF;
    -- Owner-access erasure (949): one receipt, once, validated against the snapshot.
    IF TG_OP='UPDATE' AND to_jsonb(NEW)-'backend_metadata'=to_jsonb(OLD)-'backend_metadata'
       AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
       AND NOT (OLD.backend_metadata->'erasure' ? 'ownerAccessErasure')
       AND (NEW.backend_metadata->'erasure')-'ownerAccessErasure'=OLD.backend_metadata->'erasure'
       AND public.valid_erasure_owner_access(OLD.backend_metadata->'erasure',
           NEW.backend_metadata->'erasure'->'ownerAccessErasure') IS TRUE THEN RETURN NEW; END IF;
    -- Never-hosted erasure (954): the derived receipt and the project fence, once.
    IF TG_OP='UPDATE' AND to_jsonb(NEW)-'backend_metadata'=to_jsonb(OLD)-'backend_metadata'
       AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
       AND public.valid_erasure_never_hosted_append(OLD.user_id,OLD.backend_metadata->'erasure',
           NEW.backend_metadata->'erasure') IS TRUE
       AND public.project_grant_release_is_exclusive(OLD.user_id,
           NEW.backend_metadata->'erasure'->'grantRelease'->>'project') IS TRUE THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'personal agent erasure reserved' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;


-- Project retirement follows independent resource/credential erasure. Google's
-- recoverable DELETE_REQUESTED state is never called physical project deletion.
CREATE OR REPLACE FUNCTION public.valid_erasure_managed_project_retirement(r jsonb, stage text, receipt jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $$
DECLARE coordinates jsonb:=public.erasure_private_coordinates(r);
 attempt jsonb:=r->'registrySnapshot'->'backend_metadata'->'provisionAttempt';
 contract jsonb:=attempt->'hostedAdmission'->'assignment'->'preparationContract';
 creation jsonb:=attempt->'evidence'->'reserved'->'hostedPreparation'->'completed'->0->'resourceObservation'->'identity';
 wanted jsonb;
BEGIN
 IF coordinates IS NULL OR r->'registrySnapshot'->>'deployment_target' IS DISTINCT FROM 'gcp'
 OR jsonb_typeof(receipt) IS DISTINCT FROM 'object'
 OR stage NOT IN ('admission','acknowledgement','deletion') OR stage IS NULL
 OR public.erasure_planned_resources_covered(r) IS NOT TRUE
 OR public.erasure_managed_model_grants_complete(r) IS NOT TRUE
 OR jsonb_typeof(r->'bootstrapGrantRelease'->'groups') IS DISTINCT FROM 'object'
 OR NOT EXISTS(SELECT 1 FROM jsonb_each(r->'bootstrapGrantRelease'->'groups'))
 OR EXISTS(SELECT 1 FROM jsonb_each(r->'bootstrapGrantRelease'->'groups') g
    WHERE r->'bootstrapGrantErasure'->g.key->'deletion'->>'status' IS DISTINCT FROM 'observed_absent')
 OR creation->>'projectId' IS DISTINCT FROM coordinates->>'project'
 OR creation->>'projectNumber' IS DISTINCT FROM coordinates->>'projectNumber'
 OR public.valid_hosted_preparation_result(attempt,attempt->'evidence'->'reserved'->'hostedPreparation'->'completed'->0) IS NOT TRUE
 THEN RETURN false; END IF;
 wanted:=jsonb_build_object('ownerId',r->>'ownerId','attemptId',r->>'attemptId',
   'project',coordinates->>'project','projectNumber',coordinates->>'projectNumber',
   'operatorPrincipal',contract->>'operatorPrincipal');
 IF stage='admission' THEN RETURN receipt=wanted||jsonb_build_object('status','admitted'); END IF;
 IF stage='acknowledgement' THEN RETURN receipt=wanted||jsonb_build_object('status','acknowledged'); END IF;
 RETURN receipt=wanted||jsonb_build_object('status','retirement_pending_provider_purge',
   'projectIdentity',jsonb_set(creation,'{lifecycleState}','"DELETE_REQUESTED"'::jsonb),
   'billingObservation',jsonb_build_object('projectId',coordinates->>'project',
      'billingAccountName','','billingEnabled',false));
END;
$$;

CREATE OR REPLACE FUNCTION public.valid_erasure_managed_retirement_append(old_r jsonb,new_r jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $$
DECLARE prior jsonb:=coalesce(old_r->'managedProjectRetirement','{}'::jsonb);
 next jsonb:=new_r->'managedProjectRetirement'; stage text; changed integer:=0;
BEGIN
 IF new_r-'managedProjectRetirement' IS DISTINCT FROM old_r-'managedProjectRetirement'
 OR jsonb_typeof(next) IS DISTINCT FROM 'object' OR jsonb_typeof(prior) IS DISTINCT FROM 'object'
 OR prior ? 'deletion'
 OR next-ARRAY['admission','acknowledgement','deletion']<>'{}'::jsonb THEN RETURN false; END IF;
 FOREACH stage IN ARRAY ARRAY['admission','acknowledgement','deletion'] LOOP
  IF prior ? stage THEN IF next->stage IS DISTINCT FROM prior->stage THEN RETURN false; END IF;
  ELSIF next ? stage THEN
   changed:=changed+1;
   IF public.valid_erasure_managed_project_retirement(old_r,stage,next->stage) IS NOT TRUE
    OR (stage<>'admission' AND NOT prior ? 'admission')
    THEN RETURN false; END IF;
  END IF;
 END LOOP;
 RETURN changed=1;
END;
$$;

CREATE OR REPLACE FUNCTION public.retain_erasure_managed_project_retirement(
 p_owner text,p_attempt text,expected jsonb,p_stage text,receipt jsonb
) RETURNS boolean LANGUAGE plpgsql SET search_path=public AS $$
DECLARE row_state public.personal_agent_registry%ROWTYPE; r jsonb; updated jsonb;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' OR p_stage NOT IN ('admission','acknowledgement','deletion') THEN RETURN false; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_owner,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(p_owner,198));
 SELECT * INTO row_state FROM public.personal_agent_registry WHERE user_id=p_owner FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 r:=row_state.backend_metadata->'erasure';
 IF public.hosted_pod_cleanup_admitted(p_owner,p_attempt,r) IS NOT TRUE THEN RETURN false; END IF;
 IF r->'managedProjectRetirement' ? p_stage THEN RETURN r->'managedProjectRetirement'->p_stage=receipt; END IF;
 IF r IS DISTINCT FROM expected THEN RETURN false; END IF;
 updated:=jsonb_set(r,'{managedProjectRetirement}',coalesce(r->'managedProjectRetirement','{}'::jsonb)||jsonb_build_object(p_stage,receipt));
 IF public.valid_erasure_managed_retirement_append(r,updated) IS NOT TRUE THEN RETURN false; END IF;
 UPDATE public.personal_agent_registry SET backend_metadata=jsonb_set(backend_metadata,'{erasure}',updated) WHERE user_id=p_owner;
 RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.expected_erasure_bootstrap_release(owner_id text, r jsonb, recovery_member text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE history jsonb; job record; identity jsonb; binding jsonb; groups jsonb:='{}'::jsonb;
 g jsonb; k text; target_project text; recovery_key text; n integer:=0;
BEGIN
 -- 954: a never-hosted reservation has no planned resources and no repository; its
 -- re-derived receipt stands in for both. Every other reservation is unchanged.
 IF public.erasure_never_hosted_admitted(owner_id,r) IS DISTINCT FROM true THEN
 IF public.erasure_planned_resources_covered(r) IS DISTINCT FROM true THEN RETURN NULL; END IF;
 IF public.valid_erasure_repository_retention(r,r->'repositoryRetention') IS DISTINCT FROM true THEN RETURN NULL; END IF;
 END IF;
 target_project:=public.erasure_private_coordinates(r)->>'project';
 IF r->'registrySnapshot'->>'deployment_target'='gcp' AND public.erasure_managed_model_grants_complete(r) IS NOT TRUE THEN RETURN NULL; END IF;
 SELECT authorization_attempts INTO history FROM public.byoc_setup_jobs WHERE user_id=owner_id;
 history:=public.erasure_authorization_history(r,history);
 IF jsonb_typeof(history) IS DISTINCT FROM 'object' THEN RETURN NULL; END IF;
 FOR job IN SELECT key,value FROM jsonb_each(history) ORDER BY key LOOP
  IF job.value->'intent'->>'project' IS DISTINCT FROM target_project THEN CONTINUE; END IF;
  n:=n+1;
  IF n>1024 OR job.value->'intent'->>'ownerId' IS DISTINCT FROM owner_id
   OR job.value->'intent'->>'jobId' IS DISTINCT FROM job.key OR NOT (job.value ? 'receipt') THEN RETURN NULL; END IF;
  identity:=job.value->'receipt'->'bootstrapIdentity'; binding:=job.value->'receipt'->'bindingObservation';
  IF identity->>'projectId' IS DISTINCT FROM target_project OR binding->>'role' IS DISTINCT FROM 'roles/iam.serviceAccountTokenCreator'
   OR binding->>'member' IS DISTINCT FROM 'serviceAccount:'||(job.value->'intent'->>'callerEmail')
   OR (binding->>'disposition' IN ('added','already_present')) IS DISTINCT FROM true THEN RETURN NULL; END IF;
  k:=(identity->>'uniqueId')||'|'||(binding->>'member');
  IF k IS NULL THEN RETURN NULL; END IF;
  g:=groups->k;
  IF g IS NULL THEN g:=jsonb_build_object('jobIds','[]'::jsonb,'bootstrapIdentity',identity,'bindingObservation',NULL); END IF;
  IF g->'bootstrapIdentity' IS DISTINCT FROM identity THEN RETURN NULL; END IF;
  g:=jsonb_set(g,'{jobIds}',(g->'jobIds')||jsonb_build_array(job.key));
  IF binding->>'disposition'='added' AND g->'bindingObservation'='null'::jsonb THEN g:=jsonb_set(g,'{bindingObservation}',binding); END IF;
  groups:=jsonb_set(groups,ARRAY[k],g,true);
  IF binding->>'member'=recovery_member AND identity->>'email'=regexp_replace(public.erasure_private_coordinates(r)->>'bootstrap','^serviceAccount:','') THEN
   IF recovery_key IS NOT NULL AND recovery_key<>k THEN RETURN NULL; END IF;
   recovery_key:=k;
  END IF;
 END LOOP;
 IF n=0 OR recovery_key IS NULL THEN RETURN NULL; END IF;
 FOR g IN SELECT value FROM jsonb_each(groups) LOOP
  IF g->'bindingObservation'='null'::jsonb THEN RETURN NULL; END IF;
 END LOOP;
 RETURN jsonb_build_object('ownerId',owner_id,'attemptId',r->>'attemptId','project',target_project,
  'groups',groups,'recoveryMember',recovery_member,'recoveryGrantKey',recovery_key,'status','reserved');
END;
$function$;

CREATE OR REPLACE FUNCTION public.personal_agent_erasure_archive(r jsonb, history jsonb)
 RETURNS jsonb
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
 SELECT jsonb_build_object(
  'version',1,'ownerId',r->>'ownerId','hushhId',r->>'hushhId','attemptId',r->>'attemptId',
  'project',coalesce(public.erasure_private_coordinates(r)->>'project',public.managed_preparation_cleanup_coordinates(r)->>'project'),
  'reservationSha256',encode(sha256(convert_to(r::text,'UTF8')),'hex'),
  'authorizationHistorySha256',encode(sha256(convert_to(public.erasure_authorization_history(r,history)::text,'UTF8')),'hex'),
  'receipts',jsonb_build_object(
   'memoryDeletion',r->'memoryDeletion','computeDeletion',r->'computeDeletion',
   'writerDisabled',r->'writerDisabled','bucketDeletion',r->'bucketDeletion',
   'mailDeletion',jsonb_build_object(
    'cloud_scheduler_job',r->'mailErasure'->'cloud_scheduler_job'->'deletion',
    'pubsub_subscription',r->'mailErasure'->'pubsub_subscription'->'deletion',
    'pubsub_topic',r->'mailErasure'->'pubsub_topic'->'deletion') ||
    -- 956: preserve every independent resource's qualified stages in the archive.
    CASE WHEN EXISTS(SELECT 1 FROM jsonb_each(coalesce(r->'mailErasure','{}'::jsonb)) x WHERE x.value ? 'resources')
     THEN jsonb_build_object('resourcesByKind',r->'mailErasure') ELSE '{}'::jsonb END,
   'kmsCompletion',r->'kmsErasure'->'completion','secretDeletion',r->'secretErasure'->'deletion',
   'accountDeletion',r->'accountErasure'->'deletion',
   'runtimeGrantDeletion',r->'runtimeGrantErasure'->'deletion',
   'repositoryGrantDeletion',r->'repositoryGrantErasure'->'deletion',
   'repositoryRetention',r->'repositoryRetention',
   'bootstrapGrantRelease',r->'bootstrapGrantRelease',
   'bootstrapGrantErasure',r->'bootstrapGrantErasure') ||
   CASE WHEN r->'registrySnapshot'->>'deployment_target'='gcp' THEN jsonb_build_object(
    'hostingMode','hussh_hosted','managedModelGrantErasure',r->'managedModelGrantErasure',
    'managedProjectRetirement',r->'managedProjectRetirement','managedPreparationCleanup',r->'managedPreparationCleanup') ELSE '{}'::jsonb END ||
   CASE WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(r->'substrateInventory'->'plannedResources') x WHERE x->>'type'='cloud_tasks_queue')
    THEN jsonb_build_object('filesErasure',r->'filesErasure') ELSE '{}'::jsonb END
   -- 954: keep the person's never-hosted receipt; absent (no key) on every hosted archive.
   || jsonb_strip_nulls(jsonb_build_object('neverHosted',r->'neverHosted'))
   || CASE WHEN jsonb_typeof(r->'azureTeardown')='object'
      THEN jsonb_build_object('azureCleanup',r->'azureTeardown',
       'agentCryptoErase',r->'agentCryptoErase','ownerAccessErasure',r->'ownerAccessErasure') ELSE '{}'::jsonb END
   || CASE WHEN jsonb_array_length(coalesce(r->'substrateInventory'->'operatorBindingObservations','[]'::jsonb))>0
    THEN jsonb_build_object('operatorNotificationCustody',jsonb_build_object(
     'bindings',r->'substrateInventory'->'operatorBindingObservations',
     'topics',(SELECT coalesce(jsonb_agg(x),'[]'::jsonb)
      FROM jsonb_array_elements(r->'substrateInventory'->'resourceObservations') x
      WHERE x->>'type'='pubsub_topic' AND starts_with(x->>'id','projects/'))))
    ELSE '{}'::jsonb END
   || CASE WHEN r->'runtimeGrantErasure' ? 'quota'
    THEN jsonb_build_object('runtimeQuotaGrantDeletion',r->'runtimeGrantErasure'->'quota'->'deletion') ELSE '{}'::jsonb END);
$function$;

CREATE OR REPLACE FUNCTION public.personal_agent_erasure_archived(owner_id text, r jsonb, history jsonb DEFAULT NULL::jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
BEGIN
 RETURN (SELECT jsonb_typeof(r)='object' AND r->>'ownerId'=owner_id AND coalesce(r->>'attemptId','')<>''
 AND (
  (EXISTS(SELECT 1 FROM public.personal_agent_deletion_tombstones t WHERE t.status='erasure_completed'
    AND t.metadata->>'ownerId'=owner_id AND t.hushh_id=r->>'hushhId' AND t.metadata->>'attemptId'=r->>'attemptId'
    AND t.metadata->>'reservationSha256'=encode(sha256(convert_to(r::text,'UTF8')),'hex')
    AND ((history IS NULL AND r->'registrySnapshot'->>'deployment_target' IS DISTINCT FROM 'gcp') OR t.metadata->>'authorizationHistorySha256'=encode(sha256(convert_to(public.erasure_authorization_history(r,history)::text,'UTF8')),'hex')))
   AND EXISTS(SELECT 1 FROM public.account_deletion_tombstones WHERE cleanup_intent_kind='full_account'
    AND user_id_hash='sha256:'||encode(sha256(convert_to(owner_id,'UTF8')),'hex')))
  OR (public.personal_agent_cloud_removal_ready() IS TRUE AND EXISTS(
   SELECT 1 FROM public.personal_agent_cloud_removals c WHERE c.user_id=owner_id AND c.attempt_id=r->>'attemptId'
    AND c.completed_at IS NOT NULL AND c.archive->>'hushhId'=r->>'hushhId'
    AND c.snapshot_sha256=encode(sha256(convert_to((r->'registrySnapshot')::text,'UTF8')),'hex')
    AND c.placement_epoch=(r->'registrySnapshot'->>'placement_epoch')::bigint
    AND c.archive->>'reservationSha256'=encode(sha256(convert_to(r::text,'UTF8')),'hex')
    AND ((history IS NULL AND r->'registrySnapshot'->>'deployment_target' IS DISTINCT FROM 'gcp') OR c.archive->>'authorizationHistorySha256'=encode(sha256(convert_to(public.erasure_authorization_history(r,history)::text,'UTF8')),'hex')))))
 AND EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_deletion_tombstones'::regclass
  AND tgname='zz_personal_agent_erasure_archive' AND tgtype=31 AND tgenabled IN ('O','A')
  AND tgfoid='public.guard_personal_agent_erasure_archive()'::regprocedure AND tgnargs=0 AND tgqual IS NULL));
END;
$function$;

CREATE OR REPLACE FUNCTION public.personal_agent_erasure_complete(owner_id text)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE row_state public.personal_agent_registry%ROWTYPE; setup public.byoc_setup_jobs%ROWTYPE;
 r jsonb; release jsonb; expected_release jsonb; item record; stages jsonb; wanted jsonb;
 archive jsonb; table_name text; never_hosted boolean; azure_hosted boolean; group_scope text; managed boolean; preparing boolean; history jsonb;
BEGIN
 IF owner_id IS NULL OR btrim(owner_id)='' OR current_setting('transaction_isolation')<>'read committed' THEN RETURN false; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 SELECT * INTO row_state FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 IF NOT FOUND OR row_state.status IS DISTINCT FROM 'suspended' THEN RETURN false; END IF;
 -- Own setup writers acquire their tuple before project205. Prelock it here,
 -- before project exclusivity, because finalization will delete it later.
 r:=row_state.backend_metadata->'erasure'; release:=r->'bootstrapGrantRelease';
 managed:=coalesce(r->'registrySnapshot'->>'deployment_target'='gcp',false);
 preparing:=public.managed_preparation_cleanup_coordinates(r) IS NOT NULL;
 SELECT * INTO setup FROM public.byoc_setup_jobs WHERE user_id=owner_id FOR UPDATE;
 IF NOT managed AND NOT FOUND THEN RETURN false; END IF;
 history:=public.erasure_authorization_history(r,setup.authorization_attempts);
 IF managed AND NOT preparing AND (public.hosted_pod_cleanup_admitted(owner_id,r->>'attemptId',r) IS NOT TRUE
  OR public.erasure_managed_model_grants_complete(r) IS NOT TRUE
  OR public.valid_erasure_managed_project_retirement(r,'deletion',r->'managedProjectRetirement'->'deletion') IS NOT TRUE) THEN RETURN false; END IF;
 IF preparing AND (public.hosted_preparation_cleanup_admitted(owner_id,r->>'attemptId',r) IS NOT TRUE
  OR public.valid_managed_preparation_cleanup(r,'deletion',r->'managedPreparationCleanup'->'deletion') IS NOT TRUE
  OR public.valid_erasure_account_receipt(r,'deletion',r->'accountErasure'->'deletion') IS NOT TRUE) THEN RETURN false; END IF;
 azure_hosted:=coalesce(r->'registrySnapshot'->>'deployment_target'='user_azure',false)
  OR public.azure_setup_never_deployed(owner_id,r->'registrySnapshot') IS TRUE;
 IF (NOT managed AND NOT azure_hosted AND setup.status IS DISTINCT FROM 'recorded')
 OR (azure_hosted AND setup.status NOT IN ('recorded','failed')) THEN RETURN false; END IF;
 -- 954: a never-hosted reservation completes only on its SQL-re-derived evidence.
 never_hosted:=coalesce(r ? 'neverHosted',false);
 IF never_hosted AND public.erasure_never_hosted_admitted(owner_id,r) IS DISTINCT FROM true THEN RETURN false; END IF;
 IF r->>'ownerId' IS DISTINCT FROM owner_id OR r->'registrySnapshot'->>'user_id' IS DISTINCT FROM owner_id
 OR r->>'hushhId' IS DISTINCT FROM row_state.hushh_id OR row_state.hushh_id IS NULL OR row_state.hushh_id=''
 OR r->>'attemptId' IS NULL OR r->>'attemptId'=''
 OR (NOT azure_hosted AND NOT preparing AND jsonb_typeof(release) IS DISTINCT FROM 'object')
 OR r ?| ARRAY['lateUpgradeAcknowledgement','lateProvisionAcknowledgement']
 OR nullif(r->'registrySnapshot'->'backend_metadata'->>'upgradeLease','') IS NOT NULL
 OR (NOT managed AND NOT azure_hosted AND NOT never_hosted AND r->'registrySnapshot'->'backend_metadata'->'provisionAttempt'->>'phase' IS DISTINCT FROM 'provisioned')
 OR (NOT managed AND NOT azure_hosted AND setup.project_id IS DISTINCT FROM r->'registrySnapshot'->>'user_cloud_project') THEN RETURN false; END IF;
 IF azure_hosted THEN
  -- Nonblocking: actual workers hold206 until their real thread and exit persistence finish.
  IF (public.byoc_azure_worker_session_held(owner_id) IS TRUE
    AND r->'azureTeardown'->'worker'->'backendPid'=to_jsonb(pg_backend_pid()))
   OR NOT pg_try_advisory_xact_lock(hashtextextended(owner_id,206))
   OR public.azure_erasure_resources_complete(owner_id,r) IS NOT TRUE THEN RETURN false; END IF;
  group_scope:=setup.project_id;
  PERFORM pg_advisory_xact_lock(hashtextextended(group_scope,205));
  IF EXISTS(SELECT 1 FROM public.byoc_setup_jobs WHERE user_id<>owner_id AND project_id=group_scope)
   OR EXISTS(SELECT 1 FROM public.personal_agent_registry WHERE user_id<>owner_id
    AND '/subscriptions/'||user_cloud_subscription_id||'/resourceGroups/'||user_cloud_resource_group=group_scope)
  THEN RETURN false; END IF;
 ELSE
  IF public.project_grant_release_is_exclusive(owner_id,coalesce(public.managed_preparation_cleanup_coordinates(r)->>'project',r->'grantRelease'->>'project')) IS DISTINCT FROM true THEN RETURN false; END IF;
 END IF;
 -- The canonical identity barrier must cover late registry/setup/log/migration insertion.
 FOREACH table_name IN ARRAY ARRAY['personal_agent_registry','byoc_setup_jobs','pod_lifecycle_events','pod_migration_jobs'] LOOP
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=('public.'||table_name)::regclass
   AND tgname='trg_reject_deleted_account_insert' AND tgtype=7 AND tgenabled IN ('O','A')
   AND tgfoid='public.reject_deleted_account_identity_write()'::regprocedure
   AND tgnargs=1 AND tgargs=decode('757365725f696400','hex') AND tgqual IS NULL) THEN RETURN false; END IF;
 END LOOP;
 IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_deletion_tombstones'::regclass
  AND tgname='zz_personal_agent_erasure_archive' AND tgtype=31 AND tgenabled IN ('O','A')
  AND tgfoid='public.guard_personal_agent_erasure_archive()'::regprocedure AND tgqual IS NULL AND tgnargs=0) THEN RETURN false; END IF;
 IF EXISTS (SELECT 1 FROM public.pod_migration_jobs WHERE user_id=owner_id)
 OR EXISTS (SELECT 1 FROM public.pod_lifecycle_events WHERE user_id=owner_id AND hushh_id IS NOT NULL AND hushh_id<>row_state.hushh_id)
 OR jsonb_typeof(history) IS DISTINCT FROM 'object'
 OR EXISTS (SELECT 1 FROM jsonb_each(history) h
   WHERE h.value->'intent'->>'project' IS DISTINCT FROM coalesce(public.erasure_private_coordinates(r)->>'project',setup.project_id) OR NOT h.value ? 'receipt') THEN RETURN false; END IF;
 IF NOT azure_hosted AND NOT preparing THEN
 IF NOT never_hosted AND (public.erasure_planned_resources_covered(r) IS DISTINCT FROM true
 OR public.valid_erasure_repository_grant_receipt(r,'deletion',r->'repositoryGrantErasure'->'deletion') IS DISTINCT FROM true
 OR public.valid_erasure_repository_retention(r,r->'repositoryRetention') IS DISTINCT FROM true) THEN RETURN false; END IF;
 expected_release:=public.expected_erasure_bootstrap_release(owner_id,r,release->>'recoveryMember');
 IF expected_release IS NULL OR release IS DISTINCT FROM expected_release
 OR jsonb_typeof(r->'bootstrapGrantErasure') IS DISTINCT FROM 'object'
 OR (SELECT array_agg(key ORDER BY key) FROM jsonb_each(r->'bootstrapGrantErasure')) IS DISTINCT FROM
    (SELECT array_agg(key ORDER BY key) FROM jsonb_each(release->'groups')) THEN RETURN false; END IF;
 FOR item IN SELECT * FROM jsonb_each(release->'groups') LOOP
  stages:=r->'bootstrapGrantErasure'->item.key;
  wanted:=jsonb_build_object('ownerId',owner_id,'attemptId',r->>'attemptId',
   'bootstrapIdentity',item.value->'bootstrapIdentity','bindingObservation',item.value->'bindingObservation');
  IF jsonb_typeof(stages) IS DISTINCT FROM 'object' OR stages-ARRAY['admission','acknowledgement','deletion']<>'{}'::jsonb
   OR stages->'admission' IS DISTINCT FROM wanted||jsonb_build_object('status','admitted')
   OR stages->'deletion' IS DISTINCT FROM wanted||jsonb_build_object('status','observed_absent')
   OR (stages ? 'acknowledgement' AND stages->'acknowledgement' IS DISTINCT FROM wanted||jsonb_build_object('status','acknowledged')) THEN RETURN false; END IF;
 END LOOP;
 END IF;
 archive:=public.personal_agent_erasure_archive(r,history);
 IF octet_length(archive::text)>2097152 THEN RETURN false; END IF;
 IF EXISTS (SELECT 1 FROM public.personal_agent_deletion_tombstones t WHERE
  (t.hushh_id=row_state.hushh_id OR t.metadata->>'ownerId'=owner_id OR t.metadata->>'user_id'=owner_id)
  AND (t.status IS DISTINCT FROM 'erasure_completed' OR t.metadata IS DISTINCT FROM archive
       OR t.external_agent_id IS DISTINCT FROM row_state.external_agent_id)) THEN RETURN false; END IF;
 RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION public.project_grant_release_is_exclusive(owner_id text, target_project text)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
 IF target_project IS NULL OR target_project !~ '^[a-z][a-z0-9-]{4,61}[a-z0-9]$' OR current_setting('transaction_isolation') <> 'read committed' THEN RETURN false; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(target_project,205));
 IF (SELECT count(*) FROM pg_trigger WHERE
  (tgrelid='public.personal_agent_registry'::regclass AND tgname='zx_project_grant_registry' AND tgfoid='public.guard_project_grant_registry_admission()'::regprocedure AND tgtype=23)
  OR (tgrelid='public.byoc_setup_jobs'::regclass AND tgname='zx_project_grant_setup' AND tgfoid='public.guard_project_grant_setup_admission()'::regprocedure AND tgtype=23)
  OR (tgrelid='public.personal_agent_registry'::regclass AND tgname='zz_personal_agent_erasure_registry' AND tgfoid='public.guard_personal_agent_erasure_registry()'::regprocedure AND tgtype=27)
  OR (tgrelid='public.byoc_setup_jobs'::regclass AND tgname='zz_byoc_authorization_attempts' AND tgfoid='public.guard_byoc_authorization_attempts()'::regprocedure AND tgtype=31)) <> 4 THEN RETURN false; END IF;
 IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname IN ('zx_project_grant_registry','zx_project_grant_setup','zz_personal_agent_erasure_registry','zz_byoc_authorization_attempts') AND tgrelid IN ('public.personal_agent_registry'::regclass,'public.byoc_setup_jobs'::regclass) AND (tgenabled NOT IN ('O','A') OR tgnargs<>0 OR tgqual IS NOT NULL)) THEN RETURN false; END IF;
 -- Never lock other owners' rows under the project lock. Unresolved users retain grants.
 IF EXISTS (SELECT 1 FROM public.personal_agent_registry x WHERE x.user_id<>owner_id AND
   (x.user_cloud_project=target_project OR x.backend_metadata->'provisionAttempt'->'intent'->>'user_cloud_project'=target_project
    OR x.backend_metadata->'provisionAttempt'->'hostedAdmission'->'assignment'->>'project'=target_project))
 OR EXISTS (SELECT 1 FROM public.byoc_setup_jobs j WHERE j.project_id=target_project AND (j.user_id<>owner_id OR j.status IS DISTINCT FROM 'recorded')) THEN RETURN false; END IF;
 IF EXISTS (SELECT 1 FROM public.byoc_setup_jobs j CROSS JOIN LATERAL jsonb_each(j.authorization_attempts) a WHERE a.value->'intent'->>'project'=target_project AND (j.user_id<>owner_id OR NOT (a.value ? 'receipt'))) THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM public.hosted_pod_pilot_policy p,
  LATERAL jsonb_array_elements(p.assignments) a WHERE a->>'project'=target_project
  AND a->>'ownerHash'<>'sha256:'||encode(digest(owner_id,'sha256'),'hex')) THEN RETURN false; END IF;
 RETURN true;
END;
$function$;

CREATE OR REPLACE FUNCTION public.guard_project_grant_registry_admission()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
 IF TG_OP='INSERT' THEN
  -- ON CONFLICT acquires its existing row only after BEFORE INSERT. Match
  -- lifecycle admission's owner -> row -> project order before that happens.
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.user_id,171));
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.user_id,198));
  PERFORM 1 FROM public.personal_agent_registry WHERE user_id=NEW.user_id FOR UPDATE;
  PERFORM public.assert_project_grant_admission(NEW.user_cloud_project);
 ELSIF NEW.user_cloud_project IS DISTINCT FROM OLD.user_cloud_project
 OR NEW.user_cloud_bootstrap_sa IS DISTINCT FROM OLD.user_cloud_bootstrap_sa
 OR NEW.backend_metadata->'upgradeLease' IS DISTINCT FROM OLD.backend_metadata->'upgradeLease' AND NEW.backend_metadata->>'upgradeLease' IS NOT NULL
 OR NEW.backend_metadata->'provisionAttempt'->>'attemptId' IS DISTINCT FROM OLD.backend_metadata->'provisionAttempt'->>'attemptId'
 THEN PERFORM public.assert_project_grant_admission(NEW.user_cloud_project);
 END IF;
 IF NEW.backend_metadata->'provisionAttempt'->'hostedAdmission' IS DISTINCT FROM
       (CASE WHEN TG_OP='UPDATE' THEN OLD.backend_metadata->'provisionAttempt'->'hostedAdmission' ELSE NULL END) THEN
  PERFORM public.assert_project_grant_admission(NEW.backend_metadata->'provisionAttempt'->'hostedAdmission'->'assignment'->>'project');
 END IF;
 RETURN NEW;
END;
$function$;


CREATE OR REPLACE FUNCTION public.hosted_pod_upgrade_admitted(p_owner text,p_lease text,observed jsonb,p_work boolean DEFAULT true)
RETURNS boolean LANGUAGE sql SET search_path=public AS $$
 SELECT EXISTS(SELECT 1 FROM public.personal_agent_registry r JOIN public.hosted_pod_pilot_policy p ON p.singleton
 CROSS JOIN LATERAL (SELECT r.backend_metadata->'provisionAttempt' AS value) a
 WHERE r.user_id=p_owner AND r.status='provisioned' AND r.deployment_target='gcp'
 AND r.backend_metadata->>'upgradeLease'=p_lease AND coalesce(p_lease,'')<>''
 AND NOT r.backend_metadata ? 'erasure' AND to_jsonb(r)=to_jsonb(jsonb_populate_record(NULL::public.personal_agent_registry,observed))
 AND (p_work IS false OR (p_work IS true AND p.expires_at>clock_timestamp()))
 AND NOT EXISTS(SELECT 1 FROM public.account_deletion_tombstones t
  WHERE t.user_id_hash='sha256:'||encode(digest(p_owner,'sha256'),'hex'))
 AND public.private_gcp_coordinates(observed) IS NOT NULL
 AND p.environment='dev' AND p.policy_id::text=a.value->'hostedAdmission'->>'policyId'
 AND p.source_revision=a.value->'hostedAdmission'->>'sourceRevision'
 AND p.image_digest=a.value->'hostedAdmission'->>'imageDigest'
 AND p.model_binding=a.value->'hostedAdmission'->'modelBinding'
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(p.assignments) WITH ORDINALITY x(assignment,n)
  WHERE x.assignment=a.value->'hostedAdmission'->'assignment'
  AND CASE WHEN n=1 THEN p.attempt_a ELSE p.attempt_b END=a.value->>'attemptId'));
$$;


CREATE OR REPLACE FUNCTION public.hosted_pod_retained_admitted(p_owner text,observed jsonb)
RETURNS boolean LANGUAGE sql SET search_path=public AS $$
 SELECT EXISTS(SELECT 1 FROM public.personal_agent_registry r JOIN public.hosted_pod_pilot_policy p ON p.singleton
 CROSS JOIN LATERAL (SELECT observed->'backend_metadata'->'provisionAttempt' AS value) a
 WHERE r.user_id=p_owner AND r.deployment_target='gcp' AND observed->>'user_id'=p_owner
 AND (to_jsonb(r)=to_jsonb(jsonb_populate_record(NULL::public.personal_agent_registry,observed))
  OR r.backend_metadata->'erasure'->'registrySnapshot'=observed)
 AND (public.private_gcp_coordinates(observed) IS NOT NULL OR
  public.managed_preparation_cleanup_coordinates(jsonb_build_object('ownerId',p_owner,'hushhId',r.hushh_id,'registrySnapshot',observed)) IS NOT NULL)
 AND p.environment='dev' AND p.policy_id::text=a.value->'hostedAdmission'->>'policyId'
 AND p.source_revision=a.value->'hostedAdmission'->>'sourceRevision'
 AND p.image_digest=a.value->'hostedAdmission'->>'imageDigest'
 AND p.model_binding=a.value->'hostedAdmission'->'modelBinding'
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(p.assignments) WITH ORDINALITY x(assignment,n)
  WHERE x.assignment=a.value->'hostedAdmission'->'assignment'
  AND CASE WHEN n=1 THEN p.attempt_a ELSE p.attempt_b END=a.value->>'attemptId'));
$$;


REVOKE ALL ON FUNCTION public.erasure_authorization_history(jsonb,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.erasure_managed_model_grants_complete(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.erasure_private_coordinates(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.expected_erasure_bootstrap_release(text,jsonb,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_personal_agent_erasure_registry() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_project_grant_registry_admission() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.hosted_pod_cleanup_admitted(text,text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.hosted_pod_execution_admitted(text,text,jsonb,jsonb,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.hosted_pod_retained_admitted(text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.hosted_pod_upgrade_admitted(text,text,jsonb,boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.hosted_preparation_cleanup_admitted(text,text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.managed_preparation_cleanup_coordinates(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.personal_agent_erasure_archive(jsonb,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.personal_agent_erasure_archived(text,jsonb,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.personal_agent_erasure_complete(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.private_gcp_coordinates(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.project_grant_release_is_exclusive(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reserve_erasure_grant_release(text,text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reserve_personal_agent_erasure(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.retain_erasure_managed_model_grant_receipt(text,text,jsonb,text,text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.retain_erasure_managed_project_retirement(text,text,jsonb,text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.retain_hosted_pod_project_authorization(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.retain_managed_preparation_cleanup(text,text,jsonb,text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.valid_erasure_files_receipt(jsonb,text,text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.valid_erasure_gcp_files_upgrade_observation(jsonb,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.valid_erasure_grant_release(jsonb,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.valid_erasure_kms_receipt(jsonb,text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.valid_erasure_mail_receipt(jsonb,text,text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.valid_erasure_managed_model_grant_append(jsonb,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.valid_erasure_managed_model_grant_receipt(jsonb,text,text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.valid_erasure_managed_project_retirement(jsonb,text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.valid_erasure_managed_retirement_append(jsonb,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.valid_erasure_repository_grant_receipt(jsonb,text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.valid_erasure_repository_inventory(jsonb,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.valid_erasure_secret_receipt(jsonb,text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.valid_erasure_writer_receipt(jsonb,text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.valid_managed_preparation_cleanup(jsonb,text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.valid_managed_preparation_cleanup_append(jsonb,jsonb) FROM PUBLIC;
DO $hosted_custody_acl$
DECLARE signature text; client_role text;
BEGIN
 FOREACH signature IN ARRAY ARRAY['erasure_authorization_history(jsonb,jsonb)','erasure_managed_model_grants_complete(jsonb)','erasure_private_coordinates(jsonb)','expected_erasure_bootstrap_release(text,jsonb,text)','guard_personal_agent_erasure_registry()','guard_project_grant_registry_admission()','hosted_pod_cleanup_admitted(text,text,jsonb)','hosted_pod_execution_admitted(text,text,jsonb,jsonb,text)','hosted_pod_retained_admitted(text,jsonb)','hosted_pod_upgrade_admitted(text,text,jsonb,boolean)','hosted_preparation_cleanup_admitted(text,text,jsonb)','managed_preparation_cleanup_coordinates(jsonb)','personal_agent_erasure_archive(jsonb,jsonb)','personal_agent_erasure_archived(text,jsonb,jsonb)','personal_agent_erasure_complete(text)','private_gcp_coordinates(jsonb)','project_grant_release_is_exclusive(text,text)','reserve_erasure_grant_release(text,text,jsonb)','reserve_personal_agent_erasure(text,text)','retain_erasure_managed_model_grant_receipt(text,text,jsonb,text,text,jsonb)','retain_erasure_managed_project_retirement(text,text,jsonb,text,jsonb)','retain_hosted_pod_project_authorization(text,text)','retain_managed_preparation_cleanup(text,text,jsonb,text,jsonb)','valid_erasure_files_receipt(jsonb,text,text,jsonb)','valid_erasure_gcp_files_upgrade_observation(jsonb,jsonb)','valid_erasure_grant_release(jsonb,jsonb)','valid_erasure_kms_receipt(jsonb,text,jsonb)','valid_erasure_mail_receipt(jsonb,text,text,jsonb)','valid_erasure_managed_model_grant_append(jsonb,jsonb)','valid_erasure_managed_model_grant_receipt(jsonb,text,text,jsonb)','valid_erasure_managed_project_retirement(jsonb,text,jsonb)','valid_erasure_managed_retirement_append(jsonb,jsonb)','valid_erasure_repository_grant_receipt(jsonb,text,jsonb)','valid_erasure_repository_inventory(jsonb,jsonb)','valid_erasure_secret_receipt(jsonb,text,jsonb)','valid_erasure_writer_receipt(jsonb,text,jsonb)','valid_managed_preparation_cleanup(jsonb,text,jsonb)','valid_managed_preparation_cleanup_append(jsonb,jsonb)'] LOOP
  FOREACH client_role IN ARRAY ARRAY['anon','authenticated'] LOOP
   IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=client_role) THEN
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',to_regprocedure('public.'||signature),client_role);
   END IF;
  END LOOP;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
  GRANT EXECUTE ON FUNCTION public.erasure_authorization_history(jsonb,jsonb) TO service_role;
  GRANT EXECUTE ON FUNCTION public.erasure_managed_model_grants_complete(jsonb) TO service_role;
  GRANT EXECUTE ON FUNCTION public.erasure_private_coordinates(jsonb) TO service_role;
  GRANT EXECUTE ON FUNCTION public.expected_erasure_bootstrap_release(text,jsonb,text) TO service_role;
  GRANT EXECUTE ON FUNCTION public.guard_personal_agent_erasure_registry() TO service_role;
  GRANT EXECUTE ON FUNCTION public.guard_project_grant_registry_admission() TO service_role;
  GRANT EXECUTE ON FUNCTION public.hosted_pod_cleanup_admitted(text,text,jsonb) TO service_role;
  GRANT EXECUTE ON FUNCTION public.hosted_pod_execution_admitted(text,text,jsonb,jsonb,text) TO service_role;
  GRANT EXECUTE ON FUNCTION public.hosted_pod_retained_admitted(text,jsonb) TO service_role;
  GRANT EXECUTE ON FUNCTION public.hosted_pod_upgrade_admitted(text,text,jsonb,boolean) TO service_role;
  GRANT EXECUTE ON FUNCTION public.hosted_preparation_cleanup_admitted(text,text,jsonb) TO service_role;
  GRANT EXECUTE ON FUNCTION public.managed_preparation_cleanup_coordinates(jsonb) TO service_role;
  GRANT EXECUTE ON FUNCTION public.personal_agent_erasure_archive(jsonb,jsonb) TO service_role;
  GRANT EXECUTE ON FUNCTION public.personal_agent_erasure_archived(text,jsonb,jsonb) TO service_role;
  GRANT EXECUTE ON FUNCTION public.personal_agent_erasure_complete(text) TO service_role;
  GRANT EXECUTE ON FUNCTION public.private_gcp_coordinates(jsonb) TO service_role;
  GRANT EXECUTE ON FUNCTION public.project_grant_release_is_exclusive(text,text) TO service_role;
  GRANT EXECUTE ON FUNCTION public.reserve_erasure_grant_release(text,text,jsonb) TO service_role;
  GRANT EXECUTE ON FUNCTION public.reserve_personal_agent_erasure(text,text) TO service_role;
  GRANT EXECUTE ON FUNCTION public.retain_erasure_managed_model_grant_receipt(text,text,jsonb,text,text,jsonb) TO service_role;
  GRANT EXECUTE ON FUNCTION public.retain_erasure_managed_project_retirement(text,text,jsonb,text,jsonb) TO service_role;
  GRANT EXECUTE ON FUNCTION public.retain_hosted_pod_project_authorization(text,text) TO service_role;
  GRANT EXECUTE ON FUNCTION public.retain_managed_preparation_cleanup(text,text,jsonb,text,jsonb) TO service_role;
  GRANT EXECUTE ON FUNCTION public.valid_erasure_files_receipt(jsonb,text,text,jsonb) TO service_role;
  GRANT EXECUTE ON FUNCTION public.valid_erasure_gcp_files_upgrade_observation(jsonb,jsonb) TO service_role;
  GRANT EXECUTE ON FUNCTION public.valid_erasure_grant_release(jsonb,jsonb) TO service_role;
  GRANT EXECUTE ON FUNCTION public.valid_erasure_kms_receipt(jsonb,text,jsonb) TO service_role;
  GRANT EXECUTE ON FUNCTION public.valid_erasure_mail_receipt(jsonb,text,text,jsonb) TO service_role;
  GRANT EXECUTE ON FUNCTION public.valid_erasure_managed_model_grant_append(jsonb,jsonb) TO service_role;
  GRANT EXECUTE ON FUNCTION public.valid_erasure_managed_model_grant_receipt(jsonb,text,text,jsonb) TO service_role;
  GRANT EXECUTE ON FUNCTION public.valid_erasure_managed_project_retirement(jsonb,text,jsonb) TO service_role;
  GRANT EXECUTE ON FUNCTION public.valid_erasure_managed_retirement_append(jsonb,jsonb) TO service_role;
  GRANT EXECUTE ON FUNCTION public.valid_erasure_repository_grant_receipt(jsonb,text,jsonb) TO service_role;
  GRANT EXECUTE ON FUNCTION public.valid_erasure_repository_inventory(jsonb,jsonb) TO service_role;
  GRANT EXECUTE ON FUNCTION public.valid_erasure_secret_receipt(jsonb,text,jsonb) TO service_role;
  GRANT EXECUTE ON FUNCTION public.valid_erasure_writer_receipt(jsonb,text,jsonb) TO service_role;
  GRANT EXECUTE ON FUNCTION public.valid_managed_preparation_cleanup(jsonb,text,jsonb) TO service_role;
  GRANT EXECUTE ON FUNCTION public.valid_managed_preparation_cleanup_append(jsonb,jsonb) TO service_role;
 END IF;
END;
$hosted_custody_acl$;

COMMIT;
