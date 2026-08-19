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
