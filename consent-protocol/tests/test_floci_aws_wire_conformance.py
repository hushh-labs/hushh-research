# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Real `boto3` HTTP/SigV4 wire conformance for S3 CAS + AWS KMS custody via Floci.

Exercises unmocked `S3ObjectStore`, `PodCommitLog`, and `AwsKmsCustodyAdapter` clients
over real loopback TCP sockets (`floci` native binary when installed, or the built-in
AWS S3 XML + KMS `AWSJson1_1` wire reference server), plus fail-closed refusal of
emulator endpoints in UAT/production and non-loopback HTTP.
"""

from __future__ import annotations

import json
from typing import Any

import boto3  # type: ignore[import-not-found]
import pytest

from hushh_mcp.services.aws_setup_plan import (
    BINDING_TAG,
    OBSERVER_POLICY_NAME,
    POD_RUNTIME_POLICY_NAME,
    REMOVAL_POLICY_NAME,
    AwsFlociGateRefused,
    AwsPlanInputs,
    aws_owner_tags,
    aws_resource_names,
    evaluate_aws_readiness,
    hussh_observer_policy_document,
    hussh_removal_policy_document,
    pod_runtime_policy_document,
    render_cloudformation_template,
)
from hushh_mcp.services.byoc_key_custody import ByocKeyCustodyError
from hushh_mcp.services.compute_backend import (
    BACKEND_USER_AWS,
    ComputeBackend,
    OwnerAccessCheckpointBackend,
    OwnerAccessErasableBackend,
    PodSpec,
    RestartableBackend,
    adoption_expectations,
)
from hushh_mcp.services.pod_commit_log import PodCommitLog
from hushh_mcp.services.pod_crypto_erase import ERASURE_TOMBSTONE_OBJECT
from hushh_mcp.services.pod_custody_port import (
    AWS_KMS_KEY_ENV,
    CUSTODY_MODE_ENV,
    CUSTODY_OWNER_KMS,
    AwsKmsCustodyAdapter,
    resolve_key_custody_port,
)
from hushh_mcp.services.pod_object_version import ABSENT
from hushh_mcp.services.pod_s3_object_store import (
    FLOCI_ENDPOINT_URL_ENV,
    S3_URI_ENV,
    PodMultiCloudStorageError,
    PodMultiCloudStorageForbidden,
    S3ObjectStore,
    resolve_aws_boto3_client_kwargs,
)
from hushh_mcp.services.pod_storage import resolve_pod_object_store
from hushh_mcp.services.provider_capability_registry import PROVIDER_CAPABILITY_REGISTRY
from hushh_mcp.services.user_aws_backend import (
    AwsAgentUnreadable,
    AwsDeleteAuthorityRefused,
    UserAwsBackend,
)
from tests.floci_wire_harness import floci_aws_wire_environment


@pytest.mark.asyncio
async def test_floci_wire_s3_object_store_and_commit_log_cas_over_real_boto3(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with floci_aws_wire_environment() as env:
        monkeypatch.setenv(FLOCI_ENDPOINT_URL_ENV, env.endpoint_url)
        monkeypatch.setenv("ENVIRONMENT", "test")
        monkeypatch.setenv("POD_STORAGE_BACKEND", "commit_log")
        monkeypatch.setenv(S3_URI_ENV, "s3://hushh-floci-pod-bkt/pods/owner-alpha")
        for other_env in (
            "POD_STORAGE_LOCAL_ROOT",
            "POD_STORAGE_GCS_BUCKET",
            "POD_STORAGE_AZURE_BLOB_URL",
            "POD_STORAGE_PREFIX_TOKEN_URL",
        ):
            monkeypatch.delenv(other_env, raising=False)
        monkeypatch.delenv("AWS_ACCESS_KEY_ID", raising=False)
        monkeypatch.delenv("AWS_SECRET_ACCESS_KEY", raising=False)

        bootstrap_s3 = boto3.client("s3", **resolve_aws_boto3_client_kwargs("s3"))
        bootstrap_s3.create_bucket(Bucket="hushh-floci-pod-bkt")

        # Unmocked S3ObjectStore resolved strictly from env -> real boto3 HTTP socket!
        store = resolve_pod_object_store()
        assert isinstance(store, S3ObjectStore)

        payload_0, ver_0 = await store.get_with_generation("state/marker.bin")
        assert payload_0 is None and ver_0 is ABSENT

        ver_1 = await store.put_if_generation("state/marker.bin", b"epoch-1", ABSENT)
        assert ver_1 is not None
        # Stale ABSENT loses conditional If-None-Match: * over the HTTP wire (412 -> None).
        assert await store.put_if_generation("state/marker.bin", b"epoch-race", ABSENT) is None

        ver_2 = await store.put_if_generation("state/marker.bin", b"epoch-2", ver_1)
        assert ver_2 is not None and ver_2 != ver_1
        # Stale ETag loses conditional If-Match over the HTTP wire (412 -> None).
        assert await store.put_if_generation("state/marker.bin", b"epoch-stale", ver_1) is None

        read_back, read_ver = await store.get_with_generation("state/marker.bin")
        assert read_back == b"epoch-2" and read_ver == ver_2

        # Full PodCommitLog pointer advance over real boto3 HTTP S3 CAS.
        log = PodCommitLog(store, b"\x42" * 32, owner_id="owner-alpha")
        await log.append("note", {"rev": 1})
        await log.append("note", {"rev": 2})
        replayed = await log.replay()
        assert [r["payload"]["rev"] for r in replayed] == [1, 2]

        # Bucket IAM revocation surfaces as PodMultiCloudStorageForbidden (never absence).
        if env.mode == "loopback_wire_reference":
            env.set_bucket_forbidden("hushh-floci-pod-bkt", forbidden=True)
            with pytest.raises(PodMultiCloudStorageForbidden):
                await store.get_with_generation("state/marker.bin")


def test_floci_wire_aws_kms_custody_aad_binding_and_tombstone_over_real_boto3(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with floci_aws_wire_environment() as env:
        monkeypatch.setenv(FLOCI_ENDPOINT_URL_ENV, env.endpoint_url)
        monkeypatch.setenv("ENVIRONMENT", "test")
        monkeypatch.setenv("POD_STORAGE_BACKEND", "commit_log")
        monkeypatch.setenv(S3_URI_ENV, "s3://hushh-floci-kms-bkt/pods/owner-kms")
        for other_env in (
            "POD_STORAGE_LOCAL_ROOT",
            "POD_STORAGE_GCS_BUCKET",
            "POD_STORAGE_AZURE_BLOB_URL",
            "POD_STORAGE_PREFIX_TOKEN_URL",
            "HUSSH_POD_KMS_KEY",
            "HUSSH_POD_KEY_VAULT_KEY",
            "HUSSH_POD_ACE_SEAL_SCALAR",
        ):
            monkeypatch.delenv(other_env, raising=False)
        monkeypatch.delenv("AWS_ACCESS_KEY_ID", raising=False)
        monkeypatch.delenv("AWS_SECRET_ACCESS_KEY", raising=False)

        s3_admin = boto3.client("s3", **resolve_aws_boto3_client_kwargs("s3"))
        kms_admin = boto3.client("kms", **resolve_aws_boto3_client_kwargs("kms"))
        s3_admin.create_bucket(Bucket="hushh-floci-kms-bkt")
        key_arn = kms_admin.create_key()["KeyMetadata"]["Arn"]

        monkeypatch.setenv(CUSTODY_MODE_ENV, CUSTODY_OWNER_KMS)
        monkeypatch.setenv(AWS_KMS_KEY_ENV, key_arn)
        monkeypatch.setenv("HUSSH_ID", "owner-sovereign-001")

        # Boot 1: unmocked AwsKmsCustodyAdapter + unmocked S3ObjectStore mints & wraps DEK.
        port_boot_1 = resolve_key_custody_port()
        assert isinstance(port_boot_1, AwsKmsCustodyAdapter)
        dek_1 = port_boot_1.resolve_log_key()
        assert len(dek_1) == 32

        # Boot 2: cold restart unwraps exact same DEK over real KMS Decrypt wire call.
        dek_2 = resolve_key_custody_port().resolve_log_key()
        assert dek_2 == dek_1

        # Wrong owner HUSSH_ID changes EncryptionContext AAD -> KMS Decrypt fails closed!
        monkeypatch.setenv("HUSSH_ID", "attacker-impersonator-999")
        with pytest.raises(ByocKeyCustodyError, match="AWS KMS unwrap failed"):
            resolve_key_custody_port().resolve_log_key()

        # Disabled/revoked KMS key refuses unwrap on existing pod state.
        monkeypatch.setenv("HUSSH_ID", "owner-sovereign-001")
        if env.mode == "loopback_wire_reference":
            env.set_kms_key_disabled(key_arn, disabled=True)
            with pytest.raises(ByocKeyCustodyError, match="AWS KMS unwrap failed"):
                resolve_key_custody_port().resolve_log_key()
            env.set_kms_key_disabled(key_arn, disabled=False)

        # Crypto-erasure tombstone refuses minting a fresh DEK in a tombstoned prefix.
        monkeypatch.setenv(S3_URI_ENV, "s3://hushh-floci-kms-bkt/pods/owner-erased")
        erased_store = resolve_pod_object_store()
        assert (
            erased_store.put_if_generation_blocking(
                ERASURE_TOMBSTONE_OBJECT, b'{"erased":true}', ABSENT
            )
            is not None
        )
        with pytest.raises(ByocKeyCustodyError):
            resolve_key_custody_port().resolve_log_key()

        # Emulator wire pass NEVER promotes live hypervisor/IAM qualification or DB admission.
        aws_spec = PROVIDER_CAPABILITY_REGISTRY["user_aws"]
        assert aws_spec.sandbox_capability.execution_qualified is False
        assert aws_spec.registry_sql_admitted is False


@pytest.mark.parametrize("deploy_env", ["production", "prod", "uat"])
def test_emulator_endpoint_overrides_fail_closed_in_uat_and_production(
    monkeypatch: pytest.MonkeyPatch, deploy_env: str
) -> None:
    monkeypatch.setenv(FLOCI_ENDPOINT_URL_ENV, "http://127.0.0.1:4566")
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", deploy_env)

    store = S3ObjectStore("s3://hushh-prod-guard-bkt/pods/u1")
    with pytest.raises(PodMultiCloudStorageError, match="refused in UAT and production"):
        store.get_with_generation_blocking("head.json")

    adapter = AwsKmsCustodyAdapter(
        store=S3ObjectStore("s3://hushh-prod-guard-bkt/pods/u1", s3_client=object()),
        key_arn="arn:aws:kms:us-east-1:123456789012:key/abc",
        hushh_id="owner-1",
    )
    with pytest.raises(ByocKeyCustodyError, match="refused in UAT and production"):
        adapter.resolve_log_key()


def test_non_loopback_http_emulator_endpoint_is_refused(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(FLOCI_ENDPOINT_URL_ENV, "http://10.0.0.42:4566")
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "development")

    store = S3ObjectStore("s3://hushh-lan-guard-bkt/pods/u1")
    with pytest.raises(PodMultiCloudStorageError, match="loopback"):
        store.get_with_generation_blocking("head.json")


def _bootstrap_floci_owner_aws_stack(
    *,
    inputs: AwsPlanInputs,
    tamper_binding: bool = False,
    override_image_digest: str = "",
) -> dict[str, Any]:
    """Create the owner's IAM, S3, KMS, and ECS stack on Floci over real boto3 HTTP/SigV4."""
    names = aws_resource_names(
        hushh_id=inputs.hushh_id,
        account_id=inputs.account_id,
        region=inputs.region,
    )
    s3 = boto3.client("s3", **resolve_aws_boto3_client_kwargs("s3"))
    kms = boto3.client("kms", **resolve_aws_boto3_client_kwargs("kms"))
    iam = boto3.client("iam", **resolve_aws_boto3_client_kwargs("iam"))
    ecs = boto3.client("ecs", **resolve_aws_boto3_client_kwargs("ecs"))

    s3.create_bucket(Bucket=names.bucket_name)
    key_arn = kms.create_key()["KeyMetadata"]["Arn"]
    kms.create_alias(AliasName=names.kms_alias, TargetKeyId=key_arn)

    iam.create_role(
        RoleName=names.pod_task_role_name,
        AssumeRolePolicyDocument=json.dumps(
            {
                "Version": "2012-10-17",
                "Statement": [
                    {
                        "Effect": "Allow",
                        "Principal": {"Service": "ecs-tasks.amazonaws.com"},
                        "Action": "sts:AssumeRole",
                    }
                ],
            }
        ),
    )
    iam.put_role_policy(
        RoleName=names.pod_task_role_name,
        PolicyName=POD_RUNTIME_POLICY_NAME,
        PolicyDocument=json.dumps(pod_runtime_policy_document(inputs, names, kms_key_arn=key_arn)),
    )

    iam.create_role(
        RoleName=names.observer_role_name,
        AssumeRolePolicyDocument=json.dumps(
            {
                "Version": "2012-10-17",
                "Statement": [
                    {
                        "Effect": "Allow",
                        "Principal": {
                            "Federated": (
                                f"arn:aws:iam::{inputs.account_id}:oidc-provider/"
                                f"{inputs.hub_oidc_issuer}"
                            )
                        },
                        "Action": "sts:AssumeRoleWithWebIdentity",
                        "Condition": {"StringEquals": {"sts:ExternalId": inputs.nonce}},
                    }
                ],
            }
        ),
    )
    iam.put_role_policy(
        RoleName=names.observer_role_name,
        PolicyName=OBSERVER_POLICY_NAME,
        PolicyDocument=json.dumps(hussh_observer_policy_document(inputs, names)),
    )
    iam.put_role_policy(
        RoleName=names.observer_role_name,
        PolicyName=REMOVAL_POLICY_NAME,
        PolicyDocument=json.dumps(
            hussh_removal_policy_document(inputs, names, kms_key_arn=key_arn)
        ),
    )

    ecs.create_cluster(clusterName=names.cluster_name)
    effective_digest = override_image_digest or inputs.image_digest
    image = (
        f"{inputs.account_id}.dkr.ecr.{inputs.region}.amazonaws.com/"
        f"consent-protocol-pod@{effective_digest}"
    )
    td_arn = ecs.register_task_definition(
        family=names.task_family,
        networkMode="awsvpc",
        requiresCompatibilities=["FARGATE"],
        cpu="1000",
        memory="2048",
        taskRoleArn=names.pod_task_role_arn,
        executionRoleArn=names.pod_task_role_arn,
        containerDefinitions=[{"name": "pod", "image": image, "essential": True}],
    )["taskDefinition"]["taskDefinitionArn"]

    tag_map = aws_owner_tags(inputs)
    if tamper_binding:
        tag_map[BINDING_TAG] = "f" * 64
    ecs_tags = [{"key": k, "value": v} for k, v in sorted(tag_map.items())]
    ecs.create_service(
        cluster=names.cluster_name,
        serviceName=names.service_name,
        taskDefinition=td_arn,
        desiredCount=1,
        launchType="FARGATE",
        deploymentConfiguration={"maximumPercent": 100, "minimumHealthyPercent": 0},
        tags=ecs_tags,
    )
    return {"names": names, "kms_key_arn": key_arn, "task_definition_arn": td_arn}


def test_aws_cloudformation_blueprint_enforces_zero_delete_authority_and_single_writer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(
        "HUSSH_CONSENT_PLANE_SA", "consent-plane@hushh-pda-dev.iam.gserviceaccount.com"
    )
    digest = "sha256:" + "a1" * 32
    inputs = AwsPlanInputs(
        hushh_id="ha1_aws_sovereign_01",
        account_id="123456789012",
        region="us-east-1",
        nonce="0123456789abcdef",
        image_digest=digest,
    )
    names = aws_resource_names(
        hushh_id=inputs.hushh_id,
        account_id=inputs.account_id,
        region=inputs.region,
    )
    backend = UserAwsBackend(
        account_id=inputs.account_id,
        region=inputs.region,
        role_arn=names.observer_role_arn,
        image_digest=digest,
    )
    assert isinstance(backend, ComputeBackend)
    assert isinstance(backend, RestartableBackend)
    assert isinstance(backend, OwnerAccessErasableBackend)
    assert isinstance(backend, OwnerAccessCheckpointBackend)

    spec = PodSpec(
        hushh_id=inputs.hushh_id,
        phone_e164_hash="h",
        pod_pubkey="pub",
        deployment_target=BACKEND_USER_AWS,
        user_cloud_account_id=inputs.account_id,
        user_cloud_region=inputs.region,
        user_cloud_role_arn=names.observer_role_arn,
    )
    cfn = render_cloudformation_template(
        inputs,
        task_config=backend.render_deploy_config(spec),
    )
    resources = cfn["Resources"]
    assert resources["PodStorageBucket"]["DeletionPolicy"] == "Retain"
    assert resources["PodCustodyKey"]["DeletionPolicy"] == "Retain"
    assert resources["PodSigningSecret"]["DeletionPolicy"] == "Retain"
    assert resources["PodService"]["Properties"]["DesiredCount"] == 0
    assert resources["PodService"]["Properties"]["DeploymentConfiguration"]["MaximumPercent"] == 100

    hussh_actions: set[str] = set()
    for pol in resources["HusshObserverRole"]["Properties"]["Policies"]:
        for stmt in pol["PolicyDocument"]["Statement"]:
            acts = stmt["Action"]
            hussh_actions.update([acts] if isinstance(acts, str) else acts)

    for forbidden in (
        "s3:DeleteBucket",
        "s3:GetObject",
        "s3:PutObject",
        "ecs:DeleteService",
        "kms:Decrypt",
        "kms:ScheduleKeyDeletion",
        "secretsmanager:GetSecretValue",
    ):
        assert forbidden not in hussh_actions


@pytest.mark.asyncio
async def test_aws_readiness_and_live_adapter_enforce_floci_only_loopback_gate(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(
        "HUSSH_CONSENT_PLANE_SA", "consent-plane@hushh-pda-dev.iam.gserviceaccount.com"
    )
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "development")
    monkeypatch.delenv(FLOCI_ENDPOINT_URL_ENV, raising=False)

    digest = "sha256:" + "b2" * 32
    names = aws_resource_names(
        hushh_id="ha1_aws_gate_01",
        account_id="123456789012",
        region="us-east-1",
    )
    spec = PodSpec(
        hushh_id="ha1_aws_gate_01",
        phone_e164_hash="h",
        pod_pubkey="pub",
        deployment_target=BACKEND_USER_AWS,
        user_cloud_account_id="123456789012",
        user_cloud_region="us-east-1",
        user_cloud_role_arn=names.observer_role_arn,
        expected_image_digest=digest,
    )
    backend = UserAwsBackend(
        account_id="123456789012",
        region="us-east-1",
        role_arn=names.observer_role_arn,
        image_digest=digest,
        live=True,
    )

    # 1. Without FLOCI_ENDPOINT_URL, live AWS readiness and adapter calls fail closed!
    report_missing = evaluate_aws_readiness(spec, image_digest=digest, sts_probe=True)
    assert report_missing["readyForFlociDevRehearsal"] is False
    assert report_missing["checks"]["floci_loopback_enforced"] is False
    with pytest.raises(AwsFlociGateRefused, match="restricted to Floci loopback"):
        await backend.provision(spec)

    # 2. Non-loopback FLOCI_ENDPOINT_URL is refused!
    monkeypatch.setenv(FLOCI_ENDPOINT_URL_ENV, "http://10.0.0.88:4566")
    with pytest.raises(AwsFlociGateRefused, match="loopback"):
        await backend.provision(spec)

    # 3. UAT / production refuses even loopback Floci!
    monkeypatch.setenv(FLOCI_ENDPOINT_URL_ENV, "http://127.0.0.1:4566")
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "uat")
    with pytest.raises(AwsFlociGateRefused, match="refused in UAT and production"):
        await backend.provision(spec)


@pytest.mark.asyncio
async def test_floci_wire_full_aws_sovereign_pod_lifecycle_over_real_boto3(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with floci_aws_wire_environment() as env:
        monkeypatch.setenv(FLOCI_ENDPOINT_URL_ENV, env.endpoint_url)
        monkeypatch.setenv("ENVIRONMENT", "test")
        monkeypatch.setenv("HUSHH_DEPLOY_ENV", "development")
        monkeypatch.setenv(
            "HUSSH_CONSENT_PLANE_SA", "consent-plane@hushh-pda-dev.iam.gserviceaccount.com"
        )
        monkeypatch.delenv("AWS_ACCESS_KEY_ID", raising=False)
        monkeypatch.delenv("AWS_SECRET_ACCESS_KEY", raising=False)

        digest = "sha256:" + "c3" * 32
        inputs = AwsPlanInputs(
            hushh_id="ha1_aws_lifecycle_01",
            account_id="123456789012",
            region="us-east-1",
            nonce="89abcdef01234567",
            image_digest=digest,
            pod_url="https://pod-lifecycle.us-east-1.aws.internal",
        )
        stack = _bootstrap_floci_owner_aws_stack(inputs=inputs)
        names = stack["names"]
        kms_key_arn = stack["kms_key_arn"]

        spec = PodSpec(
            hushh_id=inputs.hushh_id,
            phone_e164_hash="h",
            pod_pubkey="pub",
            deployment_target=BACKEND_USER_AWS,
            user_cloud_account_id=inputs.account_id,
            user_cloud_region=inputs.region,
            user_cloud_role_arn=names.observer_role_arn,
            expected_image_digest=digest,
            expected_setup_nonce=inputs.nonce,
        )

        # 1. Preflight readiness probe over Floci STS AssumeRole.
        readiness = evaluate_aws_readiness(spec, image_digest=digest, sts_probe=True)
        assert readiness["readyForFlociDevRehearsal"] is True
        assert readiness["readinessPlane"] == "floci_loopback_only"
        assert readiness["checks"]["sts_assume_role_verified"] is True
        assert readiness["executionQualified"] is False
        assert readiness["registrySqlAdmitted"] is False

        # 2. Federated attach (`provision`), health observation (`get`), and `restart`.
        backend = UserAwsBackend(
            account_id=inputs.account_id,
            region=inputs.region,
            role_arn=names.observer_role_arn,
            image_digest=digest,
            live=True,
        )
        handle = await backend.provision(spec)
        assert handle.status == "live"
        assert handle.backend == BACKEND_USER_AWS
        assert handle.external_agent_id == names.service_arn
        assert (handle.backend_metadata or {})["setupNonce"] == inputs.nonce

        # Verify adoption_expectations round-trips cleanly without VM-host collision!
        adopted = adoption_expectations(handle.backend_metadata)
        assert adopted["expected_service_uid"] == inputs.resolved_incarnation
        assert adopted["expected_image_digest"] == digest
        assert adopted["expected_setup_nonce"] == inputs.nonce
        assert adopted["azure_vm_host"] is None

        status_live = await backend.get(names.service_arn)
        assert status_live.status == "live" and status_live.healthy is True

        restart_res = await backend.restart(spec)
        assert restart_res["restarted"] is True
        assert restart_res["service"] == names.service_arn

        with pytest.raises(AwsDeleteAuthorityRefused):
            await backend.deprovision(names.service_arn)

        # Verify Hussh observer STS session is refused by IAM if it tries DeleteService!
        if env.mode == "loopback_wire_reference":
            obs_ecs = backend._assume_role_clients(
                external_id=inputs.nonce,
                services=("ecs",),
            )["ecs"]
            with pytest.raises(Exception, match="AccessDenied"):
                obs_ecs.delete_service(
                    cluster=names.cluster_name,
                    service=names.service_name,
                )

        # 3. Boot pod data plane under PodTaskRole STS session (S3 CAS + KMS DEK custody).
        sts = boto3.client("sts", **resolve_aws_boto3_client_kwargs("sts"))
        pod_creds = sts.assume_role(
            RoleArn=names.pod_task_role_arn,
            RoleSessionName="pod-fargate-task",
        )["Credentials"]
        pod_s3_kw = resolve_aws_boto3_client_kwargs("s3")
        pod_s3_kw.update(
            aws_access_key_id=pod_creds["AccessKeyId"],
            aws_secret_access_key=pod_creds["SecretAccessKey"],
            aws_session_token=pod_creds["SessionToken"],
        )
        pod_kms_kw = resolve_aws_boto3_client_kwargs("kms")
        pod_kms_kw.update(
            aws_access_key_id=pod_creds["AccessKeyId"],
            aws_secret_access_key=pod_creds["SecretAccessKey"],
            aws_session_token=pod_creds["SessionToken"],
        )
        pod_store = S3ObjectStore(
            f"s3://{names.bucket_name}/pod",
            s3_client=boto3.client("s3", **pod_s3_kw),
        )
        pod_custody = AwsKmsCustodyAdapter(
            store=pod_store,
            kms_client=boto3.client("kms", **pod_kms_kw),
            key_arn=kms_key_arn,
            hushh_id=inputs.hushh_id,
        )
        dek = pod_custody.resolve_log_key()
        assert len(dek) == 32
        commit_log = PodCommitLog(pod_store, dek, owner_id=inputs.hushh_id)
        await commit_log.append("memory", {"turn": 1, "summary": "sovereign-aws"})
        assert (await commit_log.replay())[0]["payload"]["summary"] == "sovereign-aws"

        # 4. Full checkpointed owner-access erasure (zero delete authority).
        fenced_spec = PodSpec(
            hushh_id=inputs.hushh_id,
            phone_e164_hash="h",
            pod_pubkey="pub",
            deployment_target=BACKEND_USER_AWS,
            user_cloud_account_id=inputs.account_id,
            user_cloud_region=inputs.region,
            user_cloud_role_arn=names.observer_role_arn,
            **adopted,
        )
        erasure_target = await backend.observe_erasure_target(fenced_spec)
        assert erasure_target["serviceUid"] == inputs.resolved_incarnation
        assert erasure_target["podUrl"] == "https://pod-lifecycle.us-east-1.aws.internal"

        checkpoint_nonces: list[str] = []

        async def _confirm_crypto_erase(resume: dict[str, str]) -> dict[str, Any]:
            checkpoint_nonces.append(resume["setupNonce"])
            return {
                "erased": True,
                "hushhId": inputs.hushh_id,
                "serviceUid": inputs.resolved_incarnation,
            }

        receipt = await backend.erase_owner_access(
            fenced_spec,
            crypto_erase=_confirm_crypto_erase,
        )
        assert checkpoint_nonces == [inputs.nonce]
        assert receipt["version"] == 1
        assert receipt["accountId"] == inputs.account_id
        assert receipt["kmsKey"]["disabled"] is True
        assert receipt["kmsKey"]["scheduledForDeletion"] is False

        if env.mode == "loopback_wire_reference":
            # Defense-in-depth lock 1: Pod IAM inline policy was deleted -> pod STS session gets 403 on S3!
            with pytest.raises(PodMultiCloudStorageForbidden):
                await pod_store.get_with_generation("head.json")
            with pytest.raises(PodMultiCloudStorageForbidden):
                pod_custody.resolve_log_key()

            # Defense-in-depth lock 2: Even if S3 is read directly by owner admin, KMS key is disabled -> DEK unwrap fails closed!
            owner_admin_store = S3ObjectStore(f"s3://{names.bucket_name}/pod")
            owner_admin_kms = boto3.client("kms", **resolve_aws_boto3_client_kwargs("kms"))
            assert (
                owner_admin_kms.describe_key(KeyId=kms_key_arn)["KeyMetadata"]["Enabled"] is False
            )
            with pytest.raises(ByocKeyCustodyError, match="AWS KMS unwrap failed"):
                AwsKmsCustodyAdapter(
                    store=owner_admin_store,
                    kms_client=owner_admin_kms,
                    key_arn=kms_key_arn,
                    hushh_id=inputs.hushh_id,
                ).resolve_log_key()

            # Defense-in-depth lock 3: Hussh revoked its own observer + removal policies LAST -> reads raise AwsAgentUnreadable (NEVER gone)!
            with pytest.raises(AwsAgentUnreadable):
                await backend.get(names.service_arn)


@pytest.mark.asyncio
async def test_floci_wire_aws_confused_deputy_refusal_and_interrupted_erasure_resume(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with floci_aws_wire_environment() as env:
        monkeypatch.setenv(FLOCI_ENDPOINT_URL_ENV, env.endpoint_url)
        monkeypatch.setenv("ENVIRONMENT", "test")
        monkeypatch.setenv("HUSHH_DEPLOY_ENV", "development")
        monkeypatch.setenv(
            "HUSSH_CONSENT_PLANE_SA", "consent-plane@hushh-pda-dev.iam.gserviceaccount.com"
        )
        monkeypatch.delenv("AWS_ACCESS_KEY_ID", raising=False)
        monkeypatch.delenv("AWS_SECRET_ACCESS_KEY", raising=False)

        approved_digest = "sha256:" + "d4" * 32
        rogue_digest = "sha256:" + "e5" * 32

        # 1. Confused-deputy negative control: tampered owner-binding tag is refused!
        tampered_inputs = AwsPlanInputs(
            hushh_id="ha1_aws_tampered_01",
            account_id="123456789012",
            region="us-east-1",
            nonce="1111222233334444",
            image_digest=approved_digest,
        )
        tampered_stack = _bootstrap_floci_owner_aws_stack(
            inputs=tampered_inputs,
            tamper_binding=True,
        )
        tampered_backend = UserAwsBackend(
            account_id="123456789012",
            region="us-east-1",
            role_arn=tampered_stack["names"].observer_role_arn,
            image_digest=approved_digest,
            live=True,
        )
        with pytest.raises(RuntimeError, match="owner binding"):
            await tampered_backend.provision(
                PodSpec(
                    hushh_id=tampered_inputs.hushh_id,
                    phone_e164_hash="h",
                    pod_pubkey="pub",
                    deployment_target=BACKEND_USER_AWS,
                    user_cloud_account_id="123456789012",
                    user_cloud_region="us-east-1",
                    user_cloud_role_arn=tampered_stack["names"].observer_role_arn,
                    expected_setup_nonce=tampered_inputs.nonce,
                )
            )

        # 2. Unapproved digest negative control: foreign task image digest is refused!
        digest_inputs = AwsPlanInputs(
            hushh_id="ha1_aws_digest_01",
            account_id="123456789012",
            region="us-east-1",
            nonce="5555666677778888",
            image_digest=approved_digest,
        )
        digest_stack = _bootstrap_floci_owner_aws_stack(
            inputs=digest_inputs,
            override_image_digest=rogue_digest,
        )
        digest_backend = UserAwsBackend(
            account_id="123456789012",
            region="us-east-1",
            role_arn=digest_stack["names"].observer_role_arn,
            image_digest=approved_digest,
            live=True,
        )
        with pytest.raises(RuntimeError, match="digest is not approved"):
            await digest_backend.provision(
                PodSpec(
                    hushh_id=digest_inputs.hushh_id,
                    phone_e164_hash="h",
                    pod_pubkey="pub",
                    deployment_target=BACKEND_USER_AWS,
                    user_cloud_account_id="123456789012",
                    user_cloud_region="us-east-1",
                    user_cloud_role_arn=digest_stack["names"].observer_role_arn,
                    expected_setup_nonce=digest_inputs.nonce,
                )
            )

        # 3. Interrupted-revocation crash recovery (`resume_owner_access_revocation`):
        # Simulate crash AFTER pod policy + HusshObserverAccess were deleted, leaving
        # ONLY HusshRemovalAccess on the observer role!
        resume_inputs = AwsPlanInputs(
            hushh_id="ha1_aws_resume_01",
            account_id="123456789012",
            region="us-east-1",
            nonce="9999aaaabbbbcccc",
            image_digest=approved_digest,
        )
        resume_stack = _bootstrap_floci_owner_aws_stack(inputs=resume_inputs)
        r_names = resume_stack["names"]
        iam_admin = boto3.client("iam", **resolve_aws_boto3_client_kwargs("iam"))
        iam_admin.delete_role_policy(
            RoleName=r_names.pod_task_role_name,
            PolicyName=POD_RUNTIME_POLICY_NAME,
        )
        iam_admin.delete_role_policy(
            RoleName=r_names.observer_role_name,
            PolicyName=OBSERVER_POLICY_NAME,
        )

        resume_backend = UserAwsBackend(
            account_id="123456789012",
            region="us-east-1",
            role_arn=r_names.observer_role_arn,
            image_digest=approved_digest,
            live=True,
        )
        resume_spec = PodSpec(
            hushh_id=resume_inputs.hushh_id,
            phone_e164_hash="h",
            pod_pubkey="pub",
            deployment_target=BACKEND_USER_AWS,
            user_cloud_account_id="123456789012",
            user_cloud_region="us-east-1",
            user_cloud_role_arn=r_names.observer_role_arn,
            expected_service_uid=resume_inputs.resolved_incarnation,
            expected_setup_nonce=resume_inputs.nonce,
        )
        resumed_receipt = await resume_backend.resume_owner_access_revocation(
            resume_spec,
            agent_erased={
                "erased": True,
                "hushhId": resume_inputs.hushh_id,
                "serviceUid": resume_inputs.resolved_incarnation,
            },
            resume={"setupNonce": resume_inputs.nonce},
        )
        assert resumed_receipt["version"] == 1
        assert resumed_receipt["kmsKey"]["disabled"] is True
        assert (
            iam_admin.list_role_policies(RoleName=r_names.observer_role_name)["PolicyNames"] == []
        )
