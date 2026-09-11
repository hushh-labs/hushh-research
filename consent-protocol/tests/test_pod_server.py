"""Route-allowlist tests for the slim pod entrypoint (`pod_server:app`).

The security-relevant property of the pod image is its **surface**: it must expose
the agent + storage/enforcement + health routes and must NOT expose Hushh's consent
control plane or any unrelated fleet surface. These tests assert exactly that by
introspecting the mounted routes — a regression that accidentally mounts the full
`one_router` (or the consent/admin routers) here fails loudly.
"""

from __future__ import annotations

import os

import pytest

# The pod entrypoint validates HCT tokens on import paths that read the signing key.
os.environ.setdefault("APP_SIGNING_KEY", "test_secret_key_for_ci_only_32chars_min")
os.environ.setdefault("VAULT_DATA_KEY", "0" * 64)

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
    allowed = {
        "/",
        "/.well-known/agent-card.json",
        "/api/app-config/review-mode",
        "/api/app-config/review-mode/session",
        "/api/one/a2a/card",
        "/api/one/a2a/message",
        "/api/one/agent-prompt",
        "/api/one/pod/live",
        "/api/one/pod/turn",
        # The learning loop's doors (api/routes/one/pod_memory.py): same admission
        # as the turn. Reviewed here because each carries owner authority.
        "/api/one/pod/conversation/{conversation_id}/close",
        "/api/one/pod/memory/revoke",
        "/api/one/pod/memory/provider-consent",
        "/api/one/pod/memory/status",
        # The app surface: owner-local sessions, status, configuration (Lane A).
        "/api/one/pod/session/challenge",
        "/api/one/pod/session/admit",
        "/api/one/pod/session/renew",
        "/api/one/pod/session/revoke",
        "/api/one/pod/status",
        "/api/one/pod/config",
        # The device door: Puppy One dials this pod directly (Lane A).
        "/api/one/puppy/relay",
        "/docs",
        "/docs/oauth2-redirect",
        "/openapi.json",
        "/redoc",
        "/health",
        "/health/capabilities",
        "/health/ready",
        "/pod/diagnostics/model",
        "/pod/info",
        "/pod/public-key",
        "/pod/tick",
        "/pod/migration/export",
        "/pod/migration/import",
        "/pod/migration/erasure/fence",
        "/pod/migration/erasure/memory/binding",
        "/pod/migration/erasure/memory/reconcile",
    }
    assert not (_paths() - allowed), "pod exposes an unreviewed route"


def test_pod_info_reports_pod_role():
    info = pod_server.pod_info()
    assert info["role"] == "sovereign-pod"
    assert "central" in info["controlPlane"]


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


# -- /pod/info reports what is MOUNTED, not what someone typed --------------------
#
# The literal it replaced is the same pattern that produced a false proof of life
# two files away: /health advertised a hardcoded ["one","kai","nav","kyc"] roster, a
# live-validation document quoted that string as evidence the fleet ran inside pods,
# and no Python anywhere loaded kyc's YAML. A capability list that CANNOT be wrong is
# worth less than no list at all, because people believe it.


def test_the_mount_list_is_derived_from_the_app():
    import pod_server

    reported = pod_server.pod_info()["mounts"]
    actual = {str(getattr(r, "path", "")) for r in pod_server.app.routes}

    assert reported, "a pod that reports no surface is reporting a bug"
    assert set(reported) <= actual


def test_a_router_that_fails_to_mount_disappears_from_the_answer(monkeypatch):
    """The property the literal could not have. If the turn router stops mounting,
    /pod/info must stop claiming it -- otherwise the next false proof of life reads
    exactly like the last one."""
    import pod_server

    # app.routes is a read-only property over app.router.routes, so the swap goes
    # one level down.
    kept = [r for r in pod_server.app.routes if "/turn" not in str(getattr(r, "path", ""))]
    monkeypatch.setattr(pod_server.app.router, "routes", kept)

    assert not any(path.endswith("/turn") for path in pod_server.pod_info()["mounts"])


def test_the_health_route_is_always_reported():
    """Cloud Run's startup probe is pinned to /health. A pod that does not serve it
    cannot pass a deploy at all, so its absence here would mean the derivation is
    broken rather than that the pod is minimal."""
    import pod_server

    assert "/health" in pod_server.pod_info()["mounts"]


# -- the machine wall ----------------------------------------------------------------
#
# Once a pod admits its owner directly its ingress is public and Cloud Run IAM no
# longer keeps the machine routes hub-only. `PodIngressPolicy` does, per path, and it
# is always on. These drive the real app over HTTP so a route that mounts but is not
# walled fails here rather than in a public project.


def _hub_identity(email="hub@example.iam.gserviceaccount.com", aud=None):
    def _verify(token: str, audience: str) -> dict:
        if aud is not None and audience != aud:
            raise ValueError("audience mismatch")
        return {"email": email, "email_verified": True, "aud": audience, "sub": "1"}

    return _verify


@pytest.fixture
def walled(monkeypatch):
    from api.middlewares import pod_ingress

    monkeypatch.setenv("HUSSH_POD_HUB_CALLER_EMAILS", "hub@example.iam.gserviceaccount.com")
    monkeypatch.delenv("HUSSH_POD_TICK_ALLOWED_EMAILS", raising=False)
    monkeypatch.delenv("HUSSH_POD_TICK_AUDIENCE", raising=False)
    monkeypatch.setattr(pod_ingress, "identity_verifier", None)
    return pod_ingress


def test_machine_routes_answer_404_without_a_hub_identity(walled):
    from fastapi.testclient import TestClient

    client = TestClient(pod_server.app, raise_server_exceptions=False)
    for path in ("/pod/info", "/pod/public-key", "/docs", "/openapi.json", "/pod/tick"):
        response = client.get(path)
        assert response.status_code == 404, path
        assert response.json() == {"detail": "not found"}
    # ...and a wrong identity is the same 404, never an oracle.
    walled.identity_verifier = _hub_identity(email="stranger@example.invalid")
    assert client.get("/pod/info", headers={"Authorization": "Bearer t"}).status_code == 404


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

    monkeypatch.setenv("HUSSH_POD_TICK_AUDIENCE", "hussh-pod-tick:HA1")
    monkeypatch.setenv("HUSSH_POD_TICK_ALLOWED_EMAILS", "tick@example.iam.gserviceaccount.com")
    monkeypatch.setattr(
        walled,
        "identity_verifier",
        _hub_identity(email="tick@example.iam.gserviceaccount.com", aud="hussh-pod-tick:HA1"),
    )
    client = TestClient(pod_server.app, raise_server_exceptions=False)
    assert client.get("/pod/info", headers={"Authorization": "Bearer t"}).status_code == 200


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


# -- the app surface is pinned path by path -------------------------------------------
#
# The wall and the route allowlist are two different lists, and a route can mount
# while staying unreachable by its owner. That is not hypothetical: three of the four
# memory doors mounted, declared both admission headers, had owner-local tests, and
# still answered the wall's 404 to every owner-direct request, because nothing
# compared the two lists. These do.

#: Every mounted path an owner may reach directly, with no hub identity. Anything
#: mounted and absent from here is on the machine wall. Both directions are asserted,
#: so widening the wall's allowlist without reviewing it here fails.
OWNER_REACHABLE_PATHS = frozenset(
    {
        "/health",
        "/health/ready",
        "/health/capabilities",
        "/api/one/pod/status",
        "/api/one/pod/config",
        "/api/one/pod/turn",
        # NOT /api/one/pod/live: the Live websocket is walled on purpose, and
        # test_a_walled_websocket_is_closed_before_accept pins the 1008 close.
        "/api/one/puppy/relay",
        "/api/one/pod/session/challenge",
        "/api/one/pod/session/admit",
        "/api/one/pod/session/renew",
        "/api/one/pod/session/revoke",
        # The learning loop's owner doors. Each carries the turn's two-door
        # admission; see api/middlewares/pod_ingress.APP_SURFACE_EXACT for why each
        # one is reachable rather than walled.
        "/api/one/pod/conversation/{conversation_id}/close",
        "/api/one/pod/memory/status",
        "/api/one/pod/memory/revoke",
        "/api/one/pod/memory/provider-consent",
    }
)


def _concrete(path: str) -> str:
    """A template path as a real request would spell it."""
    import re

    return re.sub(r"\{[^}]+\}", "sample", path)


def test_the_owner_reachable_surface_is_exactly_these_paths():
    from api.middlewares.pod_ingress import is_app_surface

    mounted = _paths()
    assert OWNER_REACHABLE_PATHS <= mounted, (
        f"pinned as owner-reachable but not mounted: {sorted(OWNER_REACHABLE_PATHS - mounted)}"
    )
    reachable = {path for path in mounted if is_app_surface(_concrete(path))}
    assert reachable == OWNER_REACHABLE_PATHS, (
        f"newly reachable: {sorted(reachable - OWNER_REACHABLE_PATHS)}; "
        f"newly walled: {sorted(OWNER_REACHABLE_PATHS - reachable)}"
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
