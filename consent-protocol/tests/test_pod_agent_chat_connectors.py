"""Settings' connector refresh and connector login run in the owner's agent.

For an own-cloud owner the connector's access token, the authorization code and
the issued tokens must never reach the hub. These prove the agent-side doors bind
every attempt to the pod session's owner, use the same fixed return address as the
hub, and admit catalog discovery with the pod's own session authority rather than a
hub-verified token.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes import external_connectors
from api.routes.one import pod_agent_chat, pod_agent_chat_connectors
from api.routes.one.pod_chat_owner import owner_context

CONNECTOR = "custom_" + "a" * 32
BASE = f"/api/one/pod/agent-chat/connectors/{CONNECTOR}"
CONFIGURATION = {
    "version": 1,
    "connectorId": CONNECTOR,
    "revision": "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
    "displayName": "Synthetic",
    "endpoint": "https://example.com/mcp",
    "enabled": True,
    "authentication": {"kind": "oauth", "accessToken": "synthetic-access", "expiresAt": 4070908800},
}


def _owner(owner_id: str = "owner-a"):
    return SimpleNamespace(
        owner=owner_id,
        claims={"user_id": owner_id},
        authority=SimpleNamespace(local_token=lambda claims: "pod-local-token"),
        require_access=AsyncMock(),
        _mcp_owner_admission=AsyncMock(return_value=True),
    )


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(
        external_connectors,
        "get_app_runtime_settings",
        lambda: SimpleNamespace(environment="dev", app_frontend_origin="https://app.example"),
    )
    owner = _owner()
    app = FastAPI()
    app.include_router(pod_agent_chat.router)
    app.dependency_overrides[owner_context] = lambda: owner
    return TestClient(app), owner


def test_login_begin_and_complete_are_bound_to_the_pod_sessions_owner(client, monkeypatch):
    http, _ = client
    attempts = pod_agent_chat_connectors.mcp_oauth_attempts
    begin = AsyncMock(return_value={"attemptId": "a" * 43, "authorizeUrl": "https://auth/x"})
    monkeypatch.setattr(attempts, "begin", begin)
    started = http.post(
        f"{BASE}/mcp/oauth/begin",
        json={"revision": CONFIGURATION["revision"], "endpoint": "https://mcp.example/mcp"},
    )
    assert started.status_code == 200, started.text
    assert started.headers["cache-control"] == "no-store"
    assert started.json()["redirectUri"] == (
        "https://app.example/one/profile/connectors/oauth/return"
    )
    assert begin.await_args.kwargs["owner_id"] == "owner-a"
    tokens = SimpleNamespace(model_dump=lambda **_: {"access_token": "issued"})
    complete = AsyncMock(
        return_value=SimpleNamespace(
            tokens=tokens, client_info=SimpleNamespace(model_dump=lambda **_: {}), expires_at=1
        )
    )
    monkeypatch.setattr(attempts, "complete", complete)
    finished = http.post(
        f"{BASE}/mcp/oauth/complete",
        json={
            "revision": CONFIGURATION["revision"],
            "attemptId": "a" * 43,
            "code": "synthetic-code",
            "state": "synthetic-state",
        },
    )
    assert finished.status_code == 200
    assert complete.await_args.kwargs["owner_id"] == "owner-a"
    assert finished.json()["tokens"] == {"access_token": "issued"}


def test_only_custom_connectors_may_log_in_and_failures_echo_nothing(client, monkeypatch):
    http, _ = client
    refused = http.post(
        "/api/one/pod/agent-chat/connectors/gmail/mcp/oauth/begin",
        json={"revision": CONFIGURATION["revision"], "endpoint": "https://mcp.example/mcp"},
    )
    assert refused.status_code == 400
    monkeypatch.setattr(
        pod_agent_chat_connectors.mcp_oauth_attempts,
        "complete",
        AsyncMock(side_effect=RuntimeError("synthetic-provider-detail")),
    )
    failed = http.post(
        f"{BASE}/mcp/oauth/complete",
        json={
            "revision": CONFIGURATION["revision"],
            "attemptId": "a" * 43,
            "code": "c",
            "state": "s",
        },
    )
    assert failed.status_code == 409
    assert "synthetic-provider-detail" not in failed.text


def test_catalog_refresh_runs_in_the_agent_with_the_owner_object(client, monkeypatch):
    from hushh_mcp.one_adk import pod_mcp_catalog

    http, owner = client
    assert http.post(f"{BASE}/mcp/catalog", json={}).status_code == 400
    discover = AsyncMock(return_value={"connectorId": CONNECTOR, "status": "empty", "tools": []})
    monkeypatch.setattr(pod_mcp_catalog, "discover_private_catalog", discover)
    response = http.post(f"{BASE}/mcp/catalog", json={"connectorConfiguration": CONFIGURATION})
    assert response.status_code == 200
    assert discover.await_args.kwargs["owner"] is owner
    assert discover.await_args.kwargs["configuration"]["connectorId"] == CONNECTOR


async def test_catalog_discovery_is_admitted_by_the_pod_never_by_a_hub_token(monkeypatch):
    from hushh_mcp.one_adk import pod_mcp_catalog

    seen: dict = {}

    class Toolset:
        review_policy = None

        async def get_tools(self, context):
            return []

    @asynccontextmanager
    async def scope(thread, **kwargs):
        seen.update(kwargs)
        yield SimpleNamespace(acquire=AsyncMock(return_value=Toolset()))

    monkeypatch.setattr(pod_mcp_catalog, "mcp_turn_scope", scope)
    owner = _owner()
    result = await pod_mcp_catalog.discover_private_catalog(owner, CONNECTOR, CONFIGURATION)
    assert result["status"] == "empty" and result["connectorId"] == CONNECTOR
    assert seen["owner_admission"] is owner._mcp_owner_admission
    assert seen["vault_only"] is True and seen["owner_id"] == "owner-a"
    assert owner.require_access.await_count == 2
