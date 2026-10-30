"""Vault owner boundary and private failures for requester payment snapshots."""

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_vault_owner_token
from api.routes.one import requester_document_payment_source as source_routes
from hushh_mcp.services.requester_document_payment_source import (
    RequesterDocumentPaymentSourceCapacity,
    RequesterDocumentPaymentSourceUnavailable,
)

PATH = "/api/one/source-snapshots/document-request-payments"


def test_owner_token_is_required_and_query_cannot_select_another_owner(monkeypatch):
    seen = []

    class Source:
        async def snapshot(self, *, user_id):
            seen.append(user_id)
            return {
                "schemaVersion": 1,
                "ownerUserId": user_id,
                "sourceReadVerified": True,
                "asOf": "2026-10-15T00:00:00+00:00",
                "items": [],
            }

    monkeypatch.setattr(source_routes, "RequesterDocumentPaymentSourceService", Source)
    app = FastAPI()
    app.include_router(source_routes.router)
    client = TestClient(app)
    unauthorized = client.get(PATH)
    assert unauthorized.status_code == 401
    assert unauthorized.headers["cache-control"] == "private, no-store"
    assert seen == []

    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "owner-A"}
    response = client.get(PATH + "?user_id=owner-B&owner=owner-B")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "private, no-store"
    assert response.json()["ownerUserId"] == "owner-A"
    assert seen == ["owner-A"]


def test_incomplete_and_unexpected_reads_fail_privately(monkeypatch):
    state = {"error": RequesterDocumentPaymentSourceUnavailable("private-token")}

    class Source:
        async def snapshot(self, *, user_id):
            raise state["error"]

    monkeypatch.setattr(source_routes, "RequesterDocumentPaymentSourceService", Source)
    app = FastAPI()
    app.include_router(source_routes.router)
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "owner-A"}
    client = TestClient(app)
    for error, code in (
        (RequesterDocumentPaymentSourceUnavailable("private-token"), "SOURCE_UNAVAILABLE"),
        (RequesterDocumentPaymentSourceCapacity("private-token"), "SOURCE_CAPACITY_EXCEEDED"),
        (RuntimeError("private-token"), "SOURCE_UNAVAILABLE"),
    ):
        state["error"] = error
        response = client.get(PATH)
        assert response.status_code == 503
        assert response.headers["cache-control"] == "private, no-store"
        assert response.json()["detail"]["code"] == code
        assert "private-token" not in response.text
