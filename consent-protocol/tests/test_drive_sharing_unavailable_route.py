"""The organizer's "Don't have" route: owner-only, strict body, closed errors."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_vault_owner_token
from api.routes import drive_sharing as routes
from hushh_mcp.services.drive_sharing_contract import DriveSharingError

REQUEST_ID = "5d0c7a4e-2f61-4c3b-9a8e-0d51a7e3b001"
PATH = f"/api/connectors/google_drive/sharing/calendar-requests/{REQUEST_ID}/unavailable"


@pytest.fixture
def setup(shared_hub_owner, monkeypatch):
    app = FastAPI()
    app.include_router(routes.router)
    service = SimpleNamespace(
        mark_not_available=AsyncMock(return_value={"status": "pending", "revision": 1})
    )
    monkeypatch.setattr(routes, "_calendar_service", lambda _owner: service)
    current = AsyncMock(return_value={"user_id": "organizer"})
    monkeypatch.setattr("api.routes.drive_sharing_owner.require_vault_owner_token", current)
    return TestClient(app), app, service


def unlock(app):
    app.dependency_overrides[require_vault_owner_token] = lambda: {
        "user_id": "organizer",
        "token": "synthetic-owner",
    }


def test_requires_the_vault_owner_and_reaches_nothing_without_it(setup):
    client, _, service = setup
    response = client.post(PATH, json={"revision": 0, "types": ["recording"]})
    assert response.status_code == 401
    assert "no-store" in response.headers["Cache-Control"]
    service.mark_not_available.assert_not_called()


def test_binds_the_authenticated_owner_and_passes_only_the_closed_answer(setup):
    client, app, service = setup
    unlock(app)
    response = client.post(PATH, json={"revision": 3, "types": ["notes", "recording"]})
    assert response.status_code == 200
    assert response.json() == {"status": "pending", "revision": 1}
    service.mark_not_available.assert_awaited_once_with(
        user_id="organizer", request_id=REQUEST_ID, revision=3, types=["notes", "recording"]
    )


@pytest.mark.parametrize(
    "body",
    [
        {"revision": 0, "types": []},
        {"revision": 0, "types": ["video"]},
        {"revision": 0, "types": ["recording", "notes", "notes"]},
        {"revision": -1, "types": ["recording"]},
        {"revision": True, "types": ["recording"]},
        {"revision": "0", "types": ["recording"]},
        {"types": ["recording"]},
        {"revision": 0, "types": ["recording"], "ownerUserId": "someone-else"},
        {"revision": 0, "types": ["recording"], "requesterEmail": "a@example.invalid"},
    ],
)
def test_rejects_anything_but_the_exact_answer(setup, body):
    client, app, service = setup
    unlock(app)
    assert client.post(PATH, json=body).status_code == 422
    service.mark_not_available.assert_not_called()


def test_rejects_a_malformed_request_id(setup):
    client, app, service = setup
    unlock(app)
    bad = PATH.replace(REQUEST_ID, "not-a-uuid")
    assert client.post(bad, json={"revision": 0, "types": ["recording"]}).status_code == 422
    service.mark_not_available.assert_not_called()


@pytest.mark.parametrize(
    "code", ["request_unavailable", "review_changed", "request_already_decided"]
)
def test_service_refusals_reach_the_client_as_closed_codes(setup, code):
    client, app, service = setup
    unlock(app)
    service.mark_not_available.side_effect = DriveSharingError(code)
    response = client.post(PATH, json={"revision": 0, "types": ["recording"]})
    assert response.status_code >= 400
    assert response.json()["detail"]["code"] == code
