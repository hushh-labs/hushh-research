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


# -- Lane B2: what the device declares about itself is validated, stored and shown --


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("qwen3-30b-a3b-mlx", "qwen3-30b-a3b-mlx"),
        ("  mlx-community/Qwen3-30B  ", "mlx-community/Qwen3-30B"),
        ("http://127.0.0.1:1234/v1", ""),
        ("/Users/someone/models/local", ""),
        ("two words", ""),
        ("x" * 129, ""),
        ("", ""),
        (None, ""),
        (42, ""),
    ],
)
def test_declared_model_admits_ids_and_refuses_endpoints_paths_and_prose(raw, expected) -> None:
    assert relay._declared_model(raw) == expected


def test_declared_capabilities_are_allowlisted_and_bool_only() -> None:
    declared = relay._declared_capabilities(
        {
            "tool_calling": True,
            "json_schema": False,
            "streaming": True,
            "shell": True,  # not a capability a device may claim here
            "tool_calling_extra": "yes",  # not bool, not allowlisted
        }
    )
    assert declared == {"tool_calling": True, "json_schema": False, "streaming": True}
    assert relay._declared_capabilities({"tool_calling": "true"}) == {}
    assert relay._declared_capabilities("tool_calling") == {}
    assert relay._declared_capabilities(None) == {}


@pytest.mark.asyncio
async def test_the_broker_stores_the_declaration_and_exposes_it_on_status() -> None:
    broker = PuppyRelayBroker()
    link = await broker.register(
        ("owner-a", "device-a"),
        _RelaySocket(),  # type: ignore[arg-type]
        model="qwen3-30b-a3b-mlx",
        capabilities={"tool_calling": True, "json_schema": False, "bogus": True},
        probe_mode="puppy-inference-relay/openai_chat_completions/effort=none/max_tokens=512",
    )
    assert link.model == "qwen3-30b-a3b-mlx"
    assert link.capabilities == {"tool_calling": True, "json_schema": False}
    status = await broker.status(("owner-a", "device-a"))
    assert status["model"] == "qwen3-30b-a3b-mlx"
    assert status["capabilities"] == {"tool_calling": True, "json_schema": False}
    assert status["probe_mode"].startswith("puppy-inference-relay/")
    assert link.declaration() == {
        "model": "qwen3-30b-a3b-mlx",
        "capabilities": {"tool_calling": True, "json_schema": False},
        "probe_mode": "puppy-inference-relay/openai_chat_completions/effort=none/max_tokens=512",
    }


@pytest.mark.asyncio
async def test_a_silent_device_declares_nothing_negative_control() -> None:
    """Older devices send a bare hello. The pod's ready frame must stay bare too,
    so the transport's legacy path (device is the only judge) is what runs."""
    broker = PuppyRelayBroker()
    link = await broker.register(("owner-a", "device-a"), _RelaySocket())  # type: ignore[arg-type]
    assert link.model == "" and link.capabilities == {}
    assert link.declaration() is None
    status = await broker.status(("owner-a", "device-a"))
    assert status["model"] == "" and status["capabilities"] == {}


@pytest.mark.asyncio
async def test_an_endpoint_offered_as_a_model_is_dropped_at_registration() -> None:
    broker = PuppyRelayBroker()
    link = await broker.register(
        ("owner-a", "device-a"),
        _RelaySocket(),  # type: ignore[arg-type]
        model="http://127.0.0.1:1234/v1",
        capabilities={"tool_calling": True},
    )
    assert link.model == ""
    assert link.declaration() == {"model": "", "capabilities": {"tool_calling": True}}


def test_status_route_passes_the_declared_model_through(monkeypatch: pytest.MonkeyPatch) -> None:
    class _Devices:
        def device_status(self, *, user_id: str, device_id: str) -> dict[str, str]:
            return {"device_id": device_id, "status": "active"}

    app = FastAPI()
    app.include_router(relay.router)
    app.dependency_overrides[require_firebase_auth] = lambda: "owner-a"
    monkeypatch.setattr(relay, "TrustedDeviceService", _Devices)

    async def _ready(_key: tuple[str, str]) -> dict[str, object]:
        return {
            "connected": True,
            "state": "ready",
            "busy": False,
            "generation": 4,
            "model": "qwen3-30b-a3b-mlx",
            "capabilities": {"tool_calling": True},
            "probe_mode": "",
        }

    monkeypatch.setattr(relay.BROKER, "status", _ready)
    body = TestClient(app).get("/api/one/puppy/status/device-a").json()
    assert body["inference_ready"] is True
    assert body["relay"]["model"] == "qwen3-30b-a3b-mlx"
    assert body["relay"]["capabilities"] == {"tool_calling": True}


# -- the two hub defects fixed for UAT and production (Lane A) -------------------------


class _FakeWebSocket:
    """Enough of a WebSocket for the loops: scripted inbound text, recorded outbound."""

    def __init__(self, inbound: list, *, on_receive=None) -> None:
        import json as _json

        self._json = _json
        self._inbound = list(inbound)
        self._on_receive = on_receive
        self.sent: list[dict] = []
        self.closed: list[tuple[int, str]] = []

    async def receive_text(self) -> str:
        from fastapi import WebSocketDisconnect

        if self._on_receive is not None:
            await self._on_receive()
        if not self._inbound:
            raise WebSocketDisconnect(1000)
        return self._json.dumps(self._inbound.pop(0))

    async def send_json(self, frame: dict) -> None:
        self.sent.append(frame)

    async def close(self, code: int = 1000, reason: str = "") -> None:
        self.closed.append((code, reason))


@pytest.mark.asyncio
async def test_a_device_that_sends_an_inference_request_is_disconnected_not_echoed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The broker used to echo the frame straight back to the device, which let a
    device inject requests into its own answer stream."""
    monkeypatch.delenv("PUPPY_RELAY_RENDEZVOUS_URL", raising=False)
    key = ("owner-inject", "device-inject")
    device = _FakeWebSocket(
        [{"type": "inference.request", "requestId": "evil", "deviceId": key[1]}]
    )
    link = await BROKER.register(key, device)  # type: ignore[arg-type]

    await relay._device_loop(device, key, link)  # type: ignore[arg-type]

    assert [f["type"] for f in device.sent] == ["relay.ready"]
    assert await BROKER.get(key) is None  # the link was torn down, not kept


@pytest.mark.asyncio
async def test_the_provider_loop_binds_the_device_link_per_request(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`_provider_loop` captured `link` once. A device that reconnected between two
    turns had its requests written to the closed socket; every later request then
    waited out the full frame timeout for an answer that could never arrive."""
    monkeypatch.delenv("PUPPY_RELAY_RENDEZVOUS_URL", raising=False)

    async def _always_valid(_token, *, expected_scope):
        return True, "", None

    monkeypatch.setattr(relay, "validate_token_with_db", _always_valid)
    key = ("owner-rebind", "device-rebind")
    old_device = _FakeWebSocket([])
    await BROKER.register(key, old_device)  # type: ignore[arg-type]

    class _NewDevice(_FakeWebSocket):
        async def send_json(self, frame: dict) -> None:
            await super().send_json(frame)
            if frame.get("type") == "inference.request":
                link = await BROKER.get(key)
                assert link is not None
                link.pending[frame["requestId"]].put_nowait(
                    {"type": "inference.done", "requestId": frame["requestId"]}
                )

    new_device = _NewDevice([])

    async def replace_before_first_request() -> None:
        if await BROKER.get(key) is not None and (await BROKER.get(key)).websocket is old_device:
            await BROKER.register(key, new_device)  # type: ignore[arg-type]

    pod = _FakeWebSocket(
        [{"type": "inference.request", "requestId": "r1", "deviceId": key[1]}],
        on_receive=replace_before_first_request,
    )

    await relay._provider_loop(pod, key, "grant")  # type: ignore[arg-type]

    assert old_device.sent == [] and old_device.closed == [(1012, "replaced")]
    assert [f["type"] for f in new_device.sent] == ["inference.request"]
    assert [f["type"] for f in pod.sent] == ["relay.ready", "inference.done"]
    link = await BROKER.get(key)
    await BROKER.remove(key, link)  # type: ignore[arg-type]
