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
    ],
)
def test_pod_does_not_mount_central_or_unrelated_surface(forbidden_prefix):
    leaked = [p for p in _paths() if p == forbidden_prefix or p.startswith(forbidden_prefix)]
    assert not leaked, f"pod leaked central/unrelated surface: {leaked}"


def test_pod_surface_is_small():
    # A slim pod exposes a handful of routes (agent + health + docs), not the
    # monolith's hundreds. Guard against an accidental full-app mount.
    assert len(_paths()) < 25


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
