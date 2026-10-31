"""A user-owned pod resolves Vertex against the USER's project. Always.

This test existed once and is gone from the tree -- only
``tests/__pycache__/test_user_gcp_model_access_boundary.cpython-313-pytest-9.0.3.pyc``
survives, and nothing present enforced the boundary it asserted. It is restored here
because the boundary is the whole point of the BYO GCP tier, and because the defect it
guards is live in the renderer right now.

The managed renderer resolves the Vertex address as
``_env("HUSSH_POD_VERTEX_PROJECT") or self._project`` (gcp_backend.py:372) -- the HUB's
environment wins. ``UserGcpBackend`` inherits the managed config and filters it, so
before this change a user-owned pod could be rendered running as the USER's service
account while ``GOOGLE_CLOUD_PROJECT`` pointed at HUSHH's project. That is a
cross-tenant address, and it is backwards for the one tier whose entire claim is that
the compute and the model access belong to the person.

It was latent rather than exploited only because ``HUSSH_POD_VERTEX_PROJECT`` happens
to be unset on the dev hub (verified against the serving revision, 2026-08-12), so the
fallback landed on the right project by luck. The day the managed tier sets it -- which
is exactly what it is for -- every BYOC pod silently re-points. A boundary that holds
only while an unrelated variable stays unset is not a boundary.

This also underwrites the product rule that a BYO GCP person needs no separate AI
connection: their pod's native ADC is theirs precisely because these two variables name
their project.
"""

from __future__ import annotations

import base64
import json

import pytest

from hushh_mcp.services.compute_backend import PodSpec
from hushh_mcp.services.user_gcp_backend import UserGcpBackend

USER_PROJECT = "a-real-persons-project"
HUSHH_PROJECT = "hushh-pda-dev"


def _spec() -> PodSpec:
    return PodSpec(
        hushh_id="boundaryuser",
        phone_e164_hash="0" * 64,
        pod_pubkey=base64.b64encode(b"\x00" * 32).decode(),
        region="us-central1",
    )


def _env_entries(cfg: dict, name: str) -> list[str]:
    """Every entry for a name, not a dict.

    Building a dict here is how the first version of this test passed while the code
    was broken: the renderer APPENDED the user's project without removing the hub's, so
    the body carried two GOOGLE_CLOUD_PROJECT entries and last-write-wins in Python
    hid it. A Knative env list with duplicate names is undefined -- the platform is
    free to take either -- so the count is part of the assertion, not a detail.
    """
    container = cfg["spec"]["template"]["spec"]["containers"][0]
    return [e.get("value", "") for e in container.get("env", []) if e["name"] == name]


def _env_of(cfg: dict) -> dict[str, str]:
    container = cfg["spec"]["template"]["spec"]["containers"][0]
    return {e["name"]: e.get("value", "") for e in container.get("env", []) if "value" in e}


def test_byoc_upgrade_retains_existing_custom_custody_without_new_hosting_marker(monkeypatch):
    from copy import deepcopy

    from hushh_mcp.runtime_settings import managed_ai_settings
    from hushh_mcp.services.pod_owner_cloud import owner_cloud_provider
    from hushh_mcp.services.pod_upgrade_configuration import preserve_image_upgrade_configuration
    from hushh_mcp.services.private_gcp_deployment import HOSTING_ENV

    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    monkeypatch.setenv("HUSSH_POD_MODE", "true")
    monkeypatch.delenv("HUSSH_POD_KEY_VAULT_KEY", raising=False)
    backend = UserGcpBackend(
        user_project=USER_PROJECT,
        hushh_invoker_sa="consent-plane@hushh-pda-dev.iam.gserviceaccount.com",
    )
    old = backend.render_deploy_config(_spec(), image_digest="sha256:" + "a" * 64)
    old_env = old["spec"]["template"]["spec"]["containers"][0]["env"]
    retained_key = (
        f"projects/{USER_PROJECT}/locations/us-central1/keyRings/owner-selected/cryptoKeys/recovery"
    )
    next(e for e in old_env if e["name"] == "HUSSH_POD_KMS_KEY")["value"] = retained_key
    desired = backend.render_deploy_config(_spec(), image_digest="sha256:" + "b" * 64)
    observed = deepcopy(old)
    preserve_image_upgrade_configuration(old, desired)
    assert old == observed
    installed = _env_of(desired)
    assert installed["HUSSH_POD_KMS_KEY"] == retained_key
    assert HOSTING_ENV not in installed
    monkeypatch.delenv(HOSTING_ENV, raising=False)
    for key, value in installed.items():
        monkeypatch.setenv(key, value)
    assert owner_cloud_provider() == "user_gcp"
    assert managed_ai_settings().project == USER_PROJECT


def test_vertex_project_is_the_users_even_when_the_hub_names_its_own(monkeypatch) -> None:
    """The regression. Set the hub's Vertex project and it must not reach the pod."""
    monkeypatch.setenv("HUSSH_POD_VERTEX_PROJECT", HUSHH_PROJECT)
    monkeypatch.setenv("HUSSH_POD_VERTEX_LOCATION", "europe-west4")

    cfg = UserGcpBackend(user_project=USER_PROJECT, live=False).render_deploy_config(_spec())
    entries = _env_entries(cfg, "GOOGLE_CLOUD_PROJECT")

    assert entries == [USER_PROJECT], (
        "a user-owned pod must carry exactly one Vertex project and it must be the "
        f"user's. Got {entries!r}. Two entries means the hub's value was appended to "
        "rather than replaced, and which one Cloud Run honours is undefined -- the pod "
        "runs as the user's service account, so the hub's project is cross-tenant."
    )
    assert HUSHH_PROJECT not in entries


def test_browser_configuration_approval_repairs_only_the_exact_dev_bridge(monkeypatch):
    monkeypatch.setenv("APP_FRONTEND_ORIGIN", "https://dev.one.hussh.si")
    from copy import deepcopy

    from hushh_mcp.services.pod_browser.capability_update import (
        GcpBrowserCapabilityPlan,
        commitment,
        plan_from_observation,
    )
    from hushh_mcp.services.pod_browser.update_offer import public_browser_offer
    from hushh_mcp.services.pod_inference_bridge import BRIDGE_ENV, BRIDGE_PROJECT
    from tests.helpers.pod_browser_capability import browser_capability_fixture

    row, image, existing, qualification, _ = browser_capability_fixture()
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    monkeypatch.delenv(BRIDGE_ENV, raising=False)
    monkeypatch.delenv("BACKEND_RUNTIME_CONFIG_JSON", raising=False)
    previous = plan_from_observation(row, image, existing, qualification)
    assert previous.digest == commitment(
        previous.model_dump(mode="json", exclude_none=True, exclude={"devInferenceBridge"})
    )
    bridge = {"project": BRIDGE_PROJECT, "serviceAccount": previous.runtimeAccount}
    monkeypatch.setenv(BRIDGE_ENV, json.dumps(bridge))
    approved = plan_from_observation(row, image, existing, qualification)
    assert approved.digest != previous.digest
    assert BRIDGE_PROJECT in " ".join(public_browser_offer(approved, qualification)["changes"])
    installed = deepcopy(existing)
    container = installed["spec"]["template"]["spec"]["containers"][0]
    container["env"].append(
        {"name": "HUSSH_BROWSER_QUALIFICATION_JSON", "value": json.dumps(qualification)}
    )
    approved.apply_configuration(existing, installed, qualification)
    assert json.loads(_env_of(installed)[BRIDGE_ENV]) == bridge
    approved.require_installed(installed)
    with pytest.raises(ValueError, match="inference policy"):
        previous.require_installed(installed)
    for changed in (
        {"project": "unapproved-project"},
        {"serviceAccount": "other@owner-project.iam.gserviceaccount.com"},
    ):
        with pytest.raises(ValueError):
            GcpBrowserCapabilityPlan.model_validate(
                {**approved.model_dump(), "devInferenceBridge": {**bridge, **changed}}
            )
    container["env"] = [entry for entry in container["env"] if entry["name"] != BRIDGE_ENV]
    with pytest.raises(ValueError, match="installed configuration"):
        approved.require_installed(installed)
    conflicting = deepcopy(existing)
    conflicting["spec"]["template"]["spec"]["containers"][0]["env"].append(
        {"name": BRIDGE_ENV, "value": json.dumps({**bridge, "project": "unapproved-project"})}
    )
    with pytest.raises(ValueError):
        plan_from_observation(row, image, conflicting, qualification)
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "prod")
    with pytest.raises(ValueError, match="bridge"):
        approved.apply_configuration(existing, installed, qualification)


def test_vertex_project_is_the_users_when_the_hub_names_nothing(monkeypatch) -> None:
    """The state dev is actually in. Correct here by fallback; must be correct by rule."""
    monkeypatch.delenv("HUSSH_POD_VERTEX_PROJECT", raising=False)
    monkeypatch.delenv("HUSSH_POD_VERTEX_LOCATION", raising=False)

    env = _env_of(
        UserGcpBackend(user_project=USER_PROJECT, live=False).render_deploy_config(_spec())
    )

    assert env.get("GOOGLE_CLOUD_PROJECT") == USER_PROJECT


def test_vertex_location_follows_the_model_not_the_hub(monkeypatch) -> None:
    """The location is half the address; a right project in a wrong region still fails.

    Two distinct wrong answers are ruled out here, and only the first was before.

    1. The HUB's location must not leak into the pod. That is what setting
       ``HUSSH_POD_VERTEX_LOCATION`` below probes, and it is the boundary this module
       exists for.
    2. The pod's own Cloud Run REGION is equally wrong, and it is the answer the
       renderer used to give. A Vertex location and a Cloud Run region are unrelated
       facts that happened to share a variable: the default model is declared
       ``("global",)`` in the provider registry, so a pod addressed at ``us-central1``
       404s on its first turn and surfaces as the same opaque error every other turn
       failure produces.

    The previous assertion pinned the literal ``us-central1``, which made the second
    wrong answer the expected one. It passed for the whole time the defect was live,
    which is the shape this file's own docstring warns about: a boundary that holds by
    coincidence is not a boundary.
    """
    from hushh_mcp.constants import GEMINI_MODEL
    from hushh_mcp.runtime_providers.registry import resolve_model_entry

    monkeypatch.setenv("HUSSH_POD_VERTEX_LOCATION", "europe-west4")

    env = _env_of(
        UserGcpBackend(user_project=USER_PROJECT, live=False).render_deploy_config(_spec())
    )

    location = env.get("GOOGLE_CLOUD_LOCATION")
    assert location != "europe-west4", "the hub's Vertex location leaked into the pod"
    supported = resolve_model_entry("gemini", GEMINI_MODEL).supported_vertex_locations
    assert location in supported, (
        f"the pod addresses Vertex at {location!r}, which does not serve {GEMINI_MODEL}. "
        f"Declared locations: {supported}"
    )


def test_vertex_is_still_addressed_at_all(monkeypatch) -> None:
    """Stripping the hub's value must not leave the pod with no Vertex address.

    Deleting the variables would also pass the assertions above by making them vacuous,
    which is the failure mode this test exists to rule out: the pod needs a real
    address, it just needs the person's own.
    """
    monkeypatch.setenv("HUSSH_POD_VERTEX_PROJECT", HUSHH_PROJECT)

    env = _env_of(
        UserGcpBackend(user_project=USER_PROJECT, live=False).render_deploy_config(_spec())
    )

    assert env.get("GOOGLE_CLOUD_PROJECT"), "the pod has no Vertex project at all"
    assert env.get("GOOGLE_CLOUD_LOCATION"), "the pod has no Vertex location at all"
    assert env.get("GOOGLE_GENAI_USE_VERTEXAI") == "true"


@pytest.mark.parametrize("defect", [None, "identity", "kms", "project", "azure", "hub"])
def test_hosted_owner_adc_uses_rendered_custody_without_cross_project_override(monkeypatch, defect):
    from hushh_mcp.runtime_providers.factory import ManagedGeminiRuntimeBinding

    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    monkeypatch.setenv("HUSSH_POD_MODE", "true")
    monkeypatch.delenv("BACKEND_RUNTIME_CONFIG_JSON", raising=False)
    monkeypatch.delenv("HUSSH_POD_KEY_VAULT_KEY", raising=False)
    for key, value in _env_of(
        UserGcpBackend(user_project=USER_PROJECT, live=False).render_deploy_config(_spec())
    ).items():
        monkeypatch.setenv(key, value)
    if defect == "identity":
        monkeypatch.delenv("HUSSH_ID")
    if defect == "kms":
        monkeypatch.setenv("HUSSH_POD_KMS_KEY", "not-a-resource")
    if defect == "project":
        monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", HUSHH_PROJECT)
    if defect == "azure":
        monkeypatch.setenv(
            "HUSSH_POD_KEY_VAULT_KEY", "https://synthetic.vault.azure.net/keys/key/1"
        )
    if defect == "hub":
        monkeypatch.setenv("HUSSH_POD_MODE", "false")
    if defect:
        with pytest.raises(RuntimeError, match="Owner ADC topology"):
            ManagedGeminiRuntimeBinding.from_environment()
    else:
        assert ManagedGeminiRuntimeBinding.from_environment().project == USER_PROJECT
        with pytest.raises(ValueError, match="central configuration"):
            ManagedGeminiRuntimeBinding.from_environment(vertex_project=HUSHH_PROJECT)


@pytest.fixture
def approved_bridge(monkeypatch):
    from hushh_mcp.services.pod_inference_bridge import BRIDGE_ENV, BRIDGE_PROJECT
    from hushh_mcp.services.user_gcp_backend import pod_service_account_id

    identity = f"{pod_service_account_id(_spec().hushh_id)}@{USER_PROJECT}.iam.gserviceaccount.com"
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    monkeypatch.setenv("HUSSH_POD_MODE", "true")
    monkeypatch.setenv("K_SERVICE", "synthetic-owner-pod")
    monkeypatch.delenv("BACKEND_RUNTIME_CONFIG_JSON", raising=False)
    monkeypatch.delenv("HUSSH_POD_KEY_VAULT_KEY", raising=False)
    monkeypatch.setenv(
        BRIDGE_ENV, json.dumps({"project": BRIDGE_PROJECT, "serviceAccount": identity})
    )
    # Exercise the governed backend configuration hydration used by rendering;
    # direct env ownership is registered with monkeypatch for complete teardown.
    monkeypatch.setenv(
        "BACKEND_RUNTIME_CONFIG_JSON",
        json.dumps(
            {
                "pod_dev_inference_bridge_json": json.dumps(
                    {"project": BRIDGE_PROJECT, "serviceAccount": identity}
                )
            }
        ),
    )
    monkeypatch.delenv(BRIDGE_ENV)
    for key, value in _env_of(
        UserGcpBackend(user_project=USER_PROJECT, live=False).render_deploy_config(_spec())
    ).items():
        monkeypatch.setenv(key, value)
    return identity


async def test_dev_bridge_serves_chat_browser_and_recorded_commands_only(
    monkeypatch, approved_bridge
):
    from api.routes.one import pod_commands
    from hushh_mcp.one_adk.text_runtime import _runtime_model
    from hushh_mcp.runtime_providers import factory
    from hushh_mcp.runtime_providers.adk_model import ProviderAdkModel
    from hushh_mcp.runtime_providers.owner_gemini import _AttachedPodCredentials
    from hushh_mcp.runtime_settings import managed_ai_settings
    from hushh_mcp.services import pod_ai_selection
    from hushh_mcp.services.pod_browser.owner_model import resolve_owner_browser_model
    from hushh_mcp.services.pod_inference_bridge import BRIDGE_PROJECT

    monkeypatch.setattr(pod_ai_selection, "_ACTIVE", None)
    monkeypatch.setattr(pod_ai_selection, "_LOAD_FAILED", False)
    monkeypatch.setenv("GEMINI_API_KEY", "synthetic-ambient-key-must-not-be-used")
    monkeypatch.setattr("google.genai.Client", lambda **kwargs: kwargs)
    monkeypatch.setattr(pod_commands, "LocationCommandBrain", lambda **kwargs: kwargs)

    async def admitted():
        return None

    chat = _runtime_model(
        runtime_model="gemini-3.8-flash", runtime_mode="user_adc", runtime_credential=None
    )
    browser = resolve_owner_browser_model(admitted)
    commands = await pod_commands._brain(
        pod_commands.CommandModel(),
        "synthetic-owner",
        "location.assess",
        {"hushh_id": _spec().hushh_id},
    )
    for model in (chat, browser.model, commands["adk_model"], commands["transcriber_adk_model"]):
        assert model.client_kwargs["project"] == BRIDGE_PROJECT
        assert model.client_kwargs["location"] == "global"
        assert isinstance(model.client_kwargs["credentials"], _AttachedPodCredentials)
        assert "api_key" not in model.client_kwargs
    assert commands["client"]["project"] == BRIDGE_PROJECT
    assert isinstance(commands["client"]["credentials"], _AttachedPodCredentials)
    specialist = ProviderAdkModel(
        provider="gemini", model="gemini-3.8-flash", credential="", runtime_mode="user_adc"
    )._client()
    assert specialist["project"] == BRIDGE_PROJECT
    assert isinstance(specialist["credentials"], _AttachedPodCredentials)
    assert managed_ai_settings().project == USER_PROJECT
    assert factory.ManagedGeminiRuntimeBinding.from_environment().project == USER_PROJECT
    assert factory.build_managed_runtime_client("gemini")["project"] == USER_PROJECT
    assert factory.build_runtime_client("gemini", "synthetic-owner-key") == {
        "vertexai": False,
        "api_key": "synthetic-owner-key",
    }


async def test_cloud_default_verification_uses_the_same_approved_bridge(
    monkeypatch, approved_bridge
):
    from types import SimpleNamespace

    from hushh_mcp.services.pod_ai_selection_check import verify_cloud_default
    from hushh_mcp.services.pod_inference_bridge import BRIDGE_PROJECT

    used = []

    async def answer(**kwargs):
        used.append(kwargs["model"])
        return SimpleNamespace(text="OK")

    def client(**kwargs):
        used.append(kwargs["project"])
        return SimpleNamespace(aio=SimpleNamespace(models=SimpleNamespace(generate_content=answer)))

    monkeypatch.setattr("google.genai.Client", client)
    result = await verify_cloud_default(gemini_default="gemini-3.8-flash")
    assert result["defaultProvider"] == "gemini"
    assert used == [BRIDGE_PROJECT, "gemini-3.8-flash"]


@pytest.mark.parametrize(
    "defect",
    [
        "production",
        "uat",
        "owner",
        "custody",
        "hub",
        "azure",
        "adc",
        "metadata",
        "project",
        "partial",
    ],
)
def test_dev_bridge_refuses_invalid_authority(monkeypatch, approved_bridge, defect):
    from hushh_mcp.runtime_providers.owner_gemini import build_owner_gemini_client
    from hushh_mcp.services.pod_inference_bridge import BRIDGE_ENV

    changes = {
        "production": ("HUSHH_DEPLOY_ENV", "production"),
        "uat": ("HUSHH_DEPLOY_ENV", "uat"),
        "owner": ("HUSSH_ID", "another-owner"),
        "custody": ("GOOGLE_CLOUD_PROJECT", "another-project"),
        "hub": ("HUSSH_POD_MODE", "false"),
        "azure": ("HUSSH_POD_KEY_VAULT_KEY", "https://synthetic.vault.azure.net/keys/key/1"),
        "adc": ("HUSSH_POD_USER_ADC_ENABLED", "false"),
        "metadata": ("GCE_METADATA_HOST", "unapproved.test"),
        "project": (
            BRIDGE_ENV,
            json.dumps({"project": "other-bridge", "serviceAccount": approved_bridge}),
        ),
        "partial": (BRIDGE_ENV, "{}"),
    }
    name, value = changes[defect]
    monkeypatch.setenv(name, value)
    with pytest.raises(RuntimeError):
        build_owner_gemini_client()


def test_bridge_refresh_checks_actual_identity_and_never_exposes_a_mismatched_token(
    monkeypatch, approved_bridge
):
    from datetime import datetime, timedelta

    from google.auth.compute_engine import _metadata
    from google.auth.exceptions import RefreshError

    from hushh_mcp.runtime_providers.owner_gemini import _AttachedPodCredentials

    actual = approved_bridge
    monkeypatch.setattr(
        _metadata,
        "get_service_account_info",
        lambda *a, **k: {
            "email": actual,
            "scopes": ["https://www.googleapis.com/auth/cloud-platform"],
        },
    )
    monkeypatch.setattr(
        _metadata,
        "get_service_account_token",
        lambda *a, **k: ("synthetic-attached-token", datetime.now() + timedelta(minutes=30)),
    )
    credentials = _AttachedPodCredentials(approved_bridge)
    credentials.refresh(object())
    assert credentials.token == "synthetic-attached-token"
    actual = "other@other-project.iam.gserviceaccount.com"
    with pytest.raises(RefreshError, match="Approved pod workload identity"):
        credentials.refresh(object())
    assert credentials.token is None and credentials.expiry is None


def test_bridge_render_does_not_authorize_sibling_pods(monkeypatch, approved_bridge):
    from dataclasses import replace

    from hushh_mcp.services.pod_inference_bridge import BRIDGE_ENV

    cfg = UserGcpBackend(user_project=USER_PROJECT, live=False).render_deploy_config(
        replace(_spec(), hushh_id="another-owner")
    )
    assert _env_entries(cfg, BRIDGE_ENV) == []
    assert _env_entries(cfg, "GOOGLE_CLOUD_PROJECT") == [USER_PROJECT]
