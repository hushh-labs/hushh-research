"""The wake path tells a GONE pod apart from a merely COLD one -- carefully.

Only a CONFIRMED gone (the Cloud Run service is truly absent) may trigger a fresh
setup, because a fresh pod is a NEW agent identity + A2A address. A transient probe
error is NOT proof of gone: it must stay `waking`, or a network blip would silently
rebuild a working user's agent. These pin exactly that asymmetry.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

import api.routes.one.pod_wake as wake
import hushh_mcp.services.compute_backend as cb

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


# -- the endpoint's confirmed-gone durable write -----------------------------------
# _host_is_gone is only half the contract; the endpoint's write branch (flip to
# needs_reinit + clear sticky auth) is what actually strands or saves a user, so it
# is pinned here at the route level.


class _Reg:
    def __init__(self, row):
        self._row = row
        self.reinit_calls = []

    async def get(self, _uid):
        return self._row

    async def mark_needs_reinit(self, user_id):
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


def test_a_raising_reinit_write_still_returns_the_gone_answer(monkeypatch):
    # The durable write is best-effort: the wake response must return regardless.
    class _RaisingReg(_Reg):
        async def mark_needs_reinit(self, user_id):
            raise RuntimeError("registry down")

    reg = _RaisingReg({"external_agent_id": "one-pod-x", "hushh_id": "ha1_test"})
    client = _wake_client(monkeypatch, reg=reg, gone=True)
    body = client.post("/api/one/pod/wake").json()
    assert body == {"state": "gone", "needsFreshSetup": True, "etaMs": 0}
