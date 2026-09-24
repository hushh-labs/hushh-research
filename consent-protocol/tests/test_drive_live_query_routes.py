"""Route admission for owner-allowed Drive questions, with a synthetic service."""

from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_vault_owner_token
from api.routes import drive_sharing as routes
from hushh_mcp.services.drive_sharing_contract import DriveSharingError

BASE = "/api/connectors/google_drive/sharing/queries"
REQUEST_ID = str(uuid4())
OWNER_PROOF = "synthetic-owner"


@pytest.fixture
def setup(monkeypatch):
    app = FastAPI()
    app.include_router(routes.router)
    service = SimpleNamespace(
        **{
            name: AsyncMock(return_value={"status": "pending"})
            for name in ("create", "list_requests", "status", "allow", "deny")
        }
    )
    monkeypatch.setattr(routes, "_query_service", lambda: service)
    # The legacy file-sharing service must never serve a question route.
    monkeypatch.setattr(routes, "_service", lambda: pytest.fail("legacy service used"))
    current = AsyncMock(return_value={"user_id": "requester"})
    monkeypatch.setattr(routes, "require_vault_owner_token", current)
    return TestClient(app), app, service, current


def unlock(app, current, uid="requester"):
    current.return_value = {"user_id": uid}
    app.dependency_overrides[require_vault_owner_token] = lambda: {
        "user_id": uid,
        "token": OWNER_PROOF,
    }


def create_body(**changes):
    return {
        "ownerUserId": "owner",
        "clientRequestId": str(uuid4()),
        "query": "potential bank statement",
        **changes,
    }


@pytest.mark.parametrize(
    "method,suffix,body",
    [
        ("post", "", create_body()),
        ("get", "", None),
        ("get", f"/{REQUEST_ID}", None),
        ("post", f"/{REQUEST_ID}/allow", {"revision": 1}),
        ("post", f"/{REQUEST_ID}/deny", {"revision": 1}),
    ],
)
def test_every_question_route_requires_the_vault_owner(setup, method, suffix, body):
    client, _, service, _ = setup
    response = client.request(method, BASE + suffix, json=body)
    assert response.status_code == 401
    assert "no-store" in response.headers["Cache-Control"]
    assert all(not value.called for value in vars(service).values())


def test_create_binds_the_requester_to_the_caller_without_a_google_identity(setup):
    client, app, service, current = setup
    unlock(app, current)
    body = create_body()
    response = client.post(BASE, json=body)
    assert response.status_code == 202
    assert response.headers["Cache-Control"] == "private, no-store"
    service.create.assert_awaited_once_with(
        requester_user_id="requester",
        owner_user_id="owner",
        client_request_id=body["clientRequestId"],
        query="potential bank statement",
    )
    assert current.await_count == 2


def test_create_resolves_a_public_person_reference_server_side(setup, monkeypatch):
    client, app, service, current = setup
    unlock(app, current)
    resolve = SimpleNamespace(get_relationship_target=lambda **kwargs: ("owner", {}))
    monkeypatch.setattr(routes, "PersonProfileService", lambda: resolve)
    body = create_body(ownerUserId=None, ownerPersonRef=str(uuid4()))
    body.pop("ownerUserId")
    assert client.post(BASE, json=body).status_code == 202
    assert service.create.await_args.kwargs["owner_user_id"] == "owner"


@pytest.mark.parametrize(
    "body",
    [
        create_body(query=""),
        create_body(query="x" * 2001),
        create_body(purpose={"purpose": "legacy"}),
        {"clientRequestId": str(uuid4()), "query": "no owner"},
    ],
)
def test_invalid_questions_are_rejected_without_echo(setup, body):
    client, app, service, current = setup
    unlock(app, current)
    response = client.post(BASE, json=body)
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "invalid_argument"
    assert "x" * 50 not in response.text
    service.create.assert_not_called()


def test_allow_carries_the_owner_token_revision_and_time_zone(setup):
    client, app, service, current = setup
    unlock(app, current, "owner")
    response = client.post(
        BASE + f"/{REQUEST_ID}/allow", json={"revision": 3, "timeZone": "Asia/Kolkata"}
    )
    assert response.status_code == 200
    service.allow.assert_awaited_once_with(
        user_id="owner",
        request_id=REQUEST_ID,
        revision=3,
        consent_token=OWNER_PROOF,
        timezone="Asia/Kolkata",
    )


def test_allow_defaults_to_utc_and_rejects_a_malformed_zone(setup):
    client, app, service, current = setup
    unlock(app, current, "owner")
    assert client.post(BASE + f"/{REQUEST_ID}/allow", json={"revision": 1}).status_code == 200
    assert service.allow.await_args.kwargs["timezone"] == "UTC"
    response = client.post(
        BASE + f"/{REQUEST_ID}/allow", json={"revision": 1, "timeZone": "'; drop"}
    )
    assert response.status_code == 422


def test_deny_and_reads_are_owner_derived(setup):
    client, app, service, current = setup
    unlock(app, current, "owner")
    assert client.post(BASE + f"/{REQUEST_ID}/deny", json={"revision": 2}).status_code == 200
    service.deny.assert_awaited_once_with(user_id="owner", request_id=REQUEST_ID, revision=2)
    assert client.get(BASE + f"/{REQUEST_ID}").status_code == 200
    service.status.assert_awaited_once_with(user_id="owner", request_id=REQUEST_ID)
    assert client.get(BASE + "?direction=outgoing&limit=5").status_code == 200
    service.list_requests.assert_awaited_once_with(
        user_id="owner", direction="outgoing", limit=5, offset=0
    )


@pytest.mark.parametrize(
    "code,status",
    [
        ("request_expired", 409),
        ("request_already_decided", 409),
        ("request_changed", 409),
        ("reconnect_required", 409),
        ("connection_required", 409),
        ("request_unavailable", 404),
        ("drive_query_unavailable", 503),
        ("sharing_unavailable", 503),
        ("invalid_argument", 422),
    ],
)
def test_allow_errors_are_closed_codes(setup, code, status):
    client, app, service, current = setup
    unlock(app, current, "owner")
    service.allow.side_effect = DriveSharingError(code)
    response = client.post(BASE + f"/{REQUEST_ID}/allow", json={"revision": 1})
    assert response.status_code == status
    assert response.json()["detail"]["code"] == code
    assert "no-store" in response.headers["Cache-Control"]


def test_unexpected_failures_never_leak_details(setup):
    client, app, service, current = setup
    unlock(app, current, "owner")
    service.allow.side_effect = RuntimeError("secret provider detail")
    response = client.post(BASE + f"/{REQUEST_ID}/allow", json={"revision": 1})
    assert response.status_code == 503
    assert "secret" not in response.text
