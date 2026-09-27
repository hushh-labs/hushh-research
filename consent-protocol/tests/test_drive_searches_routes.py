"""Owner-only search authorization and private failure responses."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from api.middleware import require_vault_owner_token
from api.routes import drive_searches as routes
from hushh_mcp.services.drive_suggestion_service import LiveSearchPlan

BASE = "/api/connectors/google_drive/searches"
JOB = "fc110012-1111-4111-8111-111111111111"
BODY = {"clientRequestId": JOB, "query": "find my product documents", "backgroundConsent": True}


@pytest.fixture
def setup(monkeypatch):
    app = FastAPI()
    app.include_router(routes.router)
    service = SimpleNamespace(
        **{
            name: AsyncMock(return_value={"jobId": JOB, "status": "queued"})
            for name in ("create", "list", "status", "results", "stop")
        }
    )
    service.existing = AsyncMock(return_value=None)
    current = AsyncMock()
    monkeypatch.setattr(routes.Owner, "require_current", current)
    monkeypatch.setattr(routes, "_service", lambda: service)
    monkeypatch.setattr(routes, "connector_feature_enabled", lambda *_: True)
    planner = AsyncMock(return_value=LiveSearchPlan(terms=["product"], mode="find"))
    monkeypatch.setattr(routes, "plan_live_search", planner)
    return app, TestClient(app), service, current, planner


def unlock(app):
    app.dependency_overrides[require_vault_owner_token] = lambda: {
        "user_id": "synthetic-owner",
        "token": "synthetic-test-owner",
    }


@pytest.mark.parametrize(
    "method,path,body",
    [
        ("post", "", BODY),
        ("get", "", None),
        ("get", f"/{JOB}", None),
        ("get", f"/{JOB}/results", None),
        ("post", f"/{JOB}/stop", {}),
    ],
)
def test_search_endpoints_require_owner_and_never_echo_input(setup, method, path, body):
    _, client, service, _, planner = setup
    response = client.request(method, BASE + path, json=body)
    assert response.status_code == 401
    assert "no-store" in response.headers["Cache-Control"]
    assert BODY["query"] not in response.text
    planner.assert_not_awaited()
    assert not any(mock.called for mock in vars(service).values())


def test_create_requires_search_specific_consent_and_rechecks_after_planner(setup):
    app, client, service, current, planner = setup
    unlock(app)
    response = client.post(BASE, json={**BODY, "backgroundConsent": False})
    assert response.status_code == 400
    planner.assert_not_awaited()
    current.reset_mock()
    current.side_effect = [None, HTTPException(403, "expired")]
    response = client.post(BASE, json=BODY)
    assert response.status_code == 403
    service.create.assert_not_awaited()
    current.side_effect = None
    response = client.post(BASE, json=BODY)
    assert response.status_code == 200
    call = service.create.await_args.kwargs
    assert call["user_id"] == "synthetic-owner" and call["background_consent"] is True
    assert call["plan"]["mode"] == "find"
    assert "token" not in call and "consent_token" not in call


def test_read_plan_cannot_start_background_content_reads_and_validation_is_private(setup):
    app, client, service, _, planner = setup
    unlock(app)
    planner.return_value = LiveSearchPlan(terms=["product"], mode="read")
    response = client.post(BASE, json=BODY)
    assert response.status_code == 400
    service.create.assert_not_awaited()
    response = client.post(BASE, json={**BODY, "private_extra": "PRIVATE_SECRET"})
    assert response.status_code == 422
    assert "PRIVATE_SECRET" not in response.text
    assert BODY["query"] not in response.text


def test_retry_reuses_job_without_replanning(setup):
    app, client, service, _, planner = setup
    unlock(app)
    service.existing.return_value = {"jobId": JOB, "status": "running"}
    response = client.post(BASE, json=BODY)
    assert response.status_code == 200
    assert response.json()["jobId"] == JOB
    planner.assert_not_awaited()
    service.create.assert_not_awaited()
    assert service.existing.await_args.kwargs["query"] == BODY["query"]


def test_stop_remains_available_when_search_feature_disabled(setup, monkeypatch):
    app, client, service, _, _ = setup
    unlock(app)
    monkeypatch.setattr(routes, "connector_feature_enabled", lambda *_: False)
    assert client.post(BASE + f"/{JOB}/stop", json={}).status_code == 200
    service.stop.assert_awaited_once()
    assert client.get(BASE).status_code == 200
    assert client.get(BASE + f"/{JOB}").status_code == 200
    assert client.get(BASE + f"/{JOB}/results").status_code == 503
    assert client.post(BASE, json=BODY).status_code == 503
