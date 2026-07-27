"""Tests for the Anypoint compute backend (enterprise lane, plan-mode, inert)."""

from __future__ import annotations

import pytest

from hushh_mcp.services.anypoint_backend import A2A_ADDRESS_BASE, AnypointBackend, _app_name
from hushh_mcp.services.compute_backend import BACKEND_ANYPOINT, ComputeBackend, PodSpec


def _spec(hushh_id: str = "HA1ABC234DEF") -> PodSpec:
    return PodSpec(
        hushh_id=hushh_id,
        phone_e164_hash="hash",
        pod_pubkey="pub",
        region="us-east-1",
        space_id="sp_1",
        runtime_version="rt1",
        prompt_version="pv1",
    )


def _backend() -> AnypointBackend:
    return AnypointBackend(base_url="https://amc.example", env_id="env-123", live=False)


def test_satisfies_protocol():
    assert isinstance(_backend(), ComputeBackend)
    assert _backend().backend_id == BACKEND_ANYPOINT


def test_app_name_is_cloudhub_safe():
    name = _app_name("HA1_ABC/xyz")
    assert name == name.lower()
    assert name.startswith("one-pod-")
    assert all(c.isalnum() or c == "-" for c in name)
    assert len(name) <= 42  # CloudHub 2.0 app-name limit


def test_render_descriptor_shape_and_no_secrets():
    cfg = _backend().render_deploy_config(_spec())
    assert cfg["name"].startswith("one-pod-")
    assert cfg["target"]["provider"] == "MC"
    assert cfg["target"]["targetId"] == "env-123"
    props = cfg["application"]["configuration"]["mule.agent.application.properties.service"][
        "properties"
    ]
    assert props["HUSSH_ID"] == "HA1ABC234DEF"
    # No secrets baked into the artifact.
    blob = str(cfg).lower()
    for forbidden in ("secret_value", "api_key", "password", "client_secret", "private"):
        assert forbidden not in blob


async def test_provision_plan_mode_handle():
    handle = await _backend().provision(_spec())
    assert handle.backend == BACKEND_ANYPOINT
    assert handle.status == "planned"
    assert handle.a2a_route == f"{A2A_ADDRESS_BASE}/HA1ABC234DEF"
    assert handle.backend_metadata["envId"] == "env-123"
    assert handle.attestation_ref is None  # no Confidential-Space equivalent


async def test_plan_mode_inert_ops():
    b = _backend()
    assert await b.deprovision("one-pod-x") is None
    assert (await b.get("one-pod-x")).healthy is True
    assert await b.health() is True


async def test_live_mode_is_gated():
    live = AnypointBackend(env_id="e", live=True)
    with pytest.raises(NotImplementedError):
        await live.provision(_spec())


def test_private_space_pins_isolation_when_configured():
    # Anypoint-primary: a Private Space isolates the per-user app's network.
    b = AnypointBackend(env_id="env-123", private_space_id="ps-abc", live=False)
    ds = b.render_deploy_config(_spec())["target"]["deploymentSettings"]
    assert ds["privateSpaceId"] == "ps-abc"


def test_private_space_omitted_when_unset():
    ds = _backend().render_deploy_config(_spec())["target"]["deploymentSettings"]
    assert "privateSpaceId" not in ds  # env default applies when unconfigured
