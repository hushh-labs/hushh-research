"""Hosted GCP image/model authority; pure plans never authorize live resources."""

from __future__ import annotations

import pytest

from hushh_mcp.services.user_gcp_backend import UserGcpBackend
from tests.test_user_gcp_model_access_boundary import _env_of, _spec


def _hosted_deployment():
    from hushh_mcp.services.private_gcp_deployment import PrivateGcpDeployment

    return PrivateGcpDeployment(
        owner="HA1HOSTED01",
        hosting_mode="hussh_hosted",
        environment="dev",
        project="hussh-pilot-owner01",
        region="us-central1",
        image="us-central1-docker.pkg.dev/hussh-pilot-owner01/one-pod/"
        "consent-protocol-pod@sha256:" + "a" * 64,
        hub_principal="consent-plane@hushh-pda-dev.iam.gserviceaccount.com",
    )


def test_numeric_cloud_run_namespace_requires_independent_project_mapping(monkeypatch):
    from dataclasses import replace

    from hushh_mcp.services.hosted_gcp_backend import HostedGcpBackend

    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    deployment = replace(_hosted_deployment(), project_number="123456789012")
    service = HostedGcpBackend(deployment=deployment).render_deploy_config(
        replace(_spec(), hushh_id=deployment.owner, deployment_target="gcp")
    )
    service["metadata"]["namespace"] = deployment.project_number
    deployment.verify_observation(service)
    service["metadata"]["namespace"] = "123456789013"
    with pytest.raises(ValueError, match="admitted authority"):
        deployment.verify_observation(service)


def test_hosting_adapters_share_digest_without_sharing_custody(monkeypatch):
    from dataclasses import replace

    from hushh_mcp.services.hosted_gcp_backend import HostedGcpBackend
    from hushh_mcp.services.private_gcp_deployment import HOSTING_ENV

    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    monkeypatch.setenv("HUSSH_POD_VERTEX_PROJECT", "wrong-hub-project")
    monkeypatch.setenv("HUSSH_POD_MANAGED_MODEL_ENABLED", "true")
    deployment = _hosted_deployment()
    spec = replace(_spec(), hushh_id=deployment.owner, deployment_target="gcp")
    hosted = HostedGcpBackend(deployment=deployment)
    hosted_service = hosted.render_deploy_config(spec)
    byoc_service = UserGcpBackend(
        user_project="customer-project",
        image=deployment.image,
        hushh_invoker_sa=deployment.hub_principal,
    ).render_deploy_config(
        replace(spec, deployment_target="user_gcp"), image_digest="sha256:" + "a" * 64
    )
    hosted_env, byoc_env = _env_of(hosted_service), _env_of(byoc_service)
    hosted_image = hosted_service["spec"]["template"]["spec"]["containers"][0]["image"]
    byoc_image = byoc_service["spec"]["template"]["spec"]["containers"][0]["image"]
    assert hosted_image.rsplit("@", 1)[1] == byoc_image.rsplit("@", 1)[1]
    assert hosted_service["metadata"]["labels"]["hussh-tenancy"] == "hussh-hosted"
    assert byoc_service["metadata"]["labels"]["hussh-tenancy"] == "user-owned"
    assert hosted_env["GOOGLE_CLOUD_PROJECT"] == deployment.project
    assert byoc_env["GOOGLE_CLOUD_PROJECT"] == "customer-project"
    assert hosted_env["HUSSH_POD_KMS_KEY"] != byoc_env["HUSSH_POD_KMS_KEY"]
    assert hosted_env["HUSSH_POD_USER_ADC_ENABLED"] == "false"
    assert byoc_env["HUSSH_POD_USER_ADC_ENABLED"] == "true"
    assert HOSTING_ENV in hosted_env and HOSTING_ENV not in byoc_env
    for env in (hosted_env, byoc_env):
        assert not any(
            env.get(key)
            for key in (
                "HUSSH_POD_LOG_KEY",
                "HUSSH_POD_MEMORY_KEY",
                "HUSSH_POD_MANAGED_MODEL_ENABLED",
            )
        )
    assert hosted.live is False


@pytest.mark.parametrize(
    "defect",
    [
        "owner",
        "project",
        "missing_namespace",
        "image",
        "principal",
        "key",
        "environment",
        "duplicate",
    ],
)
def test_private_deployment_rejects_changed_provider_binding(monkeypatch, defect):
    from dataclasses import replace

    from hushh_mcp.services.hosted_gcp_backend import HostedGcpBackend

    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    deployment = _hosted_deployment()
    service = HostedGcpBackend(deployment=deployment).render_deploy_config(
        replace(_spec(), hushh_id=deployment.owner, deployment_target="gcp")
    )
    deployment.verify_observation(service)
    template = service["spec"]["template"]["spec"]
    container = template["containers"][0]
    if defect == "project":
        service["metadata"]["namespace"] = "other-owner-project"
    elif defect == "missing_namespace":
        service["metadata"]["namespace"] = None
    elif defect == "image":
        container["image"] = container["image"].replace("a" * 64, "b" * 64)
    elif defect == "principal":
        template["serviceAccountName"] = "other@other-project.iam.gserviceaccount.com"
    elif defect == "duplicate":
        container["env"].append({"name": "GOOGLE_CLOUD_PROJECT", "value": "other-owner-project"})
    else:
        variable = {
            "owner": "HUSSH_ID",
            "key": "HUSSH_POD_KMS_KEY",
            "environment": "HUSHH_DEPLOY_ENV",
        }[defect]
        next(entry for entry in container["env"] if entry["name"] == variable)["value"] = "changed"
    with pytest.raises(ValueError, match="admitted authority"):
        deployment.verify_observation(service)


def test_hosted_kms_never_claims_user_owned_cloud(monkeypatch):
    from hushh_mcp.services.pod_owner_cloud import owner_cloud_provider
    from hushh_mcp.services.private_gcp_deployment import HOSTING_ENV

    deployment = _hosted_deployment()
    monkeypatch.setenv("HUSSH_POD_MODE", "true")
    monkeypatch.setenv("HUSSH_ID", deployment.owner)
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", deployment.project)
    monkeypatch.setenv("HUSSH_POD_KMS_KEY", deployment.kms_key)
    monkeypatch.setenv(HOSTING_ENV, deployment.encoded())
    assert owner_cloud_provider() is None
    monkeypatch.setenv(HOSTING_ENV, "{}")
    assert owner_cloud_provider() is None
    # Legacy owner-cloud images did not carry a marker; preserve their contract.
    monkeypatch.delenv(HOSTING_ENV)
    assert owner_cloud_provider() == "user_gcp"


async def test_hosted_rendering_never_authorizes_resource_creation(monkeypatch):
    from dataclasses import replace

    from hushh_mcp.services.hosted_gcp_backend import HostedGcpBackend
    from hushh_mcp.services.hosted_tier_guard import HostedTierNotPermittedError

    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    monkeypatch.setenv("HUSSH_HOSTED_POD_TIER_ENABLED", "true")
    monkeypatch.setenv("HUSSH_GCP_BACKEND_LIVE", "true")
    deployment = _hosted_deployment()
    backend = HostedGcpBackend(deployment=deployment)
    with pytest.raises(HostedTierNotPermittedError, match="transactional"):
        await backend.provision(
            replace(_spec(), hushh_id=deployment.owner, deployment_target="gcp")
        )


@pytest.fixture
def hosted_runtime(monkeypatch):
    from dataclasses import replace

    from hushh_mcp.managed_ai_config import load_profile
    from hushh_mcp.services.private_gcp_deployment import HOSTING_ENV

    deployment = replace(_hosted_deployment(), inference_project=load_profile("dev")["project"])
    values = {
        "HUSSH_POD_MODE": "true",
        "HUSSH_ID": deployment.owner,
        "HUSHH_DEPLOY_ENV": "dev",
        "K_SERVICE": "one-pod-hosted",
        "GOOGLE_CLOUD_PROJECT": deployment.project,
        "HUSSH_POD_KMS_KEY": deployment.kms_key,
        "POD_STORAGE_GCS_BUCKET": deployment.bucket,
        "HUSSH_POD_USER_ADC_ENABLED": "false",
        HOSTING_ENV: deployment.encoded(),
    }
    for key in (
        "HUSSH_POD_DEV_INFERENCE_BRIDGE_JSON",
        "HUSSH_POD_LOG_KEY",
        "HUSSH_POD_MEMORY_KEY",
        "HUSSH_POD_KEY_MASTER",
        "HUSSH_POD_KEY_MASTER_B64",
        "HUSSH_POD_MANAGED_MODEL_ENABLED",
        "GCE_METADATA_HOST",
        "GCE_METADATA_ROOT",
        "GCE_METADATA_IP",
    ):
        monkeypatch.delenv(key, raising=False)
    for key, value in values.items():
        monkeypatch.setenv(key, value)
    return deployment


def test_hosted_text_uses_shared_project_with_its_own_workload(monkeypatch, hosted_runtime):
    from api.routes.one.pod_turn import PodTurnRequest, _resolve_runtime_mode
    from hushh_mcp.one_adk.text_runtime import _runtime_model
    from hushh_mcp.runtime_providers.adk_model import ProviderAdkModel
    from hushh_mcp.runtime_providers.owner_gemini import _AttachedPodCredentials
    from hushh_mcp.runtime_settings import managed_ai_settings
    from hushh_mcp.services import pod_ai_selection
    from hushh_mcp.services.pod_owner_cloud import owner_cloud_agent

    monkeypatch.setattr(pod_ai_selection, "_ACTIVE", None)
    monkeypatch.setattr(pod_ai_selection, "_LOAD_FAILED", False)
    monkeypatch.setattr("google.genai.Client", lambda **kwargs: kwargs)
    monkeypatch.setenv("GEMINI_API_KEY", "synthetic-hub-key-must-not-be-used")
    assert _resolve_runtime_mode(PodTurnRequest(message="Hello"), "gemini") == "hosted_pod_adc"
    model = _runtime_model(
        runtime_model="gemini-3.7-flash", runtime_mode="hosted_pod_adc", runtime_credential=None
    )
    assert model.client_kwargs["project"] == hosted_runtime.model_project
    assert isinstance(model.client_kwargs["credentials"], _AttachedPodCredentials)
    specialist = ProviderAdkModel(
        provider="gemini", model="gemini-3.7-flash", credential="", runtime_mode="hosted_pod_adc"
    )._client()
    assert specialist["project"] == hosted_runtime.model_project
    assert isinstance(specialist["credentials"], _AttachedPodCredentials)
    assert "api_key" not in specialist
    assert managed_ai_settings().project == hosted_runtime.model_project
    assert not owner_cloud_agent()


@pytest.mark.parametrize(
    "defect", ["uat", "wrong_owner", "wrong_key", "metadata_override", "master_key"]
)
def test_hosted_model_refuses_mixed_authority(monkeypatch, hosted_runtime, defect):
    from hushh_mcp.runtime_providers.owner_gemini import build_owner_gemini_client

    changed = {
        "uat": ("HUSHH_DEPLOY_ENV", "uat"),
        "wrong_owner": ("HUSSH_ID", "other-owner"),
        "wrong_key": ("HUSSH_POD_KMS_KEY", "projects/another-owner/key"),
        "metadata_override": ("GCE_METADATA_HOST", "127.0.0.1"),
        "master_key": ("HUSSH_POD_KEY_MASTER", "synthetic-master"),
    }
    monkeypatch.setenv(*changed[defect])
    with pytest.raises(RuntimeError, match="authority"):
        build_owner_gemini_client()


def test_hosted_mode_cannot_construct_a_shared_fallback_without_assignment(monkeypatch):
    from hushh_mcp.one_adk.text_runtime import _runtime_model
    from hushh_mcp.services.private_gcp_deployment import HOSTING_ENV

    monkeypatch.delenv(HOSTING_ENV, raising=False)
    with pytest.raises(ValueError, match="authority"):
        _runtime_model(
            runtime_model="gemini-3.7-flash", runtime_mode="hosted_pod_adc", runtime_credential=None
        )


def test_hosted_native_binding_is_still_refused_outside_dev(monkeypatch, hosted_runtime):
    from dataclasses import replace

    from hushh_mcp.runtime_settings import pod_hosted_adc_enabled
    from hushh_mcp.services.private_gcp_deployment import HOSTING_ENV

    deployment = replace(
        hosted_runtime, environment="uat", inference_project=hosted_runtime.project
    )
    monkeypatch.setenv(HOSTING_ENV, deployment.encoded())
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "uat")
    with pytest.raises(RuntimeError, match="authority"):
        pod_hosted_adc_enabled()


async def test_hosted_commands_browser_and_memory_use_the_same_private_binding(
    monkeypatch, hosted_runtime
):
    from api.routes.one import pod_commands, pod_pkm_preparation
    from hushh_mcp.runtime_providers.owner_gemini import _AttachedPodCredentials
    from hushh_mcp.services import pod_ai_selection
    from hushh_mcp.services.pod_browser.owner_model import resolve_owner_browser_model

    monkeypatch.setattr(pod_ai_selection, "_ACTIVE", None)
    monkeypatch.setattr(pod_ai_selection, "_LOAD_FAILED", False)
    monkeypatch.setattr("google.genai.Client", lambda **kwargs: kwargs)
    monkeypatch.setattr(pod_commands, "LocationCommandBrain", lambda **kwargs: kwargs)

    async def admitted():
        return None

    browser = resolve_owner_browser_model(admitted)
    commands = await pod_commands._brain(
        pod_commands.CommandModel(),
        "synthetic-owner",
        "location.assess",
        {"hushh_id": hosted_runtime.owner},
    )
    for model in (browser.model, commands["adk_model"], commands["transcriber_adk_model"]):
        assert model.client_kwargs["project"] == hosted_runtime.model_project
        assert isinstance(model.client_kwargs["credentials"], _AttachedPodCredentials)
    assert commands["client"]["project"] == hosted_runtime.model_project
    memory_client = pod_pkm_preparation._owner_model()._client()
    assert memory_client["project"] == hosted_runtime.model_project
    assert isinstance(memory_client["credentials"], _AttachedPodCredentials)


def test_byoc_cannot_select_the_hosted_shared_inference_project():
    from dataclasses import replace

    from hushh_mcp.managed_ai_config import load_profile

    with pytest.raises(ValueError, match="inference project"):
        replace(
            _hosted_deployment(),
            hosting_mode="user_gcp",
            inference_project=load_profile("dev")["project"],
        ).validate()
