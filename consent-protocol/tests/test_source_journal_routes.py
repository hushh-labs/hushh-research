"""Owner authority and private response contract for journal replay."""

from __future__ import annotations

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from api.middleware import require_vault_owner_token
from api.routes.one import source_journal
from hushh_mcp.services.source_journal_service import SourceJournalUnavailable


def test_connector_journal_route_uses_authenticated_owner_and_private_errors(monkeypatch):
    captured: list[tuple[str, int, int]] = []

    class FakeJournal:
        async def connector_events(self, *, user_id: str, after: int, limit: int):
            captured.append((user_id, after, limit))
            return {
                "events": [],
                "nextCursor": str(after),
                "headCursor": str(after),
                "earliestCursor": "0",
                "resetRequired": False,
                "hasMore": False,
            }

    monkeypatch.setattr(source_journal, "SourceJournalService", FakeJournal)
    app = FastAPI()
    app.include_router(source_journal.router)
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "owner-1"}
    client = TestClient(app)

    response = client.get("/api/one/source-journal/connectors?after=12&limit=7")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "private, no-store"
    assert response.json()["nextCursor"] == "12"
    assert captured == [("owner-1", 12, 7)]

    for query in ("after=-1", "after=9223372036854775808", "limit=101", "limit=0"):
        response = client.get(f"/api/one/source-journal/connectors?{query}")
        assert response.status_code == 422
        assert response.headers["cache-control"] == "private, no-store"
        assert "owner-1" not in response.text
    assert captured == [("owner-1", 12, 7)]

    class UnavailableJournal:
        async def connector_events(self, *, user_id: str, after: int, limit: int):
            raise SourceJournalUnavailable("synthetic outage")

    monkeypatch.setattr(source_journal, "SourceJournalService", UnavailableJournal)
    response = client.get("/api/one/source-journal/connectors")
    assert response.status_code == 503
    assert response.headers["cache-control"] == "private, no-store"
    assert "synthetic outage" not in response.text

    class UnexpectedJournal:
        async def connector_events(self, *, user_id: str, after: int, limit: int):
            raise RuntimeError("secret diagnostic")

    monkeypatch.setattr(source_journal, "SourceJournalService", UnexpectedJournal)
    response = client.get("/api/one/source-journal/connectors")
    assert response.status_code == 503
    assert response.headers["cache-control"] == "private, no-store"
    assert "secret diagnostic" not in response.text

    def reject_owner():
        raise HTTPException(status_code=401, detail="Unauthorized")

    app.dependency_overrides[require_vault_owner_token] = reject_owner
    response = client.get("/api/one/source-journal/connectors")
    assert response.status_code == 401
    assert response.headers["cache-control"] == "private, no-store"
    assert captured == [("owner-1", 12, 7)]


def test_source_journal_route_uses_owner_and_never_leaks_errors(monkeypatch):
    captured: list[tuple[str, int, int]] = []

    class FakeJournal:
        async def events(self, *, user_id: str, after: int, limit: int):
            captured.append((user_id, after, limit))
            return {
                "events": [{"sequence": "8", "sourceKind": "profile", "operation": "changed"}],
                "nextCursor": "8",
                "headCursor": "8",
                "earliestCursor": "0",
                "resetRequired": False,
                "hasMore": False,
            }

    monkeypatch.setattr(source_journal, "SourceJournalService", FakeJournal)
    app = FastAPI()
    app.include_router(source_journal.router)
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "owner-1"}
    client = TestClient(app)
    response = client.get("/api/one/source-journal/events?after=7&limit=5")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "private, no-store"
    assert response.json()["events"][0]["sourceKind"] == "profile"
    assert captured == [("owner-1", 7, 5)]
    for query in ("after=-1", "after=9223372036854775808", "limit=101"):
        response = client.get(f"/api/one/source-journal/events?{query}")
        assert response.status_code == 422
        assert response.headers["cache-control"] == "private, no-store"
    assert captured == [("owner-1", 7, 5)]

    class UnavailableJournal:
        async def events(self, *, user_id: str, after: int, limit: int):
            raise SourceJournalUnavailable("private diagnostics")

    monkeypatch.setattr(source_journal, "SourceJournalService", UnavailableJournal)
    response = client.get("/api/one/source-journal/events")
    assert response.status_code == 503
    assert "private diagnostics" not in response.text
