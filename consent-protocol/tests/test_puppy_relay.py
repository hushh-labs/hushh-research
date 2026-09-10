"""Trust-boundary and capacity checks for the Puppy inference relay."""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import api.routes.one.puppy_relay as relay
from api.middleware import require_firebase_auth
from api.routes.one.puppy_relay import (
    BROKER,
    PuppyRelayBroker,
    _require_transport_binding,
)


class _HeadersSocket:
    def __init__(self, headers: dict[str, str]) -> None:
        self.headers = headers


class _RelaySocket:
    async def close(self, **_kwargs: object) -> None:
        return None


def test_transport_binding_requires_declared_role_and_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    socket = _HeadersSocket(
        {
            "x-hussh-relay-role": "pod",
            "x-hussh-deploy-env": "dev",
        }
    )

    assert _require_transport_binding(socket, "pod") is True
    assert _require_transport_binding(socket, "device") is False
    assert (
        _require_transport_binding(
            _HeadersSocket(
                {
                    "x-hussh-relay-role": "pod",
                    "x-hussh-deploy-env": "uat",
                }
            ),
            "pod",
        )
        is False
    )


@pytest.mark.asyncio
async def test_local_broker_fences_replaced_device_and_reports_busy() -> None:
    broker = PuppyRelayBroker()
    first = _RelaySocket()
    second = _RelaySocket()

    first_link = await broker.register(("owner-a", "device-a"), first)  # type: ignore[arg-type]
    first_link.busy_request_id = "request-1"
    second_link = await broker.register(("owner-a", "device-a"), second)  # type: ignore[arg-type]

    assert second_link.generation > first_link.generation
    status = await broker.status(("owner-a", "device-a"))
    assert status["connected"] is True
    assert status["busy"] is False
    assert status["generation"] == second_link.generation


def test_rendezvous_key_is_not_identity_or_prompt_material(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("PUPPY_RELAY_RENDEZVOUS_URL", raising=False)
    key = PuppyRelayBroker._key(("owner@example.test", "device-123"))

    assert key.startswith("hushh:puppy-relay:v1:")
    assert "owner@example.test" not in key
    assert "device-123" not in key


def test_rendezvous_never_reuses_rate_limit_store(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("PUPPY_RELAY_RENDEZVOUS_URL", raising=False)
    monkeypatch.setenv("RATE_LIMIT_STORAGE_URI", "redis://rate-limit.example/0")

    assert PuppyRelayBroker._rendezvous_url() == ""


@pytest.mark.asyncio
async def test_global_broker_status_is_offline_without_local_or_rendezvous(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("PUPPY_RELAY_RENDEZVOUS_URL", raising=False)
    monkeypatch.delenv("RATE_LIMIT_STORAGE_URI", raising=False)

    status = await BROKER.status(("missing-owner", "missing-device"))

    assert status == {
        "connected": False,
        "state": "offline",
        "busy": False,
        "generation": None,
    }


def test_status_route_preserves_busy_and_revoked_states(monkeypatch: pytest.MonkeyPatch) -> None:
    class _Devices:
        def device_status(self, *, user_id: str, device_id: str) -> dict[str, str]:
            return {
                "device_id": device_id,
                "status": "active" if user_id == "owner-a" else "revoked",
            }

    app = FastAPI()
    app.include_router(relay.router)
    app.dependency_overrides[require_firebase_auth] = lambda: "owner-a"
    monkeypatch.setattr(relay, "TrustedDeviceService", _Devices)

    async def _busy(_key: tuple[str, str]) -> dict[str, object]:
        return {"connected": True, "state": "busy", "busy": True, "generation": 4}

    monkeypatch.setattr(relay.BROKER, "status", _busy)
    response = TestClient(app).get("/api/one/puppy/status/device-a")

    assert response.status_code == 200
    assert response.json()["state"] == "busy"
    assert response.json()["inference_ready"] is False

    app.dependency_overrides[require_firebase_auth] = lambda: "owner-b"
    response = TestClient(app).get("/api/one/puppy/status/device-a")
    assert response.json()["state"] == "revoked"
    assert response.json()["execution_target"] == "unavailable"
