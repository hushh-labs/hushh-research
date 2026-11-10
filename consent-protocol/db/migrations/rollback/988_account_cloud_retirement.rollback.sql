-- Refuse incompatible rollback while a retired generation requires forward cleanup.
BEGIN;
DO $qualify_cloud_retirement$
DECLARE spec record; actual record; owner_oid oid; service_oid oid; observed oid[]; expected oid[]; expected_hash text;
BEGIN
 IF NOT (EXISTS(SELECT 1 FROM pg_attribute
 WHERE attrelid=to_regclass('public.personal_agent_cloud_removals')
 AND attname='retirement_handoff' AND NOT attisdropped)
 OR to_regprocedure('public.account_cloud_retirement_contract_version()') IS NOT NULL OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f' AND encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex') IN ('46ebf928a464716775dbb84ceca792d562792fa8f18691c6f4d28b042f0406d8','3fb6bfc2963fd3a7bb5741ba70db020890d8f2a9e4bff431f66569a73b7d70a6','edc44eee732a394c9b5268d6db2b813efb105701021d91cb0330defbf564a382','f1046f6f233b2ea1bf5be76dad685a94cbf7379a41d65afbd961696fdd92601a','bddc407b8b4601b3f2b2d9241b399c313c5d220adb474c901796ddf4d23b87fd','28bb5f9a9653e44402a0e6986ae86ff1f315f2311c9e52cee30d310c77689f9a','bd41c7655c4262350d3daf85d80ff74a720bf89db8ef291d54dbf77b31ffcde3','732ef5d93c3258b232c2709f9a0a6f1698a7931d52735641807d7d441cfd475c','def10fe282d76a5b2ee1f786814ad668d941cb6ea165c2935ef97390a24298d4','3a4924b44171ed93b15cfbf72d2f8eec167238376e922b38ec6539f82dbb2538','5574fdb823d5654cee87c3b575b162a2f69fe79cc53293ff80251cb635283d91','0bcfb2a1762919ea62d9338d42e5d43a70bfa1b18cffc6faaf282a011257de76','30ddd268197a981d164f9ffba1dfb93ebb1ccef3aab8dc97925a0230a3874e99','c9a20c7143e9ada82bb9537803b742abb7e73df02a4c71151a483cc831b27b38','2d4afe0d0c6e1d62b22b7d7ea24c2311134090ad13f65119c0782a36ad2dfbfc','46ddbd3725e9d3ac0770d47257a99cace061e48c6d0e2aa6447a08e495a0a7d1','24a723475c31ae163e773e4ad6e60d9a8d4d6510012af9f6a33206d1c47ed63c','ec6753e784e56f1cfa4d212627f662227081206b1f421ae7642dea6515988f60')) OR EXISTS(SELECT 1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.guard_personal_agent_erasure_registry()') AND encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex')='4e46d9cfe6449efa70120cf0f5bef34f60d3ee11fbd9e05e8ed21518321c2dfa')) THEN RAISE EXCEPTION 'Cloud retirement contract is absent'; END IF;
 SELECT relowner INTO owner_oid FROM pg_class WHERE oid='public.personal_agent_cloud_removals'::regclass;
 SELECT oid INTO service_oid FROM pg_roles WHERE rolname='service_role';
 IF current_user<>session_user OR owner_oid<>(SELECT oid FROM pg_roles WHERE rolname=current_user) THEN
  RAISE EXCEPTION 'Cloud retirement requires the qualified database owner'; END IF;
 IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND (p.proname LIKE 'account_cloud_retirement_%'
   OR p.proname IN (SELECT split_part(signature,'(',1) FROM (VALUES ('account_cloud_retirement_contract_version()','46ebf928a464716775dbb84ceca792d562792fa8f18691c6f4d28b042f0406d8','i',false,ARRAY['search_path=public']::text[],false),('account_cloud_retirement_handoff_valid(text,jsonb)','3fb6bfc2963fd3a7bb5741ba70db020890d8f2a9e4bff431f66569a73b7d70a6','s',false,ARRAY['search_path=public']::text[],false),('account_cloud_retirement_local_erasure_ready(text)','edc44eee732a394c9b5268d6db2b813efb105701021d91cb0330defbf564a382','s',false,ARRAY['search_path=public']::text[],false),('account_cloud_retirement_quiescent(text,text)','f1046f6f233b2ea1bf5be76dad685a94cbf7379a41d65afbd961696fdd92601a','s',false,ARRAY['search_path=public']::text[],false),('account_cloud_retirement_ready(text,text)','bddc407b8b4601b3f2b2d9241b399c313c5d220adb474c901796ddf4d23b87fd','s',false,ARRAY['search_path=public']::text[],false),('account_cloud_retirement_reservation(text,text)','28bb5f9a9653e44402a0e6986ae86ff1f315f2311c9e52cee30d310c77689f9a','s',false,ARRAY['search_path=public']::text[],false),('account_cloud_retirement_retained(text)','bd41c7655c4262350d3daf85d80ff74a720bf89db8ef291d54dbf77b31ffcde3','s',false,ARRAY['search_path=public']::text[],false),('account_cloud_retirement_transition_valid(jsonb,jsonb)','732ef5d93c3258b232c2709f9a0a6f1698a7931d52735641807d7d441cfd475c','s',false,ARRAY['search_path=public']::text[],false),('assert_project_grant_admission(text)','def10fe282d76a5b2ee1f786814ad668d941cb6ea165c2935ef97390a24298d4','v',false,ARRAY['search_path=public']::text[],false),('finalize_personal_agent_cloud_removal(text,text,text)','3a4924b44171ed93b15cfbf72d2f8eec167238376e922b38ec6539f82dbb2538','v',false,ARRAY['search_path=public']::text[],false),('guard_byoc_authorization_attempts()','5574fdb823d5654cee87c3b575b162a2f69fe79cc53293ff80251cb635283d91','v',false,ARRAY['search_path=public']::text[],false),('guard_personal_agent_cloud_removal()','0bcfb2a1762919ea62d9338d42e5d43a70bfa1b18cffc6faaf282a011257de76','v',false,ARRAY['search_path=public']::text[],false),('guard_personal_agent_erasure_registry()','30ddd268197a981d164f9ffba1dfb93ebb1ccef3aab8dc97925a0230a3874e99','v',false,ARRAY['search_path=public']::text[],false),('legacy_cloud_removal_complete(text,text)','c9a20c7143e9ada82bb9537803b742abb7e73df02a4c71151a483cc831b27b38','s',false,ARRAY['search_path=public']::text[],false),('legacy_cloud_removal_event_valid(jsonb,jsonb)','2d4afe0d0c6e1d62b22b7d7ea24c2311134090ad13f65119c0782a36ad2dfbfc','v',false,ARRAY['search_path=public']::text[],false),('reject_retired_account_update()','46ddbd3725e9d3ac0770d47257a99cace061e48c6d0e2aa6447a08e495a0a7d1','v',true,ARRAY['search_path=pg_catalog, public, pg_temp']::text[],true),('retain_account_cloud_retirement(text,uuid,text)','24a723475c31ae163e773e4ad6e60d9a8d4d6510012af9f6a33206d1c47ed63c','v',false,ARRAY['search_path=public']::text[],false),('retain_legacy_cloud_removal(text,text,text,jsonb,jsonb)','ec6753e784e56f1cfa4d212627f662227081206b1f421ae7642dea6515988f60','v',false,ARRAY['search_path=public']::text[],false)) q(signature,h,v,s,c,a)))
  AND NOT EXISTS(SELECT 1 FROM (VALUES ('account_cloud_retirement_contract_version()','46ebf928a464716775dbb84ceca792d562792fa8f18691c6f4d28b042f0406d8','i',false,ARRAY['search_path=public']::text[],false),('account_cloud_retirement_handoff_valid(text,jsonb)','3fb6bfc2963fd3a7bb5741ba70db020890d8f2a9e4bff431f66569a73b7d70a6','s',false,ARRAY['search_path=public']::text[],false),('account_cloud_retirement_local_erasure_ready(text)','edc44eee732a394c9b5268d6db2b813efb105701021d91cb0330defbf564a382','s',false,ARRAY['search_path=public']::text[],false),('account_cloud_retirement_quiescent(text,text)','f1046f6f233b2ea1bf5be76dad685a94cbf7379a41d65afbd961696fdd92601a','s',false,ARRAY['search_path=public']::text[],false),('account_cloud_retirement_ready(text,text)','bddc407b8b4601b3f2b2d9241b399c313c5d220adb474c901796ddf4d23b87fd','s',false,ARRAY['search_path=public']::text[],false),('account_cloud_retirement_reservation(text,text)','28bb5f9a9653e44402a0e6986ae86ff1f315f2311c9e52cee30d310c77689f9a','s',false,ARRAY['search_path=public']::text[],false),('account_cloud_retirement_retained(text)','bd41c7655c4262350d3daf85d80ff74a720bf89db8ef291d54dbf77b31ffcde3','s',false,ARRAY['search_path=public']::text[],false),('account_cloud_retirement_transition_valid(jsonb,jsonb)','732ef5d93c3258b232c2709f9a0a6f1698a7931d52735641807d7d441cfd475c','s',false,ARRAY['search_path=public']::text[],false),('assert_project_grant_admission(text)','def10fe282d76a5b2ee1f786814ad668d941cb6ea165c2935ef97390a24298d4','v',false,ARRAY['search_path=public']::text[],false),('finalize_personal_agent_cloud_removal(text,text,text)','3a4924b44171ed93b15cfbf72d2f8eec167238376e922b38ec6539f82dbb2538','v',false,ARRAY['search_path=public']::text[],false),('guard_byoc_authorization_attempts()','5574fdb823d5654cee87c3b575b162a2f69fe79cc53293ff80251cb635283d91','v',false,ARRAY['search_path=public']::text[],false),('guard_personal_agent_cloud_removal()','0bcfb2a1762919ea62d9338d42e5d43a70bfa1b18cffc6faaf282a011257de76','v',false,ARRAY['search_path=public']::text[],false),('guard_personal_agent_erasure_registry()','30ddd268197a981d164f9ffba1dfb93ebb1ccef3aab8dc97925a0230a3874e99','v',false,ARRAY['search_path=public']::text[],false),('legacy_cloud_removal_complete(text,text)','c9a20c7143e9ada82bb9537803b742abb7e73df02a4c71151a483cc831b27b38','s',false,ARRAY['search_path=public']::text[],false),('legacy_cloud_removal_event_valid(jsonb,jsonb)','2d4afe0d0c6e1d62b22b7d7ea24c2311134090ad13f65119c0782a36ad2dfbfc','v',false,ARRAY['search_path=public']::text[],false),('reject_retired_account_update()','46ddbd3725e9d3ac0770d47257a99cace061e48c6d0e2aa6447a08e495a0a7d1','v',true,ARRAY['search_path=pg_catalog, public, pg_temp']::text[],true),('retain_account_cloud_retirement(text,uuid,text)','24a723475c31ae163e773e4ad6e60d9a8d4d6510012af9f6a33206d1c47ed63c','v',false,ARRAY['search_path=public']::text[],false),('retain_legacy_cloud_removal(text,text,text,jsonb,jsonb)','ec6753e784e56f1cfa4d212627f662227081206b1f421ae7642dea6515988f60','v',false,ARRAY['search_path=public']::text[],false)) q(signature,h,v,s,c,a)
   WHERE p.oid=to_regprocedure('public.'||q.signature))) THEN
  RAISE EXCEPTION 'Cloud retirement overload changed'; END IF;
 FOR spec IN SELECT * FROM (VALUES ('account_cloud_retirement_contract_version()','46ebf928a464716775dbb84ceca792d562792fa8f18691c6f4d28b042f0406d8','i',false,ARRAY['search_path=public']::text[],false),('account_cloud_retirement_handoff_valid(text,jsonb)','3fb6bfc2963fd3a7bb5741ba70db020890d8f2a9e4bff431f66569a73b7d70a6','s',false,ARRAY['search_path=public']::text[],false),('account_cloud_retirement_local_erasure_ready(text)','edc44eee732a394c9b5268d6db2b813efb105701021d91cb0330defbf564a382','s',false,ARRAY['search_path=public']::text[],false),('account_cloud_retirement_quiescent(text,text)','f1046f6f233b2ea1bf5be76dad685a94cbf7379a41d65afbd961696fdd92601a','s',false,ARRAY['search_path=public']::text[],false),('account_cloud_retirement_ready(text,text)','bddc407b8b4601b3f2b2d9241b399c313c5d220adb474c901796ddf4d23b87fd','s',false,ARRAY['search_path=public']::text[],false),('account_cloud_retirement_reservation(text,text)','28bb5f9a9653e44402a0e6986ae86ff1f315f2311c9e52cee30d310c77689f9a','s',false,ARRAY['search_path=public']::text[],false),('account_cloud_retirement_retained(text)','bd41c7655c4262350d3daf85d80ff74a720bf89db8ef291d54dbf77b31ffcde3','s',false,ARRAY['search_path=public']::text[],false),('account_cloud_retirement_transition_valid(jsonb,jsonb)','732ef5d93c3258b232c2709f9a0a6f1698a7931d52735641807d7d441cfd475c','s',false,ARRAY['search_path=public']::text[],false),('assert_project_grant_admission(text)','def10fe282d76a5b2ee1f786814ad668d941cb6ea165c2935ef97390a24298d4','v',false,ARRAY['search_path=public']::text[],false),('finalize_personal_agent_cloud_removal(text,text,text)','3a4924b44171ed93b15cfbf72d2f8eec167238376e922b38ec6539f82dbb2538','v',false,ARRAY['search_path=public']::text[],false),('guard_byoc_authorization_attempts()','5574fdb823d5654cee87c3b575b162a2f69fe79cc53293ff80251cb635283d91','v',false,ARRAY['search_path=public']::text[],false),('guard_personal_agent_cloud_removal()','0bcfb2a1762919ea62d9338d42e5d43a70bfa1b18cffc6faaf282a011257de76','v',false,ARRAY['search_path=public']::text[],false),('guard_personal_agent_erasure_registry()','30ddd268197a981d164f9ffba1dfb93ebb1ccef3aab8dc97925a0230a3874e99','v',false,ARRAY['search_path=public']::text[],false),('legacy_cloud_removal_complete(text,text)','c9a20c7143e9ada82bb9537803b742abb7e73df02a4c71151a483cc831b27b38','s',false,ARRAY['search_path=public']::text[],false),('legacy_cloud_removal_event_valid(jsonb,jsonb)','2d4afe0d0c6e1d62b22b7d7ea24c2311134090ad13f65119c0782a36ad2dfbfc','v',false,ARRAY['search_path=public']::text[],false),('reject_retired_account_update()','46ddbd3725e9d3ac0770d47257a99cace061e48c6d0e2aa6447a08e495a0a7d1','v',true,ARRAY['search_path=pg_catalog, public, pg_temp']::text[],true),('retain_account_cloud_retirement(text,uuid,text)','24a723475c31ae163e773e4ad6e60d9a8d4d6510012af9f6a33206d1c47ed63c','v',false,ARRAY['search_path=public']::text[],false),('retain_legacy_cloud_removal(text,text,text,jsonb,jsonb)','ec6753e784e56f1cfa4d212627f662227081206b1f421ae7642dea6515988f60','v',false,ARRAY['search_path=public']::text[],false)) q(signature,h,v,s,c,a) LOOP
  expected_hash:=CASE WHEN spec.signature='guard_personal_agent_erasure_registry()'
    AND to_regclass('public.hosted_files_executor_976_rollback_source') IS NOT NULL
    THEN '4e46d9cfe6449efa70120cf0f5bef34f60d3ee11fbd9e05e8ed21518321c2dfa' ELSE spec.h END;
  SELECT p.*,encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex') AS hash
   INTO actual FROM pg_proc p WHERE p.oid=to_regprocedure('public.'||spec.signature);
  IF NOT FOUND OR actual.hash IS DISTINCT FROM expected_hash OR actual.proowner IS DISTINCT FROM owner_oid
   OR actual.prokind IS DISTINCT FROM 'f' OR actual.provolatile::text IS DISTINCT FROM spec.v
   OR actual.prosecdef IS DISTINCT FROM spec.s OR actual.proconfig IS DISTINCT FROM spec.c
   OR actual.proleakproof OR actual.proretset THEN
   RAISE EXCEPTION 'Cloud retirement function changed: %',spec.signature; END IF;
  SELECT array_agg(grantee ORDER BY grantee) INTO observed
   FROM aclexplode(coalesce(actual.proacl,acldefault('f',actual.proowner)));
  SELECT array_agg(v ORDER BY v) INTO expected FROM unnest(
   ARRAY[owner_oid]||CASE WHEN spec.a THEN ARRAY[0::oid] ELSE ARRAY[]::oid[] END
   ||CASE WHEN service_oid IS NOT NULL AND spec.signature IN ('guard_byoc_authorization_attempts()','guard_personal_agent_erasure_registry()','guard_personal_agent_cloud_removal()','finalize_personal_agent_cloud_removal(text,text,text)','assert_project_grant_admission(text)') THEN ARRAY[service_oid] ELSE ARRAY[]::oid[] END) v;
  IF observed IS DISTINCT FROM expected OR EXISTS(
   SELECT 1 FROM aclexplode(coalesce(actual.proacl,acldefault('f',actual.proowner))) a
    WHERE a.grantor IS DISTINCT FROM owner_oid OR a.privilege_type<>'EXECUTE' OR a.is_grantable) THEN
   RAISE EXCEPTION 'Cloud retirement ACL changed: %',spec.signature; END IF;
 END LOOP;
 FOR spec IN SELECT * FROM (VALUES ('cloud_removal_cancel_inert','CHECK (cancelled_at IS NULL OR approved_digest IS NULL AND execution_started_at IS NULL AND completed_at IS NULL)'),('cloud_removal_dispatch_pair','CHECK ((execution_started_at IS NULL) = (execution_digest IS NULL))'),('cloud_removal_recovery_bounded','CHECK (recovery IS NULL OR jsonb_typeof(recovery) = ''object''::text AND octet_length(recovery::text) <= 2097152)'),('cloud_removal_retired_completion','CHECK (completed_at IS NULL AND released_identity IS NULL OR completed_at IS NOT NULL AND (retirement_handoff IS NULL AND released_identity IS NOT NULL OR retirement_handoff IS NOT NULL AND released_identity IS NULL))'),('cloud_removal_retirement_handoff_bounded','CHECK (retirement_handoff IS NULL OR jsonb_typeof(retirement_handoff) = ''object''::text AND octet_length(retirement_handoff::text) <= 2097152)'),('personal_agent_cloud_removals_approved_digest_check','CHECK (approved_digest ~ ''^[0-9a-f]{64}$''::text)'),('personal_agent_cloud_removals_archive_check','CHECK (archive IS NULL OR jsonb_typeof(archive) = ''object''::text AND octet_length(archive::text) <= 2097152)'),('personal_agent_cloud_removals_check','CHECK ((approved_digest IS NULL) = (approved_at IS NULL))'),('personal_agent_cloud_removals_check1','CHECK ((completed_at IS NULL) = (archive IS NULL))'),('personal_agent_cloud_removals_execution_digest_check','CHECK (execution_digest ~ ''^[0-9a-f]{64}$''::text)'),('personal_agent_cloud_removals_placement_epoch_check','CHECK (placement_epoch >= 0)'),('personal_agent_cloud_removals_snapshot_sha256_check','CHECK (snapshot_sha256 ~ ''^[0-9a-f]{64}$''::text)')) q(name,definition) LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.personal_agent_cloud_removals'::regclass
   AND conname=spec.name AND contype='c' AND convalidated AND conislocal AND NOT condeferrable
   AND NOT condeferred AND coninhcount=0 AND pg_get_constraintdef(oid,true)=spec.definition) THEN
   RAISE EXCEPTION 'Cloud retirement constraint changed: %',spec.name; END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
  WHERE a.attrelid='public.personal_agent_cloud_removals'::regclass AND a.attname='retirement_handoff'
   AND NOT a.attisdropped AND a.atttypid='jsonb'::regtype AND a.atttypmod=-1 AND NOT a.attnotnull
   AND NOT a.atthasdef AND d.oid IS NULL AND a.attidentity='' AND a.attgenerated='' AND a.attndims=0) THEN
  RAISE EXCEPTION 'Cloud retirement column changed'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.personal_agent_cloud_removals'::regclass
  AND tgname='account_retired_generation_update' AND tgenabled='O' AND NOT tgisinternal AND tgtype=19
  AND tgfoid='public.reject_retired_account_update()'::regprocedure AND tgnargs=1
  AND encode(tgargs,'hex')=encode(convert_to('user_id','UTF8'),'hex')||'00'
  AND tgqual IS NULL AND tgattr::text='' AND tgparentid=0 AND tgconstraint=0
  AND NOT tgdeferrable AND NOT tginitdeferred AND tgoldtable IS NULL AND tgnewtable IS NULL) THEN
  RAISE EXCEPTION 'Cloud retirement generation guard changed'; END IF;
END $qualify_cloud_retirement$;
DO $retirement_rollback$ BEGIN
 IF EXISTS(SELECT 1 FROM public.personal_agent_cloud_removals WHERE retirement_handoff IS NOT NULL) THEN
 RAISE EXCEPTION 'Retired account cleanup requires forward recovery' USING ERRCODE='42501'; END IF;
END $retirement_rollback$;
DO $restore_registry_profile$ BEGIN
 IF to_regclass('public.hosted_files_executor_976_rollback_source') IS NOT NULL THEN
 EXECUTE $native$CREATE OR REPLACE FUNCTION public.guard_personal_agent_erasure_registry()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE reservation jsonb; snapshot jsonb; cancel_allowed boolean;
BEGIN

  IF TG_OP='INSERT' THEN
   IF public.hosted_files_executor_registry_guard(NULL,to_jsonb(NEW),'INSERT') IS NOT TRUE THEN
    RAISE EXCEPTION 'hosted Files executor evidence invalid' USING ERRCODE='42501'; END IF;
  ELSIF TG_OP='DELETE' THEN
   IF public.hosted_files_executor_registry_guard(to_jsonb(OLD),NULL,'DELETE') IS NOT TRUE THEN
    RAISE EXCEPTION 'hosted Files executor evidence invalid' USING ERRCODE='42501'; END IF;
  ELSE
   IF public.hosted_files_executor_registry_guard(to_jsonb(OLD),to_jsonb(NEW),'UPDATE') IS NOT TRUE THEN
    RAISE EXCEPTION 'hosted Files executor evidence invalid' USING ERRCODE='42501'; END IF;
  END IF;
  IF TG_OP='UPDATE' AND OLD.backend_metadata ? 'erasure'
   AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
   AND (((NEW.backend_metadata->'erasure')-'lateFilesProviderSettlement'=OLD.backend_metadata->'erasure'
         AND NOT (OLD.backend_metadata->'erasure' ? 'lateFilesProviderSettlement'))
     OR ((NEW.backend_metadata->'erasure')-'lateFilesExecutorExit'=OLD.backend_metadata->'erasure'
         AND NOT (OLD.backend_metadata->'erasure' ? 'lateFilesExecutorExit'))
     OR ((NEW.backend_metadata->'erasure')-'lateFilesReplacementIntent'=OLD.backend_metadata->'erasure'
         AND NOT (OLD.backend_metadata->'erasure' ? 'lateFilesReplacementIntent')))
  THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND OLD.backend_metadata->'hostedFilesExecutor' IS NULL
   AND NEW.backend_metadata->'hostedFilesExecutor' IS NOT NULL
   AND public.hosted_files_executor_owner_locks_held(NEW.user_id)
   AND public.hosted_files_executor_session_held(NEW.user_id,NEW.backend_metadata->'hostedFilesExecutor')
  THEN RETURN NEW; END IF;
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

    IF TG_OP='UPDATE' AND to_jsonb(NEW)-'backend_metadata'=to_jsonb(OLD)-'backend_metadata'
       AND NEW.backend_metadata-'erasure'=OLD.backend_metadata-'erasure'
       AND public.hosted_prefix_abort_admitted(OLD.user_id,reservation->>'attemptId',reservation) IS TRUE
       AND public.valid_managed_prefix_abort_append(reservation,NEW.backend_metadata->'erasure') IS TRUE
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
$function$
$native$;
 ELSE
 EXECUTE $baseline$CREATE OR REPLACE FUNCTION public.guard_personal_agent_erasure_registry()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE reservation jsonb; snapshot jsonb;
BEGIN
  IF TG_OP='UPDATE' AND public.cloud_removal_cancel_restore_allowed(to_jsonb(OLD),to_jsonb(NEW)) IS TRUE THEN RETURN NEW; END IF;
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
$function$
$baseline$;
 END IF;
END $restore_registry_profile$;
CREATE OR REPLACE FUNCTION public.guard_byoc_authorization_attempts()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE k text; v jsonb; old_v jsonb; intent jsonb; receipt jsonb; binding jsonb; identity jsonb;
BEGIN
 IF TG_OP='DELETE' THEN
  IF public.personal_agent_erasure_archived(OLD.user_id,
    (SELECT backend_metadata->'erasure' FROM public.personal_agent_registry WHERE user_id=OLD.user_id),
    OLD.authorization_attempts) IS TRUE THEN RETURN OLD; END IF;
  IF OLD.authorization_attempts<>'{}'::jsonb THEN RAISE EXCEPTION 'authorization recovery retained' USING ERRCODE='42501'; END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.authorization_attempts<>'{}'::jsonb THEN RAISE EXCEPTION 'authorization admission required' USING ERRCODE='42501'; END IF;
  RETURN NEW;
 END IF;
 IF NEW.user_id IS DISTINCT FROM OLD.user_id AND OLD.authorization_attempts<>'{}'::jsonb THEN RAISE EXCEPTION 'authorization owner immutable' USING ERRCODE='42501'; END IF;
 IF NEW.authorization_attempts=OLD.authorization_attempts THEN RETURN NEW; END IF;
 IF NEW.user_id IS DISTINCT FROM OLD.user_id OR jsonb_typeof(NEW.authorization_attempts) IS DISTINCT FROM 'object'
 OR NOT NEW.authorization_attempts ?& ARRAY(SELECT jsonb_object_keys(OLD.authorization_attempts)) THEN
  RAISE EXCEPTION 'authorization recovery immutable' USING ERRCODE='42501'; END IF;
 FOR k,v IN SELECT * FROM jsonb_each(NEW.authorization_attempts) LOOP
  old_v:=OLD.authorization_attempts->k;
  IF v=old_v THEN CONTINUE; END IF;
  intent:=v->'intent';
  IF old_v IS NULL THEN
   IF k IS DISTINCT FROM OLD.job_id OR OLD.status IS DISTINCT FROM 'running'
   OR v - 'intent'<>'{}'::jsonb OR jsonb_typeof(intent) IS DISTINCT FROM 'object'
   OR intent - ARRAY['ownerId','jobId','project','bootstrapEmail','callerEmail']<>'{}'::jsonb
   OR intent->>'ownerId' IS DISTINCT FROM OLD.user_id OR intent->>'jobId' IS DISTINCT FROM k
   OR intent->>'project' IS DISTINCT FROM OLD.project_id
   OR (intent->>'bootstrapEmail' ~ ('^[a-z][a-z0-9-]{4,28}[a-z0-9]@'||OLD.project_id||'\.iam\.gserviceaccount\.com$')) IS DISTINCT FROM true
   OR (intent->>'callerEmail' ~ '^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.gserviceaccount\.com$') IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'authorization intent invalid' USING ERRCODE='42501'; END IF;
   PERFORM public.assert_project_grant_admission(OLD.project_id);
  ELSE
   receipt:=v->'receipt'; binding:=receipt->'bindingObservation'; identity:=receipt->'bootstrapIdentity';
   IF old_v ? 'receipt' OR v - 'receipt' IS DISTINCT FROM old_v
   OR jsonb_typeof(receipt) IS DISTINCT FROM 'object' OR receipt - ARRAY['bindingObservation','bootstrapIdentity']<>'{}'::jsonb
   OR jsonb_typeof(binding) IS DISTINCT FROM 'object' OR jsonb_typeof(identity) IS DISTINCT FROM 'object'
   OR identity->>'email' IS DISTINCT FROM intent->>'bootstrapEmail'
   OR identity->>'projectId' IS DISTINCT FROM intent->>'project'
   OR identity->>'name' IS DISTINCT FROM 'projects/'||(intent->>'project')||'/serviceAccounts/'||(intent->>'bootstrapEmail')
   OR (identity->>'uniqueId' ~ '^[0-9]{10,30}$') IS DISTINCT FROM true
   OR identity - ARRAY['name','projectId','email','uniqueId']<>'{}'::jsonb
   OR binding->>'step' IS DISTINCT FROM 'authorize_bootstrap_impersonation'
   OR binding->>'role' IS DISTINCT FROM 'roles/iam.serviceAccountTokenCreator'
   OR binding->>'member' IS DISTINCT FROM 'serviceAccount:'||(intent->>'callerEmail')
   OR binding->>'policyResource' IS DISTINCT FROM 'https://iam.googleapis.com/v1/projects/'||(intent->>'project')||'/serviceAccounts/'||(intent->>'bootstrapEmail')||':getIamPolicy'
   OR (binding->>'disposition' IN ('added','already_present')) IS DISTINCT FROM true
   OR coalesce(length(binding->>'beforeEtag'),0) NOT BETWEEN 1 AND 512
   OR coalesce(length(binding->>'afterEtag'),0) NOT BETWEEN 1 AND 512
   OR binding - ARRAY['step','policyResource','role','member','disposition','beforeEtag','afterEtag']<>'{}'::jsonb THEN
    RAISE EXCEPTION 'authorization receipt invalid' USING ERRCODE='42501'; END IF;
  END IF;
 END LOOP;
 RETURN NEW;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.reject_retired_account_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
DECLARE identity_column text; previous_owner text;
BEGIN
 IF current_setting('transaction_isolation') NOT IN ('read committed','read uncommitted') THEN
  RAISE EXCEPTION 'account generation guard requires read committed isolation' USING ERRCODE='25001';
 END IF;
 FOREACH identity_column IN ARRAY TG_ARGV LOOP
  EXECUTE format('SELECT ($1).%I::text',identity_column) INTO previous_owner USING OLD;
  IF previous_owner IS NOT NULL AND EXISTS(SELECT 1 FROM public.account_deletion_tombstones
   WHERE user_id_hash='sha256:'||encode(sha256(convert_to(previous_owner,'UTF8')),'hex')
    AND cleanup_intent_kind='full_account' AND erasure_phase='erased') THEN
   RAISE EXCEPTION 'account generation is retired' USING ERRCODE='23514',
    CONSTRAINT='account_retired_generation_update_guard';
  END IF;
 END LOOP;
 RETURN NEW;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.guard_personal_agent_cloud_removal()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE owner_id text; agent public.personal_agent_registry%ROWTYPE; r jsonb; review jsonb; history jsonb;
BEGIN
 owner_id:=CASE WHEN TG_OP='DELETE' THEN OLD.user_id ELSE NEW.user_id END;
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 -- Full account erasure explicitly removes these records in its own transaction.
 IF TG_OP='DELETE' THEN
  IF EXISTS(SELECT 1 FROM public.account_deletion_tombstones WHERE cleanup_intent_kind='full_account'
   AND user_id_hash='sha256:'||encode(sha256(convert_to(owner_id,'UTF8')),'hex')) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'cloud removal evidence retained' USING ERRCODE='42501';
 END IF;
 IF EXISTS(SELECT 1 FROM public.account_deletion_tombstones
  WHERE user_id_hash='sha256:'||encode(sha256(convert_to(owner_id,'UTF8')),'hex')) THEN
  RAISE EXCEPTION 'cloud removal owner deleted' USING ERRCODE='42501'; END IF;
 SELECT * INTO agent FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 r:=agent.backend_metadata->'erasure';
 IF NOT FOUND OR agent.status IS DISTINCT FROM 'suspended' OR jsonb_typeof(r) IS DISTINCT FROM 'object'
 OR NEW.attempt_id IS DISTINCT FROM r->>'attemptId' OR r->>'ownerId' IS DISTINCT FROM owner_id
 OR NEW.placement_epoch IS DISTINCT FROM agent.placement_epoch
 OR NEW.snapshot_sha256 IS DISTINCT FROM encode(sha256(convert_to((r->'registrySnapshot')::text,'UTF8')),'hex') THEN
  RAISE EXCEPTION 'cloud removal placement changed' USING ERRCODE='42501'; END IF;
 IF TG_OP='INSERT' AND NEW.recovery IS NOT NULL THEN
  RAISE EXCEPTION 'legacy recovery requires an existing removal' USING ERRCODE='42501'; END IF;
 IF TG_OP='UPDATE' AND NEW.recovery IS DISTINCT FROM OLD.recovery THEN
  IF OLD.completed_at IS NOT NULL OR OLD.cancelled_at IS NOT NULL
  OR to_jsonb(NEW)-'recovery' IS DISTINCT FROM to_jsonb(OLD)-'recovery'
  OR public.legacy_cloud_removal_append_valid(r,OLD.recovery,NEW.recovery) IS NOT TRUE THEN
   RAISE EXCEPTION 'legacy recovery append refused' USING ERRCODE='42501'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP='UPDATE' AND OLD.cancelled_at IS NOT NULL THEN
  RAISE EXCEPTION 'cancelled cloud removal immutable' USING ERRCODE='42501'; END IF;
 IF TG_OP='UPDATE' AND NEW.cancelled_at IS NOT NULL THEN
  IF to_jsonb(NEW)-'cancelled_at' IS DISTINCT FROM to_jsonb(OLD)-'cancelled_at'
  OR public.cloud_removal_cancel_ready(owner_id,NEW.attempt_id) IS NOT TRUE THEN
   RAISE EXCEPTION 'cloud removal cannot cancel' USING ERRCODE='42501'; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.approved_digest IS NOT NULL OR NEW.archive IS NOT NULL OR NEW.cancelled_at IS NOT NULL OR NEW.execution_started_at IS NOT NULL OR NEW.execution_digest IS NOT NULL THEN
   RAISE EXCEPTION 'cloud removal approval required' USING ERRCODE='42501'; END IF;
  RETURN NEW;
 END IF;
 IF OLD.completed_at IS NOT NULL OR to_jsonb(NEW)-ARRAY['approved_digest','approved_at','completed_at','archive','released_identity','execution_started_at','execution_digest']
  IS DISTINCT FROM to_jsonb(OLD)-ARRAY['approved_digest','approved_at','completed_at','archive','released_identity','execution_started_at','execution_digest'] THEN
  RAISE EXCEPTION 'cloud removal evidence immutable' USING ERRCODE='42501'; END IF;
 IF OLD.execution_started_at IS NOT NULL AND (NEW.execution_started_at IS DISTINCT FROM OLD.execution_started_at
  OR NEW.execution_digest IS DISTINCT FROM OLD.execution_digest) THEN
  RAISE EXCEPTION 'cloud removal dispatch immutable' USING ERRCODE='42501'; END IF;
 IF NEW.execution_started_at IS NOT NULL AND (NEW.execution_digest IS DISTINCT FROM NEW.approved_digest
  OR (OLD.execution_started_at IS NULL AND public.personal_agent_cloud_removal_execute_ready(owner_id,NEW.attempt_id) IS NOT TRUE)) THEN
  RAISE EXCEPTION 'cloud removal dispatch not admitted' USING ERRCODE='42501'; END IF;
 review:=public.personal_agent_cloud_removal_review(r);
 IF NEW.approved_digest IS NULL OR NEW.approved_digest IS DISTINCT FROM encode(sha256(convert_to(review::text,'UTF8')),'hex')
 OR (NEW.archive IS NOT NULL AND (NEW.approved_digest IS DISTINCT FROM OLD.approved_digest
  OR NEW.approved_at IS DISTINCT FROM OLD.approved_at)) THEN
  RAISE EXCEPTION 'cloud removal approval changed' USING ERRCODE='42501'; END IF;
 IF NEW.archive IS NOT NULL THEN
  SELECT authorization_attempts INTO history FROM public.byoc_setup_jobs WHERE user_id=owner_id;
  IF public.legacy_cloud_removal_complete(owner_id,NEW.attempt_id) IS TRUE THEN
   IF NEW.archive IS DISTINCT FROM public.legacy_cloud_removal_archive(r,history,OLD.recovery)
    OR NEW.released_identity IS DISTINCT FROM public.personal_agent_cloud_removal_identity(to_jsonb(agent),NEW.completed_at,NEW.attempt_id) THEN
    RAISE EXCEPTION 'legacy recovery completion unconfirmed' USING ERRCODE='42501'; END IF;
   RETURN NEW;
  END IF;
  IF public.personal_agent_erasure_complete(owner_id) IS NOT TRUE
  OR NEW.archive IS DISTINCT FROM public.personal_agent_erasure_archive(r,history)
  OR NEW.released_identity IS DISTINCT FROM public.personal_agent_cloud_removal_identity(to_jsonb(agent),NEW.completed_at,NEW.attempt_id) THEN
   RAISE EXCEPTION 'cloud removal completion unconfirmed' USING ERRCODE='42501'; END IF;
 END IF;
 RETURN NEW;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.retain_legacy_cloud_removal(owner_id text, attempt text, expected_digest text, plan jsonb, event jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE op public.personal_agent_cloud_removals%ROWTYPE; agent public.personal_agent_registry%ROWTYPE; candidate jsonb; digest text;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RETURN NULL; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 SELECT * INTO agent FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 SELECT * INTO op FROM public.personal_agent_cloud_removals WHERE user_id=owner_id AND attempt_id=attempt FOR UPDATE;
 IF op IS NULL OR op.completed_at IS NOT NULL OR op.cancelled_at IS NOT NULL OR agent.status IS DISTINCT FROM 'suspended'
 OR op.approved_digest IS NULL OR op.execution_started_at IS NULL
 OR agent.backend_metadata->'erasure'->>'attemptId' IS DISTINCT FROM attempt
 OR EXISTS(SELECT 1 FROM public.account_deletion_tombstones WHERE user_id_hash='sha256:'||encode(sha256(convert_to(owner_id,'UTF8')),'hex')) THEN RETURN NULL; END IF;
 IF op.recovery IS NULL THEN
  IF event IS NOT NULL OR expected_digest IS DISTINCT FROM op.snapshot_sha256 THEN RETURN NULL; END IF;
  candidate:=jsonb_build_object('version',1,'plan',plan,'planSha256',encode(sha256(convert_to(plan::text,'UTF8')),'hex'),'events','[]'::jsonb);
 ELSE
  digest:=encode(sha256(convert_to(op.recovery::text,'UTF8')),'hex');
  IF expected_digest IS DISTINCT FROM digest OR plan IS DISTINCT FROM op.recovery->'plan' OR event IS NULL THEN RETURN NULL; END IF;
  event:=event||jsonb_build_object('sequence',jsonb_array_length(op.recovery->'events'),'recordedAt',to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
  candidate:=jsonb_set(op.recovery,'{events}',op.recovery->'events'||jsonb_build_array(event));
 END IF;
 IF public.legacy_cloud_removal_append_valid(agent.backend_metadata->'erasure',op.recovery,candidate) IS NOT TRUE THEN RETURN NULL; END IF;
 IF event IS NOT NULL AND event->>'stage' IN ('intent','writer_intent','provider_dispatch') AND NOT EXISTS(
  SELECT 1 FROM jsonb_array_elements(op.recovery->'events') e WHERE e->>'stage'='approval'
   AND (e->>'recordedAt')::timestamptz>clock_timestamp()-interval '10 minutes') THEN RETURN NULL; END IF;
 UPDATE public.personal_agent_cloud_removals SET recovery=candidate WHERE user_id=owner_id AND attempt_id=attempt;
 RETURN candidate;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.legacy_cloud_removal_complete(owner_id text, attempt text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
DECLARE op public.personal_agent_cloud_removals%ROWTYPE; agent public.personal_agent_registry%ROWTYPE; item jsonb; latest jsonb;
BEGIN
 SELECT * INTO op FROM public.personal_agent_cloud_removals WHERE user_id=owner_id AND attempt_id=attempt;
 SELECT * INTO agent FROM public.personal_agent_registry WHERE user_id=owner_id;
 IF op.recovery IS NULL OR op.completed_at IS NOT NULL OR op.cancelled_at IS NOT NULL OR agent.status IS DISTINCT FROM 'suspended'
 OR agent.backend_metadata->'erasure'->>'attemptId' IS DISTINCT FROM attempt
 OR public.legacy_cloud_removal_plan_valid(agent.backend_metadata->'erasure',op.recovery->'plan') IS NOT TRUE
 OR EXISTS(SELECT 1 FROM public.personal_agent_standby_placements WHERE user_id=owner_id)
 OR EXISTS(SELECT 1 FROM public.pod_migration_jobs WHERE user_id=owner_id)
 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(op.recovery->'events') e WHERE e->>'stage'='approval') THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(op.recovery->'events') dispatched WHERE dispatched->>'stage'='provider_dispatch'
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(op.recovery->'events') ack WHERE ack->>'stage'='provider_ack'
   AND ack->'receipt'->>'requestId'=dispatched->'receipt'->>'requestId')) THEN RETURN false; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(op.recovery->'plan'->'resources') LOOP
  SELECT value INTO latest FROM jsonb_array_elements(op.recovery->'events') WITH ORDINALITY e(value,ord)
   WHERE value->>'resource'=(item->>'type')||':'||(item->>'id') AND value->>'stage'='observation' ORDER BY ord DESC LIMIT 1;
  IF latest IS NULL OR latest->'receipt'->>'status' NOT IN ('observed_absent','deleted','retained_shared') THEN RETURN false; END IF;
 END LOOP;
 SELECT value INTO latest FROM jsonb_array_elements(op.recovery->'events') WITH ORDINALITY e(value,ord)
  WHERE value->>'stage' IN ('executor_started','executor_exit') ORDER BY ord DESC LIMIT 1;
 RETURN coalesce(latest->>'stage'='executor_exit' AND latest->'receipt'->>'outcome'='returned'
  AND latest->'receipt'->'supervisorVerified'='true'::jsonb,false);
END;
$function$
;
CREATE OR REPLACE FUNCTION public.finalize_personal_agent_cloud_removal(owner_id text, attempt text, expected_digest text)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE agent public.personal_agent_registry%ROWTYPE; op public.personal_agent_cloud_removals%ROWTYPE;
 r jsonb; history jsonb; removed_at timestamptz; replacement public.personal_agent_registry%ROWTYPE;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,171));
 PERFORM pg_advisory_xact_lock(hashtextextended(owner_id,198));
 IF public.personal_agent_cloud_removal_ready() IS NOT TRUE THEN RETURN false; END IF;
 SELECT * INTO op FROM public.personal_agent_cloud_removals WHERE user_id=owner_id AND attempt_id=attempt FOR UPDATE;
 IF NOT FOUND OR expected_digest IS NULL THEN RETURN false; END IF;
 -- A lost response is recoverable only while its exact released identity is
 -- still current. A replacement never becomes "unplaced" through an old replay.
 IF op.completed_at IS NOT NULL THEN
  RETURN (expected_digest=op.approved_digest OR expected_digest=op.recovery->>'planSha256')
   AND public.personal_agent_cloud_removal_replay_current(owner_id,attempt);
 END IF;
 IF expected_digest IS DISTINCT FROM coalesce(op.recovery->>'planSha256',op.approved_digest) THEN RETURN false; END IF;
 IF (public.legacy_cloud_removal_complete(owner_id,attempt) IS NOT TRUE
 AND public.personal_agent_erasure_complete(owner_id) IS NOT TRUE)
 OR EXISTS(SELECT 1 FROM public.personal_agent_standby_placements WHERE user_id=owner_id) THEN RETURN false; END IF;
 SELECT * INTO agent FROM public.personal_agent_registry WHERE user_id=owner_id FOR UPDATE;
 r:=agent.backend_metadata->'erasure';
 IF r->>'attemptId' IS DISTINCT FROM attempt THEN RETURN false; END IF;
 SELECT authorization_attempts INTO history FROM public.byoc_setup_jobs WHERE user_id=owner_id FOR UPDATE;
 removed_at:=clock_timestamp();
 UPDATE public.personal_agent_cloud_removals SET completed_at=removed_at,
  archive=CASE WHEN op.recovery IS NULL THEN public.personal_agent_erasure_archive(r,history) ELSE public.legacy_cloud_removal_archive(r,history,op.recovery) END,
  released_identity=public.personal_agent_cloud_removal_identity(to_jsonb(agent),removed_at,attempt)
 WHERE user_id=owner_id AND attempt_id=attempt RETURNING * INTO op;
 IF public.personal_agent_erasure_archived(owner_id,r,history) IS NOT TRUE THEN
  RAISE EXCEPTION 'cloud removal archive unconfirmed' USING ERRCODE='42501'; END IF;
 DELETE FROM public.pod_lifecycle_events WHERE user_id=owner_id;
 DELETE FROM public.byoc_setup_jobs WHERE user_id=owner_id;
 DELETE FROM public.personal_agent_registry WHERE user_id=owner_id;
 replacement:=jsonb_populate_record(NULL::public.personal_agent_registry,op.released_identity);
 INSERT INTO public.personal_agent_registry SELECT replacement.*;
 RETURN true;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.legacy_cloud_removal_event_valid(recovery jsonb, event jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE p jsonb:=recovery->'plan'; item jsonb; prior jsonb; receipt jsonb:=event->'receipt'; key text:=event->>'resource'; stage text:=event->>'stage'; identity_hash text; active_source text; writer_key text; compute_key text;
BEGIN
 SELECT e->'receipt'->>'sourceRevision' INTO active_source
 FROM jsonb_array_elements(recovery->'events') WITH ORDINALITY x(e,ord)
 WHERE e->>'stage'='operator_source' ORDER BY ord DESC LIMIT 1;
 active_source:=coalesce(active_source,p->>'sourceRevision');
 writer_key:='service_account:'||(p->'runtime'->'principal'->>'email');
 compute_key:='cloud_run_service:'||regexp_replace(p->'runtime'->>'serviceName','^.*/','');
 IF jsonb_typeof(event) IS DISTINCT FROM 'object' OR event-ARRAY['sequence','resource','stage','receipt','recordedAt','executionId']<>'{}'::jsonb
 OR event->'sequence' IS DISTINCT FROM to_jsonb(jsonb_array_length(recovery->'events'))
 OR jsonb_typeof(receipt) IS DISTINCT FROM 'object' OR octet_length(receipt::text)>65536
 OR coalesce(stage,'') NOT IN ('approval','operator_source','executor_started','native_writer_disabled_after_compute','writer_intent','writer_acknowledgement','writer_disabled','intent','acknowledgement','provider_dispatch','provider_ack','checkpoint','observation','attention','executor_exit')
 OR coalesce(event->>'recordedAt','')='' THEN RETURN false; END IF;
 IF stage='approval' THEN
  RETURN key='$approval' AND receipt-ARRAY['planSha256','ownerId','confirmation'] = '{}'::jsonb
   AND receipt->>'planSha256'=recovery->>'planSha256' AND receipt->>'ownerId'=p->>'ownerId'
   AND receipt->>'confirmation'=p->'project'->>'projectId';
 END IF;
 -- Source adoption is restricted to the reconciled, pre-data IAM phase. A
 -- missing session, timeout or acknowledgement alone cannot qualify an exit.
 IF stage='operator_source' THEN
  RETURN key='$executor' AND event->>'executionId' IS NULL
   AND receipt-ARRAY['previousSourceRevision','sourceRevision','planSha256','actor']='{}'::jsonb
   AND receipt->>'previousSourceRevision'=active_source
   AND coalesce(receipt->>'sourceRevision','') ~ '^[0-9a-f]{40}$'
   AND receipt->>'sourceRevision'<>active_source
   AND receipt->>'planSha256'=recovery->>'planSha256' AND receipt->>'actor'=p->>'actor'
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') e WHERE e->>'stage'='approval'
    AND e->'receipt'->>'planSha256'=recovery->>'planSha256'
    AND (e->>'recordedAt')::timestamptz>clock_timestamp()-interval '10 minutes')
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') e WHERE e->>'stage'='intent')
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') started WHERE started->>'stage'='executor_started'
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') exited WHERE exited->>'stage'='executor_exit'
     AND exited->'receipt'->>'executionId'=started->'receipt'->>'executionId'))
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') dispatch WHERE dispatch->>'stage'='provider_dispatch'
    AND (dispatch->>'resource'<>writer_key OR NOT EXISTS(
     SELECT 1 FROM jsonb_array_elements(recovery->'events') ack WHERE ack->>'stage'='provider_ack'
      AND ack->'receipt'->>'requestId'=dispatch->'receipt'->>'requestId'
      AND ack->'receipt'->>'targetSha256'=dispatch->'receipt'->>'targetSha256'
      AND coalesce(ack->'receipt'->>'operationName','')=''
      AND (ack->'receipt'->>'httpStatus' ~ '^2[0-9]{2}$' OR ack->'receipt'->>'httpStatus' IN ('401','403','412','429')))))
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') grant_event
    WHERE grant_event->>'stage'='checkpoint' AND grant_event->'receipt'->>'stage'='temporaryGrant'
     AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') removed
      WHERE removed->>'resource'=grant_event->>'resource' AND removed->>'stage'='checkpoint'
       AND removed->'receipt'->>'stage'='temporaryGrantRemoved'
       AND (removed->>'sequence')::int>(grant_event->>'sequence')::int));
 END IF;
 IF stage='executor_started' THEN
  IF key<>'$executor' OR receipt-ARRAY['executionId','sourceRevision','databasePid','databaseStartedAt']<>'{}'::jsonb
  OR coalesce(receipt->>'executionId','') !~ '^[0-9a-f]{32}$'
  OR receipt->>'sourceRevision' IS DISTINCT FROM active_source
  OR receipt->'databasePid' IS DISTINCT FROM to_jsonb(pg_backend_pid()) THEN RETURN false; END IF;
  RETURN receipt->>'databaseStartedAt'=(SELECT backend_start::text FROM pg_stat_activity WHERE pid=pg_backend_pid())
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') started WHERE started->>'stage'='executor_started'
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') exited WHERE exited->>'stage'='executor_exit'
     AND exited->'receipt'->>'executionId'=started->'receipt'->>'executionId'));
 END IF;
 IF stage NOT IN ('approval','executor_exit') AND NOT EXISTS(
  SELECT 1 FROM jsonb_array_elements(recovery->'events') started
  WHERE started->>'stage'='executor_started' AND started->'receipt'->>'executionId'=event->>'executionId'
   AND started->'receipt'->>'sourceRevision'=active_source
   AND started->'receipt'->'databasePid'=to_jsonb(pg_backend_pid())
   AND started->'receipt'->>'databaseStartedAt'=(SELECT backend_start::text FROM pg_stat_activity WHERE pid=pg_backend_pid())
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') exited WHERE exited->>'stage'='executor_exit'
    AND exited->'receipt'->>'executionId'=event->>'executionId')) THEN RETURN false; END IF;
 IF stage='attention' THEN
  RETURN coalesce(receipt->>'code','') ~ '^[A-Z][A-Z0-9_]{0,63}$'
   AND receipt-ARRAY['code','uncertain'] = '{}'::jsonb AND jsonb_typeof(receipt->'uncertain')='boolean';
 END IF;
 IF stage='executor_exit' THEN
  RETURN key='$executor' AND receipt-ARRAY['executionId','sourceRevision','outcome','supervisorVerified','databasePid','databaseStartedAt','processExitCode'] = '{}'::jsonb
   AND coalesce(receipt->>'executionId','') ~ '^[0-9a-f]{32}$'
   AND coalesce(receipt->>'sourceRevision','') ~ '^[0-9a-f]{40}$' AND receipt->>'outcome' IN ('returned','failed','cancelled')
   AND receipt->'supervisorVerified'='true'::jsonb
   AND jsonb_typeof(receipt->'processExitCode')='number'
   AND (receipt->>'outcome'='returned')=(receipt->'processExitCode'='0'::jsonb)
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') started WHERE started->>'stage'='executor_started'
    AND started->'receipt'->>'executionId'=receipt->>'executionId'
    AND started->'receipt'->>'sourceRevision'=receipt->>'sourceRevision'
    AND started->'receipt'->'databasePid'=receipt->'databasePid'
    AND started->'receipt'->'databaseStartedAt'=receipt->'databaseStartedAt')
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') e WHERE e->>'stage'='executor_exit'
    AND e->'receipt'->>'executionId'=receipt->>'executionId')
   AND NOT EXISTS(SELECT 1 FROM pg_stat_activity a WHERE to_jsonb(a.pid)=receipt->'databasePid' AND a.backend_start::text=receipt->>'databaseStartedAt');
 END IF;
 SELECT value INTO item FROM jsonb_array_elements(p->'resources') WHERE (value->>'type')||':'||(value->>'id')=key;
 IF item IS NULL THEN RETURN false; END IF;
 identity_hash:=encode(sha256(convert_to((item->'identity')::text,'UTF8')),'hex');
 IF receipt->>'identitySha256' IS DISTINCT FROM identity_hash THEN RETURN false; END IF;
 IF stage='provider_dispatch' THEN
  RETURN item->>'authority'='owner_reviewed'
   AND receipt-ARRAY['identitySha256','requestId','targetSha256','method','purpose']='{}'::jsonb
   AND coalesce(receipt->>'purpose','mutation') IN ('mutation','credential_probe')
   AND (receipt->>'purpose' IS DISTINCT FROM 'credential_probe' OR item->>'type'='service_account' AND receipt->>'method'='POST')
   AND coalesce(receipt->>'requestId','') ~ '^[0-9a-f]{32}$'
   AND coalesce(receipt->>'targetSha256','') ~ '^[0-9a-f]{64}$'
   AND receipt->>'method' IN ('DELETE','POST','PATCH','PUT')
   AND (item->>'type'<>'reasoning_engine' OR EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') e
    WHERE e->>'resource'=key AND e->>'stage'='checkpoint' AND e->'receipt'->>'stage'='memoryBinding'
     AND e->'receipt'->'value' IS NOT DISTINCT FROM p->'memory'))
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') e WHERE e->>'resource'=key AND e->>'stage' IN ('intent','writer_intent'))
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') e WHERE e->>'resource'=key AND e->>'stage'='provider_dispatch'
    AND e->'receipt'->>'targetSha256'=receipt->>'targetSha256'
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') ack WHERE ack->>'stage'='provider_ack'
      AND ack->'receipt'->>'requestId'=e->'receipt'->>'requestId'
      AND (ack->'receipt'->>'httpStatus' IN ('401','403','412','429') OR receipt->>'purpose'='credential_probe')));
 END IF;
 IF stage='provider_ack' THEN
  RETURN receipt-ARRAY['identitySha256','requestId','targetSha256','httpStatus','bodySha256','operationName']='{}'::jsonb
   AND coalesce(receipt->>'httpStatus','') ~ '^[1-5][0-9]{2}$'
   AND coalesce(receipt->>'bodySha256','') ~ '^[0-9a-f]{64}$'
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') e WHERE e->>'resource'=key AND e->>'stage'='provider_dispatch'
    AND e->'receipt'->>'requestId'=receipt->>'requestId' AND e->'receipt'->>'targetSha256'=receipt->>'targetSha256')
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') e WHERE e->>'stage'='provider_ack' AND e->'receipt'->>'requestId'=receipt->>'requestId');
 END IF;
 IF stage='checkpoint' AND receipt->>'stage'='disabledWriterComputeAdmission' THEN
  RETURN key=writer_key AND receipt-ARRAY['identitySha256','stage','value']='{}'::jsonb
   AND (receipt->'value')-ARRAY['runtimeIdentity','status','nativeReadbackSha256']='{}'::jsonb
   AND receipt->'value'->'runtimeIdentity' IS NOT DISTINCT FROM p->'runtime'->'principal'
   AND receipt->'value'->>'status'='disabled'
   AND coalesce(receipt->'value'->>'nativeReadbackSha256','') ~ '^[0-9a-f]{64}$'
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') e WHERE e->>'resource'=key
    AND e->>'stage'='writer_acknowledgement' AND e->'receipt'->'httpStatus'='200'::jsonb)
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') dispatch WHERE dispatch->>'stage'='provider_dispatch'
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') ack WHERE ack->>'stage'='provider_ack'
     AND ack->'receipt'->>'requestId'=dispatch->'receipt'->>'requestId'));
 END IF;
 IF stage='native_writer_disabled_after_compute' THEN
  RETURN key=writer_key AND receipt-ARRAY['identitySha256','status','runtimeIdentity','bootstrapIdentity','computeReceiptSha256']='{}'::jsonb
   AND receipt->>'status'='disabled'
   AND receipt->'runtimeIdentity' IS NOT DISTINCT FROM p->'runtime'->'principal'
   AND receipt->'bootstrapIdentity' IS NOT DISTINCT FROM (SELECT r->'identity'->'account'
    FROM jsonb_array_elements(p->'resources') r WHERE r->>'type'='bootstrap_access')
   AND receipt->'runtimeIdentity'->>'uniqueId'<>receipt->'bootstrapIdentity'->>'uniqueId'
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') e WHERE e->>'resource'=key
    AND e->>'stage'='checkpoint' AND e->'receipt'->>'stage'='disabledWriterComputeAdmission'
    AND e->>'executionId'=event->>'executionId')
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') e WHERE e->>'resource'=compute_key
    AND e->>'stage'='observation' AND e->'receipt'->>'status'='deleted'
    AND e->'receipt'->'operationDone'='true'::jsonb
    AND e->'receipt'->'coverage'->'pendingOperations'='0'::jsonb
    AND e->'receipt'->'coverage'->'remainingRevisions'='0'::jsonb
    AND receipt->>'computeReceiptSha256'=encode(sha256(convert_to((e->'receipt')::text,'UTF8')),'hex'));
 END IF;
 IF stage='checkpoint' THEN
  RETURN item->>'type' IN ('gcs_bucket','kms_key','service_account','project_iam_policy','reasoning_engine')
   AND receipt-ARRAY['identitySha256','stage','value']='{}'::jsonb
   AND receipt->>'stage' IN ('bucketAdmission','bucketAcknowledgement','bucketDeletion','memoryBinding','inventory','admission','acknowledgement','destruction','completion','temporaryGrant','temporaryGrantRemoved')
   AND jsonb_typeof(receipt->'value')='object'
   AND (receipt->>'stage'<>'memoryBinding' OR (item->>'type'='reasoning_engine' AND receipt->'value' IS NOT DISTINCT FROM p->'memory'))
   AND (receipt->>'stage' NOT IN ('bucketAdmission','bucketAcknowledgement','bucketDeletion') OR
    (item->>'type'='gcs_bucket' AND receipt->'value'->'bucketIdentity' IS NOT DISTINCT FROM item->'identity'
     AND receipt->'value'->>'status'=CASE receipt->>'stage' WHEN 'bucketAdmission' THEN 'admitted' WHEN 'bucketAcknowledgement' THEN 'acknowledged' ELSE 'deleted' END
     AND coalesce(receipt->'value'->>'metageneration','') ~ '^[1-9][0-9]*$'))
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') e WHERE e->>'resource'=key AND e->>'stage' IN ('intent','writer_intent'));
 END IF;
 IF stage IN ('intent','writer_intent') THEN
  IF item->>'authority'<>'owner_reviewed' OR coalesce(receipt->>'requestId','') !~ '^[0-9a-f]{32}$'
  OR receipt-ARRAY['requestId','identitySha256','method']<>'{}'::jsonb
  OR receipt->>'method' NOT IN ('DELETE','POST','PATCH')
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') e WHERE e->>'resource'=key AND e->>'stage'=stage) THEN RETURN false; END IF;
  IF stage='writer_intent' THEN RETURN item->>'type'='service_account' AND item->>'id'=p->'runtime'->'principal'->>'email'; END IF;
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') e WHERE e->>'stage' IN ('writer_disabled','native_writer_disabled_after_compute'))
  AND NOT (item->>'type'='cloud_run_service' AND EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') e
   WHERE e->>'resource'=writer_key AND e->>'stage'='checkpoint' AND e->'receipt'->>'stage'='disabledWriterComputeAdmission'
    AND e->>'executionId'=event->>'executionId')) THEN RETURN false; END IF;
  IF item->>'type'<>'cloud_run_service' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') e
    WHERE e->>'resource'='cloud_run_service:'||regexp_replace(p->'runtime'->>'serviceName','^.*/','') AND e->>'stage'='observation' AND e->'receipt'->>'status'='deleted') THEN RETURN false; END IF;
  IF item->>'type' NOT IN ('cloud_run_service','reasoning_engine') AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') e
    WHERE e->>'resource'='reasoning_engine:'||(p->'memory'->>'engineName') AND e->>'stage'='observation' AND e->'receipt'->>'status' IN ('deleted','observed_absent')) THEN RETURN false; END IF;
  IF item->>'type'='bootstrap_access' THEN
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(p->'resources') candidate WHERE candidate->>'type'<>'bootstrap_access'
    AND coalesce((SELECT e->'receipt'->>'status' FROM jsonb_array_elements(recovery->'events') WITH ORDINALITY x(e,ord)
     WHERE e->>'resource'=(candidate->>'type')||':'||(candidate->>'id') AND e->>'stage'='observation' ORDER BY ord DESC LIMIT 1),'')
     NOT IN ('deleted','observed_absent','retained_shared')) THEN RETURN false; END IF;
   RETURN public.project_grant_release_is_exclusive(p->>'ownerId',p->'project'->>'projectId') IS TRUE;
  END IF;
  IF item->>'type'='project_iam_policy' THEN
   RETURN public.project_grant_release_is_exclusive(p->>'ownerId',p->'project'->>'projectId') IS TRUE;
  END IF;
  RETURN true;
 END IF;
 SELECT value INTO prior FROM jsonb_array_elements(recovery->'events') e WHERE e->>'resource'=key
  AND e->>'stage'=CASE WHEN stage IN ('writer_acknowledgement','writer_disabled') THEN 'writer_intent' ELSE 'intent' END;
 IF stage IN ('acknowledgement','writer_acknowledgement') THEN
  RETURN prior IS NOT NULL AND receipt-ARRAY['requestId','identitySha256','httpStatus','operationName'] = '{}'::jsonb
   AND receipt->>'requestId'=prior->'receipt'->>'requestId' AND coalesce(receipt->>'httpStatus','') ~ '^2[0-9]{2}$'
   AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') e WHERE e->>'resource'=key AND e->>'stage'=stage);
 END IF;
 IF stage='writer_disabled' THEN
  RETURN prior IS NOT NULL AND item->>'id'=p->'runtime'->'principal'->>'email'
   AND receipt-ARRAY['identitySha256','status','nativeReadbackSha256','credentialDenied'] = '{}'::jsonb
   AND receipt->>'status'='disabled' AND receipt->'credentialDenied'='true'::jsonb
   AND coalesce(receipt->>'nativeReadbackSha256','') ~ '^[0-9a-f]{64}$';
 END IF;
 IF stage='observation' THEN
  IF receipt-ARRAY['identitySha256','status','httpStatus','nativeReadbackSha256','operationName','operationDone','coverage']<>'{}'::jsonb
  OR coalesce(receipt->>'nativeReadbackSha256','') !~ '^[0-9a-f]{64}$'
  OR coalesce(receipt->>'status','') NOT IN ('observed_absent','deleted','retained_shared','waiting_for_provider') THEN RETURN false; END IF;
  IF receipt->>'status'='observed_absent' THEN RETURN item->>'type'<>'gcs_bucket' AND receipt->'httpStatus'='404'::jsonb AND prior IS NULL; END IF;
  IF receipt->>'status'='retained_shared' THEN RETURN item->>'authority'='retain_shared' AND item->>'type'='artifact_repository' AND receipt->'httpStatus'='200'::jsonb AND prior IS NULL; END IF;
  IF receipt->>'status'='waiting_for_provider' THEN RETURN prior IS NOT NULL; END IF;
  IF item->>'type' IN ('project_iam_policy','bootstrap_access') AND receipt->>'status'='deleted' THEN
   RETURN prior IS NOT NULL AND receipt->'httpStatus'='200'::jsonb
    AND receipt->'coverage'->'bindingsAbsent'='true'::jsonb;
  END IF;
  IF item->>'type'='kms_key' AND receipt->>'status'='deleted' THEN
   RETURN prior IS NOT NULL AND receipt->'httpStatus'='200'::jsonb
    AND receipt->'coverage'->'allVersionsDestroyed'='true'::jsonb
    AND EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') e WHERE e->>'resource'=key
     AND e->>'stage'='checkpoint' AND e->'receipt'->>'stage'='completion');
  END IF;
  IF item->>'type'='gcs_bucket' AND receipt->>'status'='deleted' AND NOT EXISTS(
   SELECT 1 FROM jsonb_array_elements(recovery->'events') e WHERE e->>'resource'=key
    AND e->>'stage'='checkpoint' AND e->'receipt'->>'stage'='bucketDeletion'
    AND e->'receipt'->'value'->>'status'='deleted'
    AND e->'receipt'->'value'->'bucketIdentity' IS NOT DISTINCT FROM item->'identity') THEN RETURN false; END IF;
  IF prior IS NULL OR receipt->'httpStatus'<>'404'::jsonb THEN RETURN false; END IF;
  IF item->>'type' IN ('cloud_run_service','reasoning_engine') THEN
   IF item->>'type'='reasoning_engine' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') e
    WHERE e->>'resource'=key AND e->>'stage'='checkpoint' AND e->'receipt'->>'stage'='memoryBinding'
     AND e->'receipt'->'value' IS NOT DISTINCT FROM p->'memory') THEN RETURN false; END IF;
   IF receipt->'operationDone' IS DISTINCT FROM 'true'::jsonb OR coalesce(receipt->>'operationName','')=''
   OR receipt->'coverage'->'complete' IS DISTINCT FROM 'true'::jsonb
   OR receipt->'coverage'->'pendingOperations' IS DISTINCT FROM '0'::jsonb THEN RETURN false; END IF;
   IF item->>'type'='cloud_run_service' AND receipt->'coverage'->'remainingRevisions' IS DISTINCT FROM '0'::jsonb THEN RETURN false; END IF;
  END IF;
  RETURN EXISTS(SELECT 1 FROM jsonb_array_elements(recovery->'events') e WHERE e->>'resource'=key AND e->>'stage'='acknowledgement'
   AND e->'receipt'->'operationName' IS NOT DISTINCT FROM receipt->'operationName');
 END IF;
 RETURN false;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.assert_project_grant_admission(project_id text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
 IF project_id IS NULL OR project_id='' THEN RETURN; END IF;
 IF (project_id !~ '^[a-z][a-z0-9-]{4,61}[a-z0-9]$'
     AND project_id !~ '^/subscriptions/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/resourceGroups/[A-Za-z0-9_().-]{0,89}[A-Za-z0-9_()-]$')
 OR current_setting('transaction_isolation') <> 'read committed' THEN
  RAISE EXCEPTION 'project grant admission unavailable' USING ERRCODE='42501'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(project_id,205));
 IF EXISTS (SELECT 1 FROM public.personal_agent_registry r WHERE r.backend_metadata->'erasure'->'grantRelease'->>'project'=project_id)
 OR EXISTS(SELECT 1 FROM public.personal_agent_cloud_removals c WHERE c.completed_at IS NULL AND c.cancelled_at IS NULL
  AND c.recovery->'plan'->'project'->>'projectId'=project_id
  AND EXISTS(SELECT 1 FROM jsonb_array_elements(c.recovery->'events') e
   WHERE e->>'resource' IN (SELECT (x->>'type')||':'||(x->>'id') FROM jsonb_array_elements(c.recovery->'plan'->'resources') x WHERE x->>'type' IN ('bootstrap_access','project_iam_policy')) AND e->>'stage'='intent')) THEN
  RAISE EXCEPTION 'project grant release reserved' USING ERRCODE='42501'; END IF;
END;
$function$
;
DROP FUNCTION public.account_cloud_retirement_local_erasure_ready(text);
DROP FUNCTION public.account_cloud_retirement_transition_valid(jsonb,jsonb);
DROP FUNCTION public.account_cloud_retirement_retained(text);
DROP FUNCTION public.retain_account_cloud_retirement(text,uuid,text);
DROP FUNCTION public.account_cloud_retirement_handoff_valid(text,jsonb);
DROP FUNCTION public.account_cloud_retirement_ready(text,text);
DROP FUNCTION public.account_cloud_retirement_quiescent(text,text);
DROP FUNCTION public.account_cloud_retirement_reservation(text,text);
DROP FUNCTION public.account_cloud_retirement_contract_version();
ALTER TABLE public.personal_agent_cloud_removals DROP CONSTRAINT cloud_removal_retired_completion,
 ADD CONSTRAINT personal_agent_cloud_removals_check2 CHECK ((completed_at IS NULL)=(released_identity IS NULL));
ALTER TABLE public.personal_agent_cloud_removals DROP COLUMN retirement_handoff;
COMMIT;
