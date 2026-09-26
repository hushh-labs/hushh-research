from __future__ import annotations

from unittest.mock import AsyncMock, Mock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes import profile_discovery_work_drain as routes

PATH = "/api/internal/profile-discovery/drain"


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("ONE_PUBLIC_PROFILE_DISCOVERY_ENABLED", "true")
    monkeypatch.setenv("ONE_PUBLIC_PROFILE_DISCOVERY_DRAIN_ENABLED", "true")
    app = FastAPI()
    app.include_router(routes.router)
    return TestClient(app)


def test_worker_is_default_off(client, monkeypatch):
    monkeypatch.setenv("ONE_PUBLIC_PROFILE_DISCOVERY_DRAIN_ENABLED", "false")
    identity = Mock()
    monkeypatch.setattr(routes, "verified_scheduler_identity", identity)
    response = client.post(PATH, headers={"Authorization": "Bearer token"}, json={})
    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "PROFILE_DISCOVERY_DRAIN_DISABLED"
    identity.assert_not_called()


def test_worker_requires_scheduler_identity(client, monkeypatch):
    monkeypatch.setattr(routes, "verified_scheduler_identity", lambda *_: None)
    response = client.post(PATH, json={})
    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "PROFILE_DISCOVERY_DRAIN_UNAUTHORIZED"


@pytest.mark.parametrize("body", ["not-json", "[]", '{"stage":"all"}'])
def test_worker_rejects_malformed_or_unexpected_body(client, monkeypatch, body):
    monkeypatch.setattr(routes, "verified_scheduler_identity", lambda *_: object())
    response = client.post(PATH, content=body, headers={"Content-Type": "application/json"})
    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "PROFILE_DISCOVERY_DRAIN_INVALID_BODY"


def test_worker_drains_bounded_jobs_and_safe_feed_projection(client, monkeypatch):
    monkeypatch.setattr(routes, "verified_scheduler_identity", lambda *_: object())
    drain = AsyncMock(return_value={"started": 1, "running": 2})
    outbox = AsyncMock(return_value=3)

    class Worker:
        def drain(self, **kwargs):
            assert kwargs == {"max_jobs": 4}
            return drain()

        def drain_feed_outbox(self, **kwargs):
            assert kwargs == {"max_rows": 50}
            return outbox()

    monkeypatch.setattr(routes, "PublicProfileDiscoveryService", Worker)
    response = client.post(PATH, json={})
    assert response.status_code == 200
    assert response.json() == {
        "ok": True,
        "outcomes": {"started": 1, "running": 2},
        "feed_rows_settled": 3,
    }
    drain.assert_awaited_once()
    outbox.assert_awaited_once()
