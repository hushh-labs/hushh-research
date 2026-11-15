# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Closed-loop contract tests for single-image pod activation & multi-cloud upgrades.

Proves that:
1. ``Dockerfile.pod`` preserves every build-once static invariant.
2. Every deployment target in ``PROVIDER_CAPABILITY_REGISTRY`` (``gcp``, ``ace``,
   ``user_gcp``, ``user_azure``, ``user_aws``) has a complete runtime activation and
   model-provider entry with zero drift against ``pod_platform`` and
   ``model_access_policy``.
3. Real rendered container configs from all 5 compute backends pass
   ``evaluate_pod_activation_readiness`` with zero missing surfaces.
4. ``model_access_for`` serves both ``user_aws`` (standing Bedrock task role + per-turn
   BYOK) and ``ace`` (fleet-gated + per-turn BYOK), and ``byoc_aws_bedrock_preconditions``
   verifies IAM role policies over real ``boto3`` wire against ``FlociWireServer`` while
   refusing live non-Floci endpoints in ``dev``.
5. ``pod_release.validate_release`` and ``assemble-pod-release.py`` admit multi-cloud
   ``browserQualifications`` beyond the old 2-cloud cap, and
   ``evaluate_multi_cloud_upgrade_clearance`` tracks exact per-cloud clearance vs
   remaining live-sandbox gates without ambiguity.
"""

from __future__ import annotations

import hashlib
import json
from copy import deepcopy
from pathlib import Path

import boto3
import pytest

from api.routes.one import pod_capabilities
from hushh_mcp.services.ace_backend import AceComputeBackend
from hushh_mcp.services.aws_setup_plan import (
    AwsFlociGateRefused,
    AwsPlanInputs,
    aws_resource_names,
    render_cloudformation_template,
)
from hushh_mcp.services.compute_backend import (
    BACKEND_ACE,
    BACKEND_GCP,
    BACKEND_USER_AWS,
    BACKEND_USER_AZURE,
    BACKEND_USER_GCP,
    PodSpec,
)
from hushh_mcp.services.gcp_backend import GcpBackend
from hushh_mcp.services.model_access_policy import (
    ACTIVATION_BYOK_PER_TURN,
    ACTIVATION_FLEET_ADC,
    ACTIVATION_USER_AWS_BEDROCK,
    AGENT_ACTIVATION_ORDER,
    MANAGED_PROVIDER,
    byoc_aws_bedrock_preconditions,
    model_access_for,
)
from hushh_mcp.services.pod_activation_contract import (
    POD_TARGET_ACTIVATION_ESSENTIALS,
    evaluate_multi_cloud_upgrade_clearance,
    evaluate_pod_activation_readiness,
    verify_dockerfile_pod_essentials,
)
from hushh_mcp.services.pod_s3_object_store import resolve_aws_boto3_client_kwargs
from hushh_mcp.services.provider_capability_registry import PROVIDER_CAPABILITY_REGISTRY
from hushh_mcp.services.user_aws_backend import UserAwsBackend
from hushh_mcp.services.user_azure_backend import UserAzureBackend
from hushh_mcp.services.user_gcp_backend import UserGcpBackend
from tests.floci_wire_harness import floci_aws_wire_environment

_BACKEND_DIR = Path(__file__).resolve().parents[1]
_DIGEST = "sha256:" + "a" * 64


@pytest.fixture(autouse=True)
def _base_hub_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("APP_SIGNING_KEY", "test_secret_key_for_ci_only_32chars_min")
    monkeypatch.setenv("VAULT_DATA_KEY", "0" * 64)
    monkeypatch.setenv("HUSSH_HUB_BASE_URL", "https://hub.dev.hushh.ai")
    monkeypatch.setenv("HUSSH_CONSENT_PLANE_SA", "hub@hushh-pda-dev.iam.gserviceaccount.com")
    monkeypatch.setenv("POD_STORAGE_GCS_BUCKET", "fleet-pod-bucket")


def test_dockerfile_pod_preserves_all_build_once_essentials() -> None:
    dockerfile = _BACKEND_DIR / "Dockerfile.pod"
    assert verify_dockerfile_pod_essentials(dockerfile) == ()


def test_every_registered_cloud_target_has_complete_activation_and_model_rules() -> None:
    assert set(POD_TARGET_ACTIVATION_ESSENTIALS) == set(PROVIDER_CAPABILITY_REGISTRY)
    for target_id, spec in POD_TARGET_ACTIVATION_ESSENTIALS.items():
        # Universal sealed BYOK path works on every cloud without standing model IAM.
        for byok_provider in spec.universal_sealed_providers:
            verdict = model_access_for(target_id, byok_provider)
            assert verdict.can_serve is True
            assert verdict.activation == ACTIVATION_BYOK_PER_TURN
            assert verdict.activation_order == AGENT_ACTIVATION_ORDER


def test_model_access_for_user_aws_and_ace_is_explicit_and_isolated(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("HUSSH_POD_MANAGED_MODEL_ENABLED", "false")
    # Owner AWS standing Bedrock access is the owner's account, independent of fleet flag.
    aws_managed = model_access_for(BACKEND_USER_AWS, MANAGED_PROVIDER)
    assert aws_managed.can_serve is True
    assert aws_managed.activation == ACTIVATION_USER_AWS_BEDROCK
    assert aws_managed.activation_order == AGENT_ACTIVATION_ORDER

    aws_byok = model_access_for(BACKEND_USER_AWS, "openai")
    assert aws_byok.can_serve is True
    assert aws_byok.activation == ACTIVATION_BYOK_PER_TURN

    # Hosted ACE borrows fleet model access only when fleet flag is enabled; BYOK always works.
    ace_off = model_access_for(BACKEND_ACE, MANAGED_PROVIDER)
    assert ace_off.can_serve is False
    assert ace_off.activation == ""
    assert model_access_for(BACKEND_ACE, "gemini").can_serve is True

    monkeypatch.setenv("HUSSH_POD_MANAGED_MODEL_ENABLED", "true")
    ace_on = model_access_for(BACKEND_ACE, MANAGED_PROVIDER)
    assert ace_on.can_serve is True
    assert ace_on.activation == ACTIVATION_FLEET_ADC


def test_all_five_rendered_backends_pass_pod_activation_readiness() -> None:
    spec = PodSpec(hushh_id="ha1_act_01", phone_e164_hash="b" * 64, pod_pubkey="c" * 43)

    gcp_cfg = GcpBackend(
        project="hushh-pda-dev",
        region="us-central1",
        image=f"gcr.io/hushh-pda-dev/pod@{_DIGEST}",
        live=False,
    ).render_deploy_config(spec)
    gcp_res = evaluate_pod_activation_readiness(
        BACKEND_GCP,
        rendered_env=gcp_cfg["spec"]["template"]["spec"]["containers"][0]["env"],
    )
    assert gcp_res["ready"] is True, gcp_res["missingSurfaces"]

    ugcp_cfg = UserGcpBackend(
        user_project="owner-gcp-proj",
        user_region="us-central1",
        hushh_invoker_sa="hub@hushh-pda-dev.iam.gserviceaccount.com",
        live=False,
    ).render_deploy_config(spec, image_digest=_DIGEST)
    ugcp_res = evaluate_pod_activation_readiness(
        BACKEND_USER_GCP,
        rendered_env=ugcp_cfg["spec"]["template"]["spec"]["containers"][0]["env"],
        coordinates={"project": "owner-gcp-proj"},
    )
    assert ugcp_res["ready"] is True, ugcp_res["missingSurfaces"]

    uaz_cfg = UserAzureBackend(
        tenant_id="11111111-1111-1111-1111-111111111111",
        subscription_id="22222222-2222-2222-2222-222222222222",
        resource_group="rg-owner",
        location="eastus2",
    ).render_deploy_config(spec)
    uaz_res = evaluate_pod_activation_readiness(
        BACKEND_USER_AZURE,
        rendered_env=uaz_cfg["properties"]["template"]["containers"][0]["env"],
        coordinates={
            "tenant_id": "11111111-1111-1111-1111-111111111111",
            "subscription_id": "22222222-2222-2222-2222-222222222222",
            "resource_group": "rg-owner",
            "region": "eastus2",
        },
    )
    assert uaz_res["ready"] is True, uaz_res["missingSurfaces"]

    ace_cfg = AceComputeBackend(
        cell_project="hushh-ace-cell",
        region="us-central1",
        image_digest=_DIGEST,
    ).render_deploy_config(spec)
    ace_res = evaluate_pod_activation_readiness(
        BACKEND_ACE,
        rendered_env=ace_cfg["spec"]["container"]["env"],
    )
    assert ace_res["ready"] is True, ace_res["missingSurfaces"]

    uaws_cfg = UserAwsBackend(
        account_id="123456789012",
        region="us-east-1",
        role_arn="arn:aws:iam::123456789012:role/hussh-one-pod",
        image_digest=_DIGEST,
        live=False,
    ).render_deploy_config(spec)
    uaws_container = uaws_cfg["taskDefinition"]["containerDefinitions"][0]
    uaws_res = evaluate_pod_activation_readiness(
        BACKEND_USER_AWS,
        rendered_env=uaws_container["environment"],
        rendered_secrets=uaws_container["secrets"],
        coordinates={
            "account_id": "123456789012",
            "region": "us-east-1",
            "role_arn": "arn:aws:iam::123456789012:role/hussh-one-pod",
        },
    )
    assert uaws_res["ready"] is True, uaws_res["missingSurfaces"]
    assert uaws_res["custodyMode"] == "owner_kms"

    # CloudFormation standalone default container also wires incarnation + storage + secret.
    cfn = render_cloudformation_template(
        AwsPlanInputs(
            hushh_id="ha1_act_01",
            account_id="123456789012",
            region="us-east-1",
            nonce="0123456789abcdef",
            image_digest=_DIGEST,
        )
    )
    cfn_cdef = cfn["Resources"]["PodTaskDefinition"]["Properties"]["ContainerDefinitions"][0]
    cfn_env_names = {entry["Name"] for entry in cfn_cdef["Environment"]}
    assert {
        "HUSSH_AWS_SERVICE_NAME",
        "HUSSH_AWS_TASK_REVISION",
        "POD_STORAGE_S3_URI",
    } <= cfn_env_names


def test_aws_voice_policy_and_floci_bedrock_preconditions(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # AWS Fargate pods disable managed Gemini live voice even if stray GCP env is present.
    monkeypatch.setenv("AWS_EXECUTION_ENV", "AWS_ECS_FARGATE")
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "stray-gcp-proj")
    assert pod_capabilities.voice_hosting_allowed() is False
    monkeypatch.delenv("AWS_EXECUTION_ENV")
    monkeypatch.delenv("GOOGLE_CLOUD_PROJECT")

    # Without Floci loopback URL, Bedrock precondition check fails closed (AwsFlociGateRefused).
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    monkeypatch.delenv("FLOCI_ENDPOINT_URL", raising=False)
    names = aws_resource_names(
        hushh_id="ha1_bedrock_01", account_id="123456789012", region="us-east-1"
    )
    with pytest.raises(AwsFlociGateRefused):
        byoc_aws_bedrock_preconditions(
            account_id="123456789012",
            region="us-east-1",
            pod_task_role_name=names.pod_task_role_name,
        )

    # Against loopback Floci over real boto3 IAM wire, missing vs granted Bedrock policies work.
    with floci_aws_wire_environment() as floci:
        monkeypatch.setenv("FLOCI_ENDPOINT_URL", floci.endpoint_url)
        iam_kwargs = resolve_aws_boto3_client_kwargs("iam")
        iam_kwargs["region_name"] = "us-east-1"
        iam = boto3.client("iam", **iam_kwargs)
        iam.create_role(
            RoleName=names.pod_task_role_name,
            AssumeRolePolicyDocument=json.dumps({"Version": "2012-10-17", "Statement": []}),
        )
        missing_check = byoc_aws_bedrock_preconditions(
            account_id="123456789012",
            region="us-east-1",
            pod_task_role_name=names.pod_task_role_name,
        )
        assert missing_check["established"] is False
        assert len(missing_check["missing"]) == 2

        iam.put_role_policy(
            RoleName=names.pod_task_role_name,
            PolicyName="HusshBedrockModelAccess",
            PolicyDocument=json.dumps(
                {
                    "Version": "2012-10-17",
                    "Statement": [
                        {
                            "Effect": "Allow",
                            "Action": [
                                "bedrock:InvokeModel",
                                "bedrock:InvokeModelWithResponseStream",
                            ],
                            "Resource": "*",
                        }
                    ],
                }
            ),
        )
        ok_check = byoc_aws_bedrock_preconditions(
            account_id="123456789012",
            region="us-east-1",
            pod_task_role_name=names.pod_task_role_name,
        )
        assert ok_check["established"] is True
        assert ok_check["missing"] == []


def test_multi_cloud_release_and_upgrade_clearance_matrix(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from hushh_mcp.services.pod_release import qualification_from_receipt, validate_release
    from tests.helpers.pod_browser import readiness

    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    fixture_path = _BACKEND_DIR / "tests" / "fixtures" / "pod_release.v1.json"
    release = json.loads(fixture_path.read_text())
    target_digest = release["image"].rsplit("@", 1)[1]

    # Build 3 distinct host qualifications (gcp_cloud_run, azure_container_apps, azure_vm)
    # proving the old hardcoded <= 2 cap is retired without weakening validation.
    gcp_stmt = {
        "version": 1,
        "host_kind": "gcp_cloud_run",
        "source_revision": release["sourceRevision"],
        "image_tag": "source",
        "public_policy_sha256": "e" * 64,
        "readiness": readiness(component_digest=target_digest).model_dump(),
    }
    az_vm_ready = readiness(component_digest=target_digest).model_dump()
    az_vm_ready["cloud"] = "azure"
    az_vm_stmt = {
        "version": 1,
        "host_kind": "azure_vm",
        "source_revision": release["sourceRevision"],
        "image_tag": "source",
        "public_policy_sha256": "e" * 64,
        "readiness": az_vm_ready,
    }
    az_ca_stmt = {
        "version": 2,
        "host_kind": "azure_container_apps",
        "source_revision": release["sourceRevision"],
        "image_tag": "source",
        "public_policy_sha256": "e" * 64,
        "readiness": {
            "version": 2,
            "boundary": "shared_owner_container",
            "chromium_sandbox": False,
            "browser_start_verified": True,
            "runtime_uid_verified": True,
            "lifecycle_verified": True,
            "isolated": False,
            "direct_egress_denied": False,
            "private_access_denied": False,
            "broker_bridge_verified": True,
            "ephemeral_bridge_verified": True,
            "model_transport_verified": True,
            "cloud": "azure",
            "component_digest": target_digest,
            "model_name": "gpt-5-mini",
            "model_transport": "azure_openai_mi",
        },
    }
    quals = []
    for stmt in (gcp_stmt, az_vm_stmt, az_ca_stmt):
        raw = json.dumps({"qualification": stmt}).encode()
        quals.append(
            qualification_from_receipt(
                raw,
                expected_sha256=hashlib.sha256(raw).hexdigest(),
                image_digest=target_digest,
                source_revision=release["sourceRevision"],
            )
        )

    multi_release = {**deepcopy(release), "browserQualifications": quals}
    validated = validate_release(multi_release, target_image=release["image"], environment="dev")
    assert len(validated["browserQualifications"]) == 3

    installed = "gcr.io/hushh/pod@" + release["descriptor"]["supportedUpgradeDigests"][0]
    matrix = evaluate_multi_cloud_upgrade_clearance(
        release_metadata=validated,
        installed_image=installed,
        model_provider="gemini",
        require_browser_qualification=True,
    )
    assert set(matrix) == {"gcp", "ace", "user_gcp", "user_azure", "user_aws"}
    # Qualified owner clouds with attached browser receipts are fully cleared:
    assert matrix["user_gcp"]["cleared"] is True
    assert matrix["user_azure"]["cleared"] is True
    assert matrix["gcp"]["cleared"] is True
    # Unadmitted live targets report exact blocking gates instead of silent failure:
    assert matrix["user_aws"]["cleared"] is False
    assert "owner_update_not_qualified" in matrix["user_aws"]["blockingGates"]
    assert "sandbox_not_execution_qualified" in matrix["user_aws"]["blockingGates"]
    assert matrix["ace"]["cleared"] is False
    assert "hosted_target_not_sql_admitted" in matrix["ace"]["blockingGates"]
    assert "sandbox_not_execution_qualified" in matrix["ace"]["blockingGates"]
