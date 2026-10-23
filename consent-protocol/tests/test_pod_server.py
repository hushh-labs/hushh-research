"""Pin pod routes and authority; forbid control-plane and unrelated surfaces."""

from __future__ import annotations

import os
from typing import Any

import pytest

from tests.pod_surface_paths import OWNER_REACHABLE_PATHS

# The pod entrypoint validates HCT tokens on import paths that read the signing key.
os.environ.setdefault("APP_SIGNING_KEY", "test_secret_key_for_ci_only_32chars_min")
os.environ.setdefault("VAULT_DATA_KEY", "0" * 64)

pod_server: Any


@pytest.fixture(autouse=True)
def pod_runtime(monkeypatch):
    # Import in test scope: pod_server must not change shared collection mode.
    global pod_server
    monkeypatch.setenv("HUSSH_POD_MODE", "1")
    pod_server = pytest.importorskip("pod_server")


def _paths() -> set[str]:
    return {r.path for r in pod_server.app.routes if getattr(r, "path", None)}


def test_pod_mounts_the_agent_and_health_surface():
    paths = _paths()
    for expected in (
        "/health",
        "/health/ready",
        "/pod/info",
        "/api/one/a2a/card",
        "/api/one/a2a/message",
        "/api/one/agent-prompt",
    ):
        assert expected in paths, f"pod is missing its own surface: {expected}"


def test_pod_readiness_does_not_require_the_hub_database(monkeypatch):
    from fastapi.testclient import TestClient

    from api.routes import health as health_routes

    async def unavailable_pool():
        raise AssertionError("a private pod must not query the hub database")

    monkeypatch.setattr(health_routes, "get_pool", unavailable_pool)
    response = TestClient(pod_server.app).get("/health/ready")
    assert response.status_code == 200
    assert response.json() == {"status": "ready", "checks": {"pod_process": "ok"}}


@pytest.mark.parametrize(
    "forbidden_prefix",
    [
        "/api/consent",  # consent ISSUANCE — central control plane, never on a pod
        "/api/developer",
        "/api/account",
        "/api/iam",
        "/api/ria",
        "/api/one/email",
        "/api/one/marketplace",
        "/api/one/webauthn",  # login lives centrally
        "/api/one/connections",
        "/api/one/location",
        # The data-door broker READS a DB-backed specialist for a pod. A pod
        # holds no DB credential and must never proxy this to other pods.
        "/api/one/pod/specialist",
    ],
)
def test_pod_does_not_mount_central_or_unrelated_surface(forbidden_prefix):
    leaked = [p for p in _paths() if p == forbidden_prefix or p.startswith(forbidden_prefix)]
    assert not leaked, f"pod leaked central/unrelated surface: {leaked}"


def test_pod_surface_stays_within_reviewed_routes():
    # Review authority-bearing additions explicitly. A route count can both
    # reject legitimate lifecycle endpoints and miss a forbidden replacement.
    allowed = (
        OWNER_REACHABLE_PATHS
        | QUEUE_REACHABLE_PATHS
        | {
            "/",
            "/.well-known/agent-card.json",
            "/api/app-config/review-mode",
            "/api/app-config/review-mode/session",
            "/api/one/a2a/card",
            "/api/one/a2a/message",
            "/api/one/agent-prompt",
            "/api/one/pod/files/worker",
            "/api/one/pod/gmail/push",
            "/api/one/pod/live",
            "/api/one/pod/maintenance/tick",
            "/api/one/pod/upgrade/prepare",
            "/api/one/pod/upgrade/release",
            "/api/one/pod/upgrade/status",
            "/docs",
            "/docs/oauth2-redirect",
            "/health/capabilities",
            "/openapi.json",
            "/pod/diagnostics/model",
            "/pod/info",
            "/pod/migration/erasure/crypto-erase",
            "/pod/migration/erasure/crypto-erase/preflight",
            "/pod/migration/erasure/fence",
            "/pod/migration/erasure/memory/binding",
            "/pod/migration/erasure/memory/reconcile",
            "/pod/migration/export",
            "/pod/migration/import",
            "/pod/public-key",
            "/pod/tick",
            "/redoc",
        }
        | {f"/pod/sync/{verb}" for verb in ("head", "export", "import", "set-role")}
    )
    assert not (_paths() - allowed), "pod exposes an unreviewed route"


def test_pod_info_reports_pod_role():
    info = pod_server.pod_info()
    assert info["role"] == "sovereign-pod"
    assert "central" in info["controlPlane"]


async def test_gmail_restart_waits_for_authority_but_not_foreground_startup(monkeypatch):
    import asyncio
    from types import SimpleNamespace
    from unittest.mock import AsyncMock

    from api.routes.one import pod_maintenance
    from hushh_mcp.services import (
        pod_identity_store,
        pod_session_authority,
        pod_storage,
        pod_upgrade_admission,
    )

    recovering, recover, gmail_started, gmail_stopped = (asyncio.Event() for _ in range(4))

    async def authority(**kwargs):
        recovering.set()
        await recover.wait()

    async def gmail():
        gmail_started.set()
        try:
            await asyncio.Event().wait()
        finally:
            gmail_stopped.set()

    permit = SimpleNamespace(release=AsyncMock())
    admission = SimpleNamespace(acquire_turn=AsyncMock(return_value=permit))
    monkeypatch.setattr(pod_storage, "resolve_boot_custody", AsyncMock(return_value=(None, None)))
    monkeypatch.setattr(
        pod_identity_store, "resolve_durable_private_key_b64", AsyncMock(return_value=None)
    )
    monkeypatch.setattr(pod_session_authority, "build_pod_session_authority", authority)
    monkeypatch.setattr(pod_upgrade_admission, "ADMISSION", admission)
    monkeypatch.setattr(pod_maintenance, "gmail_notification_job", gmail)
    monkeypatch.setattr(pod_server, "_start_heartbeat_loop", lambda: None)
    monkeypatch.setattr(pod_server, "_ensure_memory_bank_task", AsyncMock())
    monkeypatch.delenv("POD_FILES_ENABLED", raising=False)
    boot = asyncio.create_task(pod_server._pod_startup())
    try:
        await asyncio.wait_for(recovering.wait(), 1)
        assert not gmail_started.is_set()
        admission.acquire_turn.assert_not_awaited()
        recover.set()
        await asyncio.wait_for(boot, 1)
        await asyncio.wait_for(gmail_started.wait(), 1)
        permit.release.assert_not_awaited()
        await pod_server._stop_files_queue()
        assert gmail_stopped.is_set()
        permit.release.assert_awaited_once()
        assert pod_server.app.state.gmail_restart_consumer is None
    finally:
        boot.cancel()
        await asyncio.gather(boot, return_exceptions=True)
        await pod_server._stop_files_queue()


def test_a_hub_outage_is_a_clean_503_not_a_raw_500():
    """A pod reads the data plane THROUGH the hub, so a hub outage is a dependency
    outage and must answer like one -- the same shape as the DB handlers beside it.

    This was observed for real in hushh-pda-dev on 2026-08-04: a hub that refused the
    pod surfaced as an unhandled 500 with a traceback, which both leaks internals and
    invites a caller to read a transient refusal as a permanent answer.
    """
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from hushh_mcp.services.pod_hub_client import PodHubUnavailable

    handler = pod_server.app.exception_handlers.get(PodHubUnavailable)
    assert handler is not None, "pod_server must map a hub outage to a handled response"

    app = FastAPI()
    app.add_exception_handler(PodHubUnavailable, handler)

    @app.get("/boom")
    async def _boom():
        raise PodHubUnavailable("hub returned HTTP 401 for the prompt read")

    resp = TestClient(app, raise_server_exceptions=False).get("/boom")
    assert resp.status_code == 503
    assert resp.json() == {"detail": "hub unavailable"}
    # The failure reason must not leak upstream internals to the caller.
    assert "401" not in resp.text


# /pod/info must report mounted capabilities, not a hardcoded roster.


def test_the_mount_list_is_derived_from_the_app():
    import pod_server

    reported = pod_server.pod_info()["mounts"]
    actual = {str(getattr(r, "path", "")) for r in pod_server.app.routes}

    assert reported, "a pod that reports no surface is reporting a bug"
    assert set(reported) <= actual


def test_a_router_that_fails_to_mount_disappears_from_the_answer(monkeypatch):
    """Reported capabilities must track the mounted routes."""
    import pod_server

    # app.routes is a read-only property over app.router.routes: swap one level down.
    kept = [r for r in pod_server.app.routes if "/turn" not in str(getattr(r, "path", ""))]
    monkeypatch.setattr(pod_server.app.router, "routes", kept)

    assert not any(path.endswith("/turn") for path in pod_server.pod_info()["mounts"])


def test_the_health_route_is_always_reported():
    """Cloud Run's startup probe is pinned to /health. A pod that does not serve it
    cannot pass a deploy at all, so its absence here would mean the derivation is
    broken rather than that the pod is minimal."""
    import pod_server

    assert "/health" in pod_server.pod_info()["mounts"]


# Public ingress must preserve authenticated machine routes.


def _hub_identity(email="hub@example.iam.gserviceaccount.com", aud=None):
    def _verify(token: str, audience: str) -> dict:
        if aud is not None and audience != aud:
            raise ValueError("audience mismatch")
        return {"email": email, "email_verified": True, "aud": audience, "sub": "1"}

    return _verify


@pytest.fixture
def walled(monkeypatch):
    from api.middlewares import pod_ingress

    # Explicit topology avoids depending on pod_server import order.
    monkeypatch.setenv("HUSSH_POD_MODE", "1")
    monkeypatch.setenv("HUSSH_POD_HUB_CALLER_EMAILS", "hub@example.iam.gserviceaccount.com")
    monkeypatch.delenv("HUSSH_POD_TICK_ALLOWED_EMAILS", raising=False)
    monkeypatch.delenv("HUSSH_POD_TICK_AUDIENCE", raising=False)
    monkeypatch.setattr(pod_ingress, "identity_verifier", None)
    return pod_ingress


def test_machine_routes_answer_404_without_a_hub_identity(walled):
    from fastapi.testclient import TestClient

    client = TestClient(pod_server.app, raise_server_exceptions=False)
    for path in (
        "/pod/info",
        "/pod/public-key",
        "/docs",
        "/openapi.json",
        "/pod/tick",
        "/api/one/pod/maintenance/tick",
    ):
        response = client.get(path)
        assert response.status_code == 404, path
        assert response.json() == {"detail": "not found"}
    # ...and a wrong identity is the same 404, never an oracle.
    walled.identity_verifier = _hub_identity(email="stranger@example.invalid")
    assert client.get("/pod/info", headers={"Authorization": "Bearer t"}).status_code == 404


def test_upgrade_handoff_routes_stay_behind_the_machine_wall(walled):
    from fastapi.testclient import TestClient

    client = TestClient(pod_server.app, raise_server_exceptions=False)
    for method, path in (
        ("POST", "/api/one/pod/upgrade/prepare"),
        ("POST", "/api/one/pod/upgrade/release"),
        ("GET", "/api/one/pod/upgrade/status"),
    ):
        response = client.request(method, path, json={} if method == "POST" else None)
        assert response.status_code == 404, path
        assert response.json() == {"detail": "not found"}


def test_the_hub_identity_opens_the_wall_by_url_or_host_audience(walled, monkeypatch):
    from fastapi.testclient import TestClient

    client = TestClient(pod_server.app, raise_server_exceptions=False)
    for aud in ("http://testserver", "http://testserver/", "testserver", "https://testserver"):
        monkeypatch.setattr(walled, "identity_verifier", _hub_identity(aud=aud))
        response = client.get("/pod/info", headers={"Authorization": "Bearer hub-token"})
        assert response.status_code == 200, aud
        assert response.json()["role"] == "sovereign-pod"
    monkeypatch.setattr(
        walled, "identity_verifier", _hub_identity(aud="https://other-pod.a.run.app")
    )
    assert client.get("/pod/info", headers={"Authorization": "Bearer hub-token"}).status_code == 404


def test_the_tick_audience_is_accepted_when_configured(walled, monkeypatch):
    from fastapi.testclient import TestClient

    from api.routes.one import pod_maintenance
    from hushh_mcp.services import scheduler_identity

    monkeypatch.setenv("HUSSH_POD_TICK_AUDIENCE", "hussh-pod-tick:HA1")
    monkeypatch.setenv("HUSSH_POD_TICK_ALLOWED_EMAILS", "tick@example.iam.gserviceaccount.com")
    monkeypatch.setattr(
        walled,
        "identity_verifier",
        _hub_identity(email="tick@example.iam.gserviceaccount.com", aud="hussh-pod-tick:HA1"),
    )
    client = TestClient(pod_server.app, raise_server_exceptions=False)
    assert client.get("/pod/info", headers={"Authorization": "Bearer t"}).status_code == 200
    tick_identity = type("TickIdentity", (), {"email": "tick@example.iam.gserviceaccount.com"})()
    monkeypatch.setattr(scheduler_identity, "verify_scheduler_request", lambda **_: tick_identity)

    async def no_work():
        return {"outcome": "not_needed"}

    monkeypatch.setattr(pod_maintenance, "memory_bank_rebuild_job", no_work)
    monkeypatch.setattr(pod_maintenance, "gmail_notification_job", no_work)
    for path in ("/pod/tick", "/api/one/pod/maintenance/tick"):
        assert client.post(path).status_code == 404
        response = client.post(path, headers={"Authorization": "Bearer t"})
        assert response.status_code == 200
        assert response.json()["gmailNotifications"] == {"outcome": "not_needed"}
    monkeypatch.setattr(walled, "identity_verifier", _hub_identity(email="other@example.invalid"))
    assert (
        client.post(
            "/api/one/pod/maintenance/tick", headers={"Authorization": "Bearer t"}
        ).status_code
        == 404
    )


def test_the_app_surface_is_reachable_without_a_hub_identity(walled):
    from fastapi.testclient import TestClient

    client = TestClient(pod_server.app, raise_server_exceptions=False)
    assert client.get("/health").status_code == 200
    # No session -> the route's own refusal, not the wall's 404.
    assert client.get("/api/one/pod/status").status_code in {401, 403, 503}
    assert client.post("/api/one/pod/session/challenge", json={"subjectId": "x"}).status_code != 404


def test_pod_info_is_no_longer_unauthenticated(walled):
    """The one that mattered: the build tag `dev-195de95d2` served this to the world."""
    from fastapi.testclient import TestClient

    from api.middlewares.pod_ingress import is_app_surface

    assert is_app_surface("/pod/info") is False
    assert is_app_surface("/pod/public-key") is False
    client = TestClient(pod_server.app, raise_server_exceptions=False)
    assert client.get("/pod/info").status_code == 404
    assert client.get("/pod/public-key").status_code == 404


def test_a_walled_websocket_is_closed_before_accept(walled):
    from fastapi.testclient import TestClient
    from starlette.websockets import WebSocketDisconnect

    client = TestClient(pod_server.app, raise_server_exceptions=False)
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/api/one/pod/live"):
            pass


def test_cors_allows_only_rendered_origins_without_credentials(monkeypatch):
    from starlette.middleware.cors import CORSMiddleware

    monkeypatch.setenv("CORS_ALLOWED_ORIGINS", "https://one.hushh.ai, *,https://dev.one.hushh.ai")
    assert pod_server._pod_cors_origins() == ["https://one.hushh.ai", "https://dev.one.hushh.ai"]
    cors = [m for m in pod_server.app.user_middleware if m.cls is CORSMiddleware]
    assert len(cors) == 1
    assert cors[0].kwargs["allow_credentials"] is False
    assert "*" not in cors[0].kwargs["allow_origins"]


def test_the_wall_sits_inside_observability_and_outside_the_routes():
    """Order is load-bearing: observability outermost so walled requests still log."""
    from starlette.middleware.base import BaseHTTPMiddleware
    from starlette.middleware.cors import CORSMiddleware

    from api.middlewares.pod_ingress import PodIngressPolicy

    order = [m.cls for m in pod_server.app.user_middleware]
    assert (
        order.index(BaseHTTPMiddleware)
        < order.index(CORSMiddleware)
        < order.index(PodIngressPolicy)
    )


# Exact external reachability, independently pinned against ingress policy.
# Queue identity is checked at this exact route, never by an owner session.
QUEUE_REACHABLE_PATHS = frozenset(
    {"/api/one/pod/files/worker", "/api/one/pod/tasks/worker", "/api/one/pod/browser/worker"}
)
# Exact Pub/Sub OIDC identity is enforced at the route; it gets no owner session.
PROVIDER_REACHABLE_PATHS = frozenset({"/api/one/pod/gmail/push"})


def _concrete(path: str) -> str:
    """Use valid scoped identifiers so strict ingress patterns are actually exercised."""
    import re

    values = {
        "task_id": "browser_" + "0" * 32,
        "download_id": "0" * 32,
        "account_id": "0" * 32,
        "operation": "scan",
        "command_id": "00000000-0000-4000-8000-000000000001",
        "connector_id": "gmail"
        if path.startswith("/api/one/pod/connectors/")
        else "custom_" + "0" * 32,
        "proposal_id": "gmod_" + "a" * 16,
        "client_message_id": "message_123",
    }
    return re.sub(r"\{([^}]+)\}", lambda match: values.get(match[1], "sample"), path)


def test_the_owner_reachable_surface_is_exactly_these_paths():
    from api.middlewares.pod_ingress import is_app_surface

    mounted = _paths()
    expected = OWNER_REACHABLE_PATHS | QUEUE_REACHABLE_PATHS | PROVIDER_REACHABLE_PATHS
    assert expected <= mounted, (
        f"pinned as owner-reachable but not mounted: {sorted(expected - mounted)}"
    )
    reachable = {path for path in mounted if is_app_surface(_concrete(path))}
    assert reachable == expected, (
        f"newly reachable: {sorted(reachable - expected)}; "
        f"newly walled: {sorted(expected - reachable)}"
    )


def test_every_memory_door_is_owner_reachable_over_http(walled):
    """The property the header parameters alone could not give: the machine wall
    lets an owner-direct request through to the route, which then answers with its
    own admission refusal rather than the wall's 404."""
    from fastapi.testclient import TestClient

    client = TestClient(pod_server.app, raise_server_exceptions=False)
    calls = (
        client.get("/api/one/pod/memory/status"),
        client.post("/api/one/pod/memory/revoke", json={"memoryIds": ["m1"]}),
        client.post("/api/one/pod/memory/provider-consent", json={"granted": False}),
        client.post("/api/one/pod/conversation/c1/close", json={}),
    )
    for response in calls:
        assert response.json() != {"detail": "not found"}, (
            f"{response.request.url.path} was refused by the machine wall, "
            "so an owner on a laptop can never reach it"
        )


def test_the_memory_doors_still_carry_their_own_refusal(walled, monkeypatch):
    """Reachable is not open. With the feature ON and no credential of either kind,
    every door answers its own 401, so putting them on the app surface moved the
    check to the route rather than removing it."""
    from fastapi.testclient import TestClient

    from api.routes.one import pod_turn

    monkeypatch.setattr(pod_turn, "pod_mode", lambda: True)
    monkeypatch.setattr(pod_turn, "pod_turn_enabled", lambda: True)
    client = TestClient(pod_server.app, raise_server_exceptions=False)
    for response in (
        client.get("/api/one/pod/memory/status"),
        client.post("/api/one/pod/memory/revoke", json={"memoryIds": ["m1"]}),
        client.post("/api/one/pod/memory/provider-consent", json={"granted": False}),
        client.post("/api/one/pod/conversation/c1/close", json={}),
    ):
        assert response.status_code == 401, response.request.url.path
        assert response.json() == {"detail": "consent token required"}


def test_a_disabled_pod_answers_404_to_every_memory_door_bearer_or_not(walled, monkeypatch):
    """Availability is settled before any door opens. With the feature off, a
    request carrying a bearer must look exactly like one that carries nothing:
    otherwise the refusal is an oracle for a disabled pod's memory surface and for
    whether its local authority is running."""
    from fastapi.testclient import TestClient

    from api.routes.one import pod_turn

    monkeypatch.setattr(pod_turn, "pod_mode", lambda: True)
    monkeypatch.setattr(pod_turn, "pod_turn_enabled", lambda: False)
    client = TestClient(pod_server.app, raise_server_exceptions=False)
    for headers in ({}, {"Authorization": "Bearer pst1.whatever.mac"}):
        for response in (
            client.get("/api/one/pod/memory/status", headers=headers),
            client.post("/api/one/pod/memory/revoke", json={"memoryIds": ["m1"]}, headers=headers),
            client.post(
                "/api/one/pod/memory/provider-consent", json={"granted": False}, headers=headers
            ),
            client.post("/api/one/pod/conversation/c1/close", json={}, headers=headers),
        ):
            assert response.status_code == 404, (response.request.url.path, headers)
            assert response.json() == {"detail": "pod turn is not available"}


def test_a_memory_path_that_is_not_named_stays_walled(walled):
    """The memory doors are allowlisted one at a time, never by prefix: a future
    /memory/export must be reviewed here before it is public."""
    from fastapi.testclient import TestClient

    from api.middlewares.pod_ingress import is_app_surface

    assert is_app_surface("/api/one/pod/memory/export") is False
    assert is_app_surface("/api/one/pod/memory") is False
    client = TestClient(pod_server.app, raise_server_exceptions=False)
    assert client.get("/api/one/pod/memory/export").json() == {"detail": "not found"}


def test_browser_download_admission_remains_exact_and_authenticated(walled):
    from fastapi.testclient import TestClient

    from api.middlewares.pod_ingress import is_app_surface

    path = "/api/one/pod/browser/tasks/browser_" + "0" * 32 + "/downloads/" + "1" * 32
    assert is_app_surface(path)
    client = TestClient(pod_server.app, raise_server_exceptions=False)
    response = client.post(path, json={"name": "synthetic.txt", "parent": "root"})
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "LOCAL_AUTHORITY_UNAVAILABLE"
    for refused in (path + "/export", path[:-1] + "z", path.replace("/downloads/", "/export/")):
        assert not is_app_surface(refused)
        assert client.post(refused, json={}).json() == {"detail": "not found"}
