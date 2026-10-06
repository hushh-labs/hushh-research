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
