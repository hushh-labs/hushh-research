-- SPDX-License-Identifier: Apache-2.0
-- SPDX-FileCopyrightText: 2026 Hushh
BEGIN;

LOCK TABLE public.personal_agent_registry IN SHARE ROW EXCLUSIVE MODE;

DO $rollback$
DECLARE
  unresolved_count bigint;
BEGIN
  SELECT count(*)
    INTO unresolved_count
    FROM public.personal_agent_registry AS registry
   WHERE NULLIF(COALESCE(registry.backend_metadata, '{}'::jsonb)->>'upgradeLease', '') IS NOT NULL
      OR COALESCE(registry.backend_metadata, '{}'::jsonb) ? 'upgradeLeaseHost';

  IF unresolved_count > 0 THEN
    RAISE EXCEPTION
      'rollback 980 requires all provider upgrade leases to be settled and cleared; found % unresolved registry rows',
      unresolved_count
      USING ERRCODE = '55000';
  END IF;
END;
$rollback$;

DROP TRIGGER IF EXISTS zz_personal_agent_upgrade_lease_host_binding
  ON public.personal_agent_registry;
DROP FUNCTION IF EXISTS public.guard_personal_agent_upgrade_lease_host_binding();
DROP FUNCTION IF EXISTS public.personal_agent_upgrade_lease_host_binding(jsonb);

-- Restore migration 968's exact validator body, which 980 extended only to
-- recognize removal of its newly introduced upgradeLeaseHost snapshot.
CREATE OR REPLACE FUNCTION public.azure_vm_image_publication_proven(
 prior public.personal_agent_registry, incoming public.personal_agent_registry
) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=public AS $$
DECLARE old_m jsonb:=prior.backend_metadata; new_m jsonb:=incoming.backend_metadata;
 approval jsonb:=old_m->'upgradeApproval'; ack jsonb:=old_m->'upgradeAcknowledgement';
 proof jsonb:=new_m->'vmUpdateVerification'; host_ack jsonb:=proof->'host';
 recovery jsonb:=proof->'recovery'; released jsonb:=proof->'released';
 job public.byoc_setup_jobs; intent jsonb; intents jsonb; target text; digest_value text;
 mutable text[]:=ARRAY['image','image_digest','vmHost','vmConfigurationSha256','vmPower',
  'upgradeLease','vmUpdateVerification','upgradeAcknowledgement','upgradeApproval',
  'installedRelease','source_image','previous_image','upgraded','observed','imageSetByRevision','upgrade'];
BEGIN
 SELECT * INTO job FROM public.byoc_setup_jobs WHERE user_id=prior.user_id;
 IF job IS NULL OR jsonb_typeof(job.stages) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
 SELECT jsonb_agg(e->'intent') INTO intents FROM jsonb_array_elements(job.stages) e
 WHERE e->>'stage' IN ('azure_setup_intent','azure_setup_prior_intent')
  AND e->'intent'->'version'='3'::jsonb
  AND e->'intent'->>'operationId'=approval->>'operationId';
 IF jsonb_array_length(intents) IS DISTINCT FROM 1 THEN RETURN false; END IF;
 intent:=intents->0;
 digest_value:=right(intent->>'sourceImage',71);
 target:=split_part(old_m->>'image','@',1)||'@'||digest_value;
 IF prior.status IS DISTINCT FROM 'provisioned' OR prior.backend IS DISTINCT FROM 'user_azure'
 OR prior.deployment_target IS DISTINCT FROM 'user_azure' OR old_m->>'hostKind' IS DISTINCT FROM 'azure_vm'
 OR old_m ? 'erasure' OR new_m ?| ARRAY['erasure','upgradeLease','vmPower']
 OR public.azure_vm_power_pending(old_m) IS TRUE
 OR (old_m ? 'vmPower' AND old_m->'vmPower'->'binding' IS DISTINCT FROM public.azure_vm_power_binding(to_jsonb(prior)))
 OR (to_jsonb(prior)-ARRAY['backend_metadata','updated_at']) IS DISTINCT FROM
    (to_jsonb(incoming)-ARRAY['backend_metadata','updated_at'])
 OR old_m-mutable IS DISTINCT FROM new_m-mutable
 OR intent->'binding' IS DISTINCT FROM public.azure_vm_upgrade_registry_binding(to_jsonb(prior))
 OR public.valid_byoc_azure_vm_upgrade_intent(prior.user_id,intent->>'jobId',job.project_id,prior.hushh_id,intent) IS NOT TRUE
 OR intent->>'attemptId' IS DISTINCT FROM encode(sha256(convert_to(old_m->>'upgradeLease','UTF8')),'hex')
 OR intent->>'sourceImage' IS DISTINCT FROM approval->>'targetImage'
 OR EXISTS(SELECT 1 FROM unnest(ARRAY['operationId','releaseId','idempotencyKey']) k
    WHERE intent->k IS DISTINCT FROM approval->k)
 OR approval->>'ownerId' IS DISTINCT FROM prior.user_id OR approval->>'hushhId' IS DISTINCT FROM prior.hushh_id
 OR approval->>'podIncarnation' IS DISTINCT FROM old_m->>'serviceUid'
 OR approval->'version' IS DISTINCT FROM '1'::jsonb
 OR coalesce(approval->'capabilityPlanDigest','null'::jsonb)<>'null'::jsonb
 OR (approval->>'status' IN ('approved','scheduled','updating','blocked')) IS NOT TRUE
 OR (new_m->'upgradeApproval')-ARRAY['status','operationState','presentationPhase','verifiedAt']
    IS DISTINCT FROM approval-ARRAY['status','operationState','presentationPhase','verifiedAt']
 OR new_m->'upgradeApproval'->>'status' IS DISTINCT FROM 'succeeded'
 OR new_m->'upgradeApproval'->>'operationState' IS DISTINCT FROM 'succeeded'
 OR new_m->'upgradeApproval'->>'presentationPhase' IS DISTINCT FROM 'verified'
 OR new_m->>'source_image' IS DISTINCT FROM intent->>'sourceImage'
 OR new_m->>'image' IS DISTINCT FROM target OR new_m->>'image_digest' IS DISTINCT FROM digest_value
 OR new_m->>'previous_image' IS DISTINCT FROM old_m->>'image'
 OR new_m->'vmHost' IS DISTINCT FROM jsonb_set(old_m->'vmHost','{installation,image_digest}',to_jsonb(digest_value))
 OR proof-ARRAY['operationId','attemptId','host','recovery','released','previousPower']<>'{}'::jsonb
 OR proof->'previousPower' IS DISTINCT FROM old_m->'vmPower'
 OR proof->'operationId' IS DISTINCT FROM intent->'operationId'
 OR proof->'attemptId' IS DISTINCT FROM intent->'attemptId'
 OR ack->'vmHostAck' IS DISTINCT FROM host_ack
 OR new_m->'upgradeAcknowledgement' IS DISTINCT FROM (ack||jsonb_build_object('outcome','ready'))
 OR ack->'attemptId' IS DISTINCT FROM intent->'attemptId'
 OR ack->'operationId' IS DISTINCT FROM intent->'operationId'
 OR ack->'releaseId' IS DISTINCT FROM intent->'releaseId'
 OR ack->>'externalAgentId' IS DISTINCT FROM prior.external_agent_id
 OR ack->>'service' IS DISTINCT FROM prior.external_agent_id
 OR ack->'serviceUid' IS DISTINCT FROM old_m->'serviceUid'
 OR ack->>'hostKind' IS DISTINCT FROM 'azure_vm' OR ack->'version' IS DISTINCT FROM '1'::jsonb
 OR ack->>'image' IS DISTINCT FROM target OR ack->>'targetImage' IS DISTINCT FROM intent->>'sourceImage'
 OR approval->'handoffIdleRecord' IS DISTINCT FROM intent->'idleRecord'
 OR public.valid_pod_upgrade_cursor(approval->'handoffCommittedCursor') IS NOT TRUE
 OR ack->'idleReceipt'->'operationId' IS DISTINCT FROM intent->'operationId'
 OR ack->'idleReceipt'->'incarnation' IS DISTINCT FROM old_m->'serviceUid'
 OR ack->'idleReceipt'->'runtimeEpoch' IS DISTINCT FROM approval->'handoffRuntimeEpoch'
 OR ack->'idleReceipt'->'activeWork' IS DISTINCT FROM '0'::jsonb
 OR ack->'idleReceipt'->'committedCursor' IS DISTINCT FROM approval->'handoffCommittedCursor'
 OR ack->'idleReceipt'->'committedState' IS DISTINCT FROM approval->'handoffCommittedState'
 OR ack->'idleReceipt'->'idleRecord' IS DISTINCT FROM intent->'idleRecord'
 OR (intent->'idleRecord'->>'seq')::numeric<=(approval->'handoffCommittedCursor'->>'seq')::numeric
 OR approval->>'handoffCommittedState' IS DISTINCT FROM encode(sha256(convert_to(
    (intent->>'operationId')||'|'||(old_m->>'serviceUid')||'|'||
    (approval->'handoffCommittedCursor'->>'seq')||'|'||
    (approval->'handoffCommittedCursor'->>'sha')||'|active=0','UTF8')),'hex')
 OR host_ack-ARRAY['version','operation_id','request_sha256','configuration_sha256','image','stage','application_verified']<>'{}'::jsonb
 OR host_ack->'version' IS DISTINCT FROM '1'::jsonb
 OR host_ack->'operation_id' IS DISTINCT FROM intent->'operationId'
 OR host_ack->'request_sha256' IS DISTINCT FROM intent->'hostRequestSha256'
 OR host_ack->>'image' IS DISTINCT FROM target OR host_ack->>'stage' IS DISTINCT FROM 'restart_requested'
 OR host_ack->'application_verified' IS DISTINCT FROM 'false'::jsonb
 OR host_ack->'configuration_sha256' IS DISTINCT FROM new_m->'vmConfigurationSha256'
 OR (new_m->>'vmConfigurationSha256' ~ '^[a-f0-9]{64}$') IS NOT TRUE
 OR new_m->'vmConfigurationSha256' IS NOT DISTINCT FROM old_m->'vmConfigurationSha256'
 OR recovery->>'kind' IS DISTINCT FROM 'recovery'
 OR recovery->'incarnation' IS DISTINCT FROM old_m->'serviceUid'
 OR recovery->>'podKeyId' IS DISTINCT FROM prior.pod_key_id
 OR recovery->>'imageDigest' IS DISTINCT FROM digest_value
 OR (recovery->>'runtimeEpoch' ~ '^[A-Za-z0-9_-]+$') IS NOT TRUE
 OR length(recovery->>'runtimeEpoch')>256
 OR recovery->'runtimeEpoch' IS NOT DISTINCT FROM approval->'handoffRuntimeEpoch'
 OR recovery->'retainedIdleRecord' IS DISTINCT FROM intent->'idleRecord'
 OR released->>'kind' IS DISTINCT FROM 'released'
 OR released->'operationId' IS DISTINCT FROM intent->'operationId'
 OR released->'incarnation' IS DISTINCT FROM recovery->'incarnation'
 OR released->'runtimeEpoch' IS DISTINCT FROM recovery->'runtimeEpoch'
 OR public.valid_pod_upgrade_cursor(released->'releaseRecord') IS NOT TRUE
 OR (released->'releaseRecord'->>'seq')::numeric<=(intent->'idleRecord'->>'seq')::numeric
 OR public.azure_vm_upgrade_dispatch_settled(intent,job.stages) IS NOT TRUE
 THEN RETURN false; END IF;
 RETURN true;
END;
$$;

COMMIT;
