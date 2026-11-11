-- SPDX-License-Identifier: Apache-2.0
-- SPDX-FileCopyrightText: 2026 Hushh
-- Dev-only: mixed hub versions may not claim or publish another pod's lease.
BEGIN;

LOCK TABLE public.personal_agent_registry IN SHARE ROW EXCLUSIVE MODE;

DO $migration$
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
      'migration 980 requires all provider upgrade leases to be settled and cleared; found % unresolved registry rows',
      unresolved_count
      USING ERRCODE = '55000';
  END IF;
END;
$migration$;

-- Mirror the Python lease binding from the row visible to the trigger. This
-- makes a copied or malformed JSON snapshot unusable as host authority.
CREATE OR REPLACE FUNCTION public.personal_agent_upgrade_lease_host_binding(agent jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object(
    'registry', jsonb_build_object(
      'user_id', agent->'user_id',
      'hushh_id', agent->'hushh_id',
      'backend', agent->'backend',
      'external_agent_id', agent->'external_agent_id',
      'a2a_route', agent->'a2a_route',
      'billing_space_id', agent->'billing_space_id',
      'phone_e164_hash', agent->'phone_e164_hash',
      'deployment_target', agent->'deployment_target',
      'user_cloud_project', agent->'user_cloud_project',
      'user_cloud_tenant_id', agent->'user_cloud_tenant_id',
      'user_cloud_subscription_id', agent->'user_cloud_subscription_id',
      'user_cloud_resource_group', agent->'user_cloud_resource_group',
      'user_cloud_region', agent->'user_cloud_region',
      'user_cloud_bootstrap_sa', agent->'user_cloud_bootstrap_sa',
      'placement_epoch', agent->'placement_epoch',
      'pod_pubkey', agent->'pod_pubkey',
      'pod_key_id', agent->'pod_key_id',
      'pod_signing_key_id', agent->'pod_signing_key_id',
      'pod_signing_pubkey', agent->'pod_signing_pubkey'
    ),
    'hostMetadata', jsonb_build_object(
      'project', agent->'backend_metadata'->'project',
      'region', agent->'backend_metadata'->'region',
      'service', agent->'backend_metadata'->'service',
      'serviceUid', agent->'backend_metadata'->'serviceUid',
      'url', agent->'backend_metadata'->'url',
      'runtime_service_account', agent->'backend_metadata'->'runtime_service_account',
      'tenancy', agent->'backend_metadata'->'tenancy',
      'ingress', agent->'backend_metadata'->'ingress',
      'hostKind', agent->'backend_metadata'->'hostKind',
      'vmHost', agent->'backend_metadata'->'vmHost',
      'vmConfigurationSha256', agent->'backend_metadata'->'vmConfigurationSha256',
      'vmUpdateModuleSha256', agent->'backend_metadata'->'vmUpdateModuleSha256',
      'runtime_principal_id', agent->'backend_metadata'->'runtime_principal_id',
      'runtime_client_id', agent->'backend_metadata'->'runtime_client_id'
    ),
    'userCloudAuthorizedAt', CASE
      WHEN agent->>'user_cloud_authorized_at' IS NULL THEN NULL
      ELSE to_jsonb(
        to_char(
          (agent->>'user_cloud_authorized_at')::timestamptz AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US'
        ) || '+00:00'
      )
    END
  );
$function$;

-- Migration 968 predates the exact host snapshot introduced here. Preserve its
-- publication proof verbatim, with only the new snapshot key admitted as a
-- field that must disappear when the already-proven lease is cleared.
CREATE OR REPLACE FUNCTION public.azure_vm_image_publication_proven(
 prior public.personal_agent_registry, incoming public.personal_agent_registry
) RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=public AS $$
DECLARE old_m jsonb:=prior.backend_metadata; new_m jsonb:=incoming.backend_metadata;
 approval jsonb:=old_m->'upgradeApproval'; ack jsonb:=old_m->'upgradeAcknowledgement';
 proof jsonb:=new_m->'vmUpdateVerification'; host_ack jsonb:=proof->'host';
 recovery jsonb:=proof->'recovery'; released jsonb:=proof->'released';
 job public.byoc_setup_jobs; intent jsonb; intents jsonb; target text; digest_value text;
 mutable text[]:=ARRAY['image','image_digest','vmHost','vmConfigurationSha256','vmPower',
  'upgradeLease','upgradeLeaseHost','vmUpdateVerification','upgradeAcknowledgement','upgradeApproval',
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
 OR old_m ? 'erasure' OR new_m ?| ARRAY['erasure','upgradeLease','upgradeLeaseHost','vmPower']
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

CREATE OR REPLACE FUNCTION public.guard_personal_agent_upgrade_lease_host_binding()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  old_metadata jsonb;
  new_metadata jsonb := COALESCE(NEW.backend_metadata, '{}'::jsonb);
  old_lease text;
  new_lease text;
  old_host jsonb;
  new_host jsonb;
  old_binding jsonb;
  new_binding jsonb := public.personal_agent_upgrade_lease_host_binding(to_jsonb(NEW));
  lease_host_authority text;
BEGIN
  new_lease := NULLIF(new_metadata->>'upgradeLease', '');
  new_host := new_metadata->'upgradeLeaseHost';

  IF TG_OP = 'INSERT' THEN
    IF new_lease IS NULL AND new_host IS NULL THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'host-bound personal-agent upgrade lease authority is required'
      USING ERRCODE = '42501';
  END IF;

  old_metadata := COALESCE(OLD.backend_metadata, '{}'::jsonb);
  old_lease := NULLIF(old_metadata->>'upgradeLease', '');
  old_host := old_metadata->'upgradeLeaseHost';
  old_binding := public.personal_agent_upgrade_lease_host_binding(to_jsonb(OLD));

  IF old_metadata->'upgradeLease' IS NOT DISTINCT FROM new_metadata->'upgradeLease'
     AND old_host IS NOT DISTINCT FROM new_host
     AND OLD.model_credential_mode IS NOT DISTINCT FROM NEW.model_credential_mode
     AND old_binding IS NOT DISTINCT FROM new_binding THEN
    RETURN NEW;
  END IF;

  IF old_lease IS NULL AND new_lease IS NULL AND old_host IS NULL AND new_host IS NULL THEN
    RETURN NEW;
  END IF;

  IF old_lease IS NULL AND old_host IS NULL AND new_lease IS NOT NULL
     AND new_host IS NOT NULL
     AND old_binding IS NOT DISTINCT FROM new_binding
     AND new_host IS NOT DISTINCT FROM new_binding THEN
    lease_host_authority := current_setting('hushh.upgrade_lease_host_binding', true);
    IF lease_host_authority = format('%s|%s', new_lease, new_host::text) THEN
      RETURN NEW;
    END IF;
  ELSIF old_lease IS NOT NULL
        AND old_host IS NOT NULL
        AND old_host IS NOT DISTINCT FROM old_binding
        AND (
          old_binding IS NOT DISTINCT FROM new_binding
          OR (
            new_lease IS NULL
            AND new_host IS NULL
            AND public.azure_vm_image_publication_proven(OLD, NEW) IS TRUE
          )
        )
        AND (new_lease IS NULL OR new_lease = old_lease)
        AND (new_lease IS NULL OR new_host IS NOT DISTINCT FROM old_host)
        AND (new_lease IS NOT NULL OR new_host IS NULL) THEN
    lease_host_authority := current_setting('hushh.upgrade_lease_host_binding', true);
    IF lease_host_authority = format('%s|%s', old_lease, old_host::text) THEN
      RETURN NEW;
    END IF;
  END IF;

  RAISE EXCEPTION 'host-bound personal-agent upgrade lease authority is required'
    USING ERRCODE = '42501';
END;
$function$;

DROP TRIGGER IF EXISTS zz_personal_agent_upgrade_lease_host_binding
  ON public.personal_agent_registry;
CREATE TRIGGER zz_personal_agent_upgrade_lease_host_binding
BEFORE INSERT OR UPDATE ON public.personal_agent_registry
FOR EACH ROW
EXECUTE FUNCTION public.guard_personal_agent_upgrade_lease_host_binding();

COMMIT;
