"""Every mounted pod route refuses a caller with no identity, not only `/pod/info`.

Heartbeat admission promotes a public pod to owner-direct after probing ONE machine
route (`/pod/info`). That probe is only evidence for the whole pod if the wall is a
property of the pod, not of that path. So this enumerates the routes the pod actually
mounts, every method, and sends each one exactly what a stranger on the internet
would: no Authorization header.

* A machine route must be refused by the wall itself (404, logged as walled, the
  handler never reached); a websocket must be closed 1008.
* An app-surface route carries its own authentication, so the wall lets it through
  by design; it must still never succeed for an unidentified caller. Only the two
  liveness probes may answer 2xx, and they carry nothing about the person.
* A route added later is covered automatically, and a new public route has to be
  named here deliberately.
"""

from __future__ import annotations

import logging
import os
import re
from typing import Any

import pytest

os.environ.setdefault("APP_SIGNING_KEY", "test_secret_key_for_ci_only_32chars_min")
os.environ.setdefault("VAULT_DATA_KEY", "0" * 64)

#: The only routes an unidentified caller may get a 2xx from.
PUBLIC_LIVENESS = frozenset({("GET", "/health"), ("GET", "/health/ready")})

pod_server: Any


@pytest.fixture(autouse=True)
def walled(monkeypatch):
    global pod_server
    monkeypatch.setenv("HUSSH_POD_MODE", "1")
    monkeypatch.setenv("HUSSH_POD_HUB_CALLER_EMAILS", "hub@example.iam.gserviceaccount.com")
    monkeypatch.delenv("HUSSH_POD_TICK_ALLOWED_EMAILS", raising=False)
    monkeypatch.delenv("HUSSH_POD_TICK_AUDIENCE", raising=False)
    pod_server = pytest.importorskip("pod_server")
    from api.middlewares import pod_ingress

    monkeypatch.setattr(pod_ingress, "identity_verifier", None)
    return pod_ingress


def _concrete(path: str) -> str:
    return re.sub(r"\{[^}]+\}", "x1", path)


def _http_routes() -> list[tuple[str, str]]:
    pairs = []
    for route in pod_server.app.routes:
        methods = getattr(route, "methods", None)
        if not methods or not getattr(route, "path", None):
            continue
        pairs.extend((method, route.path) for method in sorted(methods) if method != "HEAD")
    return pairs


def _websocket_routes() -> list[str]:
    from starlette.routing import WebSocketRoute

    return [r.path for r in pod_server.app.routes if isinstance(r, WebSocketRoute)]


def test_the_pod_mounts_enough_routes_for_this_to_mean_something():
    machine = [p for _, p in _http_routes() if p.startswith(("/pod/", "/api/one/a2a/"))]
    assert len(_http_routes()) > 40 and len(machine) > 10


def test_every_machine_route_is_refused_by_the_wall_itself(walled, caplog):
    from fastapi.testclient import TestClient

    client = TestClient(pod_server.app, raise_server_exceptions=False)
    checked = 0
    for method, path in _http_routes():
        concrete = _concrete(path)
        if walled.is_app_surface(concrete):
            continue
        caplog.clear()
        with caplog.at_level(logging.INFO, logger="api.middlewares.pod_ingress"):
            response = client.request(method, concrete)
        assert response.status_code == 404, (method, path, response.status_code)
        assert response.json() == {"detail": "not found"}, (method, path)
        assert any("pod_ingress.walled" in r.getMessage() for r in caplog.records), (
            f"{method} {path} answered 404 but not from the wall"
        )
        checked += 1
    assert checked > 20


def test_no_app_surface_route_succeeds_for_an_unidentified_caller(walled):
    from fastapi.testclient import TestClient

    client = TestClient(pod_server.app, raise_server_exceptions=False)
    served = []
    for method, path in _http_routes():
        concrete = _concrete(path)
        if not walled.is_app_surface(concrete) or (method, path) in PUBLIC_LIVENESS:
            continue
        for kwargs in ({}, {"json": {}}):
            response = client.request(method, concrete, **kwargs)
            if response.status_code < 400:
                served.append((method, path, response.status_code))
    assert served == [], f"served to a caller with no identity: {served}"


def test_every_machine_websocket_is_closed_before_it_is_accepted(walled):
    from fastapi.testclient import TestClient
    from starlette.websockets import WebSocketDisconnect

    client = TestClient(pod_server.app, raise_server_exceptions=False)
    machine = [p for p in _websocket_routes() if not walled.is_app_surface(_concrete(p))]
    assert machine, "expected at least one walled websocket"
    for path in machine:
        with pytest.raises(WebSocketDisconnect) as closed:
            with client.websocket_connect(_concrete(path)):
                pass
        assert closed.value.code == 1008, path


#: Realistic values for the owner app's parameterised agent-chat routes.
_REAL = {
    "conversation_id": "conv-1",
    "user_id": "owner-a",
    "client_message_id": "client-msg-0001",
    "command_id": "0b6f6a1e-2f4c-4d1a-9a59-5f1f3c1e2d3b",
}


def _real(path: str) -> str:
    def value(match: re.Match[str]) -> str:
        name = match.group(1)
        if name == "connector_id":
            return "custom_" + "a" * 32
        return _REAL[name]

    return re.sub(r"\{([^}]+)\}", value, path)


def _agent_chat_routes() -> list[tuple[str, str]]:
    return [(m, p) for m, p in _http_routes() if p.startswith("/api/one/pod/agent-chat")]


def test_every_agent_chat_route_is_named_on_the_app_surface(walled):
    """Queue, stop, ratings, proposals and connector settings are the owner app's
    own doors on its agent. Each must be named exactly, so the app reaches it with
    its pod session and nothing else shares that reach."""
    routes = _agent_chat_routes()
    paths = {p for _, p in routes}
    for expected in (
        "/api/one/pod/agent-chat/runs/{conversation_id}/queue",
        "/api/one/pod/agent-chat/runs/{conversation_id}/queue/{client_message_id}",
        "/api/one/pod/agent-chat/runs/{conversation_id}/stop",
        "/api/one/pod/agent-chat/feedback",
        "/api/one/pod/agent-chat/proposals",
        "/api/one/pod/agent-chat/proposals/typed",
        "/api/one/pod/agent-chat/proposals/{command_id}",
        "/api/one/pod/agent-chat/proposals/{command_id}/settle",
        "/api/one/pod/agent-chat/connectors/{connector_id}/mcp/catalog",
        "/api/one/pod/agent-chat/connectors/{connector_id}/mcp/oauth/begin",
        "/api/one/pod/agent-chat/connectors/{connector_id}/mcp/oauth/complete",
        "/api/one/pod/agent-chat/connectors/{connector_id}/mcp/oauth/cancel",
    ):
        assert expected in paths, f"{expected} is not mounted on the pod"
    for method, path in routes:
        assert walled.is_app_surface(_real(path)), (method, path)


def test_agent_chat_app_surface_patterns_do_not_widen_to_neighbours(walled):
    for path in (
        "/api/one/pod/agent-chat/runs/conv-1/queue/client-msg-0001/extra",
        "/api/one/pod/agent-chat/runs/conv-1/queue/short",
        "/api/one/pod/agent-chat/runs/conv-1/start",
        "/api/one/pod/agent-chat/runs/conv 1/stop",
        "/api/one/pod/agent-chat/proposals/not-a-uuid",
        "/api/one/pod/agent-chat/proposals/0b6f6a1e-2f4c-4d1a-9a59-5f1f3c1e2d3b/execute",
        "/api/one/pod/agent-chat/proposals/typed/x",
        "/api/one/pod/agent-chat/feedback/export",
        "/api/one/pod/agent-chat/connectors/gmail/mcp/catalog",
        "/api/one/pod/agent-chat/connectors/custom_" + "a" * 32 + "/mcp/oauth/refresh",
        "/api/one/pod/agent-chat/connectors/custom_" + "a" * 32 + "/mcp/confirm",
    ):
        assert not walled.is_app_surface(path), path


def test_no_agent_chat_route_serves_an_unidentified_caller_at_its_real_path(walled):
    from fastapi.testclient import TestClient

    client = TestClient(pod_server.app, raise_server_exceptions=False)
    served = []
    for method, path in _agent_chat_routes():
        for kwargs in ({}, {"json": {}}):
            response = client.request(method, _real(path), **kwargs)
            if response.status_code < 400:
                served.append((method, path, response.status_code))
    assert served == [], f"served to a caller with no identity: {served}"
