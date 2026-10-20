"""The wake path tells a GONE pod apart from a merely COLD one -- carefully.

Only a CONFIRMED gone (the Cloud Run service is truly absent) may trigger a fresh
setup, because a fresh pod is a NEW agent identity + A2A address. A transient probe
error is NOT proof of gone: it must stay `waking`, or a network blip would silently
rebuild a working user's agent. These pin exactly that asymmetry.
"""

from __future__ import annotations

from copy import deepcopy
from types import SimpleNamespace

import pytest

import api.routes.one.pod_wake as wake
import hushh_mcp.services.compute_backend as cb
from tests.test_azure_vm_power import setup as setup

_ROW = {"external_agent_id": "one-pod-x", "hushh_id": "ha1_test"}


def _backend_returning(status: str):
    class _Backend:
        async def get(self, external_agent_id):
            return SimpleNamespace(status=status, healthy=False)

    return lambda spec: _Backend()


@pytest.mark.asyncio
async def test_gone_when_service_is_deleted(monkeypatch):
    monkeypatch.setattr(cb, "resolve_compute_backend_for_spec", _backend_returning("gone"))
    assert await wake._host_is_gone(_ROW) is True


@pytest.mark.asyncio
async def test_not_gone_when_cold_not_ready(monkeypatch):
    # A scaled-to-zero pod that is booting is `not_ready`, not gone -- it must wake.
    monkeypatch.setattr(cb, "resolve_compute_backend_for_spec", _backend_returning("not_ready"))
    assert await wake._host_is_gone(_ROW) is False


@pytest.mark.asyncio
async def test_not_gone_on_a_transient_probe_error(monkeypatch):
    # The safety property: uncertainty is NOT gone. A blip must never rebuild an agent.
    def _boom(spec):
        raise RuntimeError("backend unreachable right now")

    monkeypatch.setattr(cb, "resolve_compute_backend_for_spec", _boom)
    assert await wake._host_is_gone(_ROW) is False


@pytest.mark.asyncio
async def test_not_gone_without_a_recorded_host():
    # No external_agent_id -> nothing to be gone; never probe, never fresh-setup.
    assert await wake._host_is_gone({"hushh_id": "ha1_test"}) is False


@pytest.mark.parametrize("outcome", ["gone", "deploying", "forbidden"])
async def test_azure_absence_check_uses_the_recorded_owner_coordinates(monkeypatch, outcome):
    row = {
        **_ROW,
        "deployment_target": "user_azure",
        "user_cloud_tenant_id": "tenant",
        "user_cloud_subscription_id": "subscription",
        "user_cloud_resource_group": "owner-group",
        "user_cloud_region": "westus2",
    }
    observed = []

    class Backend:
        async def get(self, service):
            assert service == row["external_agent_id"]
            if outcome == "forbidden":
                raise PermissionError("read denied")
            return SimpleNamespace(status=outcome)

    def resolve(spec):
        assert (
            spec.user_cloud_tenant_id,
            spec.user_cloud_subscription_id,
            spec.user_cloud_resource_group,
            spec.user_cloud_region,
        ) == ("tenant", "subscription", "owner-group", "westus2")
        observed.append(spec)
        return Backend()

    monkeypatch.setattr(cb, "resolve_compute_backend_for_spec", resolve)
    assert await wake._host_is_gone(row) is (outcome == "gone")
    assert len(observed) == 1


# -- the endpoint's confirmed-gone durable write -----------------------------------
# _host_is_gone is only half the contract; the endpoint's write branch (flip to
# needs_reinit + clear sticky auth) is what actually strands or saves a user, so it
# is pinned here at the route level.


class _Reg:
    def __init__(self, row):
        self._row = row
        self.reinit_calls = []

    async def get(self, _uid):
        return deepcopy(self._row)

    async def mark_needs_reinit(self, user_id, *, observed):
        self.reinit_calls.append(user_id)
        return True


def _wake_client(monkeypatch, *, reg, gone, gate=True):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    import hushh_mcp.runtime_settings as rs
    from api.middleware import require_firebase_auth

    monkeypatch.setattr(wake, "_require_enabled", lambda: None)
    monkeypatch.setattr(wake, "PersonalAgentRegistryRepo", lambda: reg)
    monkeypatch.setattr(wake, "_pod_url", lambda _row: "https://pod.example")

    async def _proxy_get(_url, _path):
        return 503, {}

    async def _host_is_gone(_row):
        return gone

    monkeypatch.setattr(wake, "_proxy_get", _proxy_get)
    monkeypatch.setattr(wake, "_host_is_gone", _host_is_gone)
    monkeypatch.setattr(rs, "personal_agent_reachability_gate", lambda: gate)

    app = FastAPI()
    app.include_router(wake.router)
    app.dependency_overrides[require_firebase_auth] = lambda: "uid1"
    return TestClient(app)


@pytest.mark.parametrize("active", [False, True])
def test_vm_wake_never_routes_through_container_apps(monkeypatch, setup, active):
    from unittest.mock import AsyncMock

    from hushh_mcp.services import azure_vm_lifecycle
    from hushh_mcp.services.azure_vm_power import AzureVmPowerRefused

    installation = setup[0].installation
    row = {
        **_ROW,
        "backend_metadata": {
            "hostKind": "azure_vm",
            "vmHost": {"installation": installation.model_dump()},
        },
    }
    reg = _Reg(row)
    client = _wake_client(monkeypatch, reg=reg, gone=True)

    async def forbidden_probe(*args):
        pytest.fail("VM attempted an ACA/health probe")

    run = AsyncMock(return_value={"state": "awake", "etaMs": 0})
    if active:
        run.side_effect = AzureVmPowerRefused("VM_POWER_WORKER_ACTIVE")
    monkeypatch.setattr(azure_vm_lifecycle, "run_vm_lifecycle", run)
    monkeypatch.setattr(wake, "_proxy_get", forbidden_probe)
    monkeypatch.setattr(wake, "_host_is_gone", forbidden_probe)
    result = client.post("/api/one/pod/wake")
    assert result.status_code == 200
    assert result.json()["state"] == ("waking" if active else "awake")
    run.assert_awaited_once_with(owner="uid1", expected_vm_id=installation.vm_id, action="wake")
    assert reg.reinit_calls == []


def test_confirmed_gone_writes_needs_reinit_exactly_once(monkeypatch):
    reg = _Reg({"external_agent_id": "one-pod-x", "hushh_id": "ha1_test"})
    client = _wake_client(monkeypatch, reg=reg, gone=True)
    body = client.post("/api/one/pod/wake").json()
    assert body == {"state": "gone", "needsFreshSetup": True, "etaMs": 0}
    assert reg.reinit_calls == ["uid1"]  # the confirmed-gone verdict is recorded once


def test_cold_or_uncertain_wake_writes_nothing(monkeypatch):
    # A non-gone probe is `waking`; it must NEVER clear a working agent's authorization.
    reg = _Reg({"external_agent_id": "one-pod-x", "hushh_id": "ha1_test"})
    client = _wake_client(monkeypatch, reg=reg, gone=False)
    body = client.post("/api/one/pod/wake").json()
    assert body["state"] == "waking"
    assert reg.reinit_calls == []


def test_a_raising_reinit_write_returns_unavailable_without_fresh_setup(monkeypatch):
    class _RaisingReg(_Reg):
        async def mark_needs_reinit(self, user_id, *, observed):
            raise RuntimeError("registry down")

    reg = _RaisingReg({"external_agent_id": "one-pod-x", "hushh_id": "ha1_test"})
    client = _wake_client(monkeypatch, reg=reg, gone=True)
    response = client.post("/api/one/pod/wake")
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "POD_STATUS_UNAVAILABLE"
    assert "needsFreshSetup" not in response.text
