"""The mounted Mail scan route preserves owner authority and private responses."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth
from api.routes.kai import gmail
from hushh_mcp.services.owner_placement_guard import hub_content_owner


@pytest.fixture
def nudges_client(monkeypatch):
    app = FastAPI()
    app.include_router(gmail.router, prefix="/api/kai")
    app.dependency_overrides[require_firebase_auth] = lambda: "owner"
    app.dependency_overrides[hub_content_owner] = lambda: {"user_id": "owner"}
    access = AsyncMock()
    calls = []

    async def read(**kwargs):
        calls.append(kwargs)
        if kwargs.get("require_access"):
            await kwargs["require_access"]()
        return {"user_id": "owner", "nudges": [], "next_cursor": None}

    monkeypatch.setattr(gmail, "_service", lambda: SimpleNamespace(list_nudges=read))
    monkeypatch.setattr(gmail, "_revalidate_live_receipt_access", access)
    with TestClient(app) as client:
        yield client, calls, access


def test_scan_response_is_private_and_query_validation_precedes_provider_access(nudges_client):
    client, calls, access = nudges_client
    response = client.get("/api/kai/gmail/nudges/owner?scan_all=true")
    assert response.status_code == 200 and response.json()["user_id"] == "owner"
    assert response.headers["cache-control"] == "private, no-store"
    assert calls[0]["scan_all"] is True
    access.assert_awaited_once_with(token_data={"user_id": "owner"}, owner="owner")
    assert client.get("/api/kai/gmail/nudges/other-owner?scan_all=true").status_code == 403
    assert (
        client.get("/api/kai/gmail/nudges/owner", params={"cursor": "x" * 8193}).status_code == 422
    )
    assert len(calls) == 1


def test_mid_scan_revocation_keeps_its_authority_status(nudges_client):
    client, _, access = nudges_client
    access.side_effect = HTTPException(status_code=403, detail="Access retired")
    response = client.get("/api/kai/gmail/nudges/owner?scan_all=true")
    assert response.status_code == 403
