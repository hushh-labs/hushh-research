"""Real route admission with synthetic identity/service boundaries."""

from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
from uuid import uuid4

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth_read_only, require_vault_owner_token
from api.routes import drive_sharing as routes
from hushh_mcp.services.drive_sharing_contract import DriveSharingError

BASE = "/api/connectors/google_drive/sharing/requests"
REQUEST_ID = str(uuid4())


@pytest.fixture
def setup(monkeypatch):
    app = FastAPI()
    app.include_router(routes.router)
    service = SimpleNamespace(
        **{
            name: AsyncMock(return_value={"status": "pending"})
            for name in (
                "create",
                "list_requests",
                "status",
                "review",
                "delivery",
                "approve",
                "decide",
                "retry_preparation",
                "prepare_revocation",
                "revoke",
            )
        }
    )
    monkeypatch.setattr(routes, "_service", lambda: service)
    current = AsyncMock(return_value={"user_id": "recipient"})
    # FastAPI retains the original dependency; this replaces only the fresh
    # post-await revalidation call, not the initial route admission.
    monkeypatch.setattr(routes, "require_vault_owner_token", current)
    return TestClient(app), app, service, current


def unlock(app, uid="recipient"):
    app.dependency_overrides[require_vault_owner_token] = lambda: {
        "user_id": uid,
        "token": "synthetic-owner",
    }


@pytest.mark.parametrize(
    "method,suffix,body",
    [
        ("get", "", None),
        ("get", f"/{REQUEST_ID}", None),
        ("get", f"/{REQUEST_ID}/review", None),
        ("get", f"/{REQUEST_ID}/delivery", None),
        ("post", f"/{REQUEST_ID}/prepare", {}),
        (
            "post",
            "",
            {
                "ownerUserId": "owner",
                "clientRequestId": str(uuid4()),
                "purpose": {"purpose": "Statements"},
            },
        ),
        (
            "post",
            f"/{REQUEST_ID}/approve",
            {
                "revision": 1,
                "reviewDigest": "a" * 64,
                "documentIds": [str(uuid4())],
                "confirmed": True,
            },
        ),
        ("post", f"/{REQUEST_ID}/decline", {"revision": 0}),
        ("post", f"/{REQUEST_ID}/cancel", {"revision": 0}),
        ("post", f"/{REQUEST_ID}/review/refresh", {"revision": 0}),
        ("post", f"/{REQUEST_ID}/revocation/prepare", None),
        (
            "post",
            f"/{REQUEST_ID}/revocation/confirm",
            {
                "revision": 1,
                "directiveId": "synthetic-directive",
                "reviewDigest": "a" * 64,
                "grantIds": [str(uuid4())],
                "confirmed": True,
            },
        ),
    ],
)
def test_every_route_requires_owner(setup, method, suffix, body):
    client, _, service, _ = setup
    response = client.request(method, BASE + suffix, json=body)
    assert response.status_code == 401
    assert "no-store" in response.headers["Cache-Control"]
    assert all(not value.called for value in vars(service).values())


def test_review_is_owner_derived_no_store_and_authority_rechecked(setup):
    client, app, service, current = setup
    unlock(app)
    service.review.return_value = {"files": [{"name": "private-name"}]}
    response = client.get(BASE + f"/{REQUEST_ID}/review")
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "private, no-store"
    service.review.assert_awaited_once_with(user_id="recipient", request_id=REQUEST_ID)
    assert current.await_count == 2
    assert all(
        call.kwargs == {"authorization": "Bearer synthetic-owner", "hushh_consent": None}
        for call in current.await_args_list
    )


def test_late_owner_revocation_releases_no_private_result(setup):
    client, app, service, current = setup
    unlock(app)
    service.review.return_value = {"files": [{"name": "private-name"}]}
    current.side_effect = [{"user_id": "recipient"}, HTTPException(401, "Owner revoked")]
    response = client.get(BASE + f"/{REQUEST_ID}/review")
    assert response.status_code == 401 and "private-name" not in response.text
    assert "no-store" in response.headers["Cache-Control"]


@pytest.mark.parametrize(
    "change",
    [
        {"email": "injected@example.invalid"},
        {"role": "owner"},
        {"generation": 9},
        {"user_id": "other"},
        {"confirmed": 1},
        {"confirmed": "true"},
    ],
)
def test_approval_does_not_accept_client_authority(setup, change):
    client, app, service, _ = setup
    unlock(app)
    body = {
        "revision": 1,
        "reviewDigest": "a" * 64,
        "documentIds": [str(uuid4())],
        "confirmed": True,
    }
    response = client.post(BASE + f"/{REQUEST_ID}/approve", json={**body, **change})
    assert response.status_code == 422
    assert "no-store" in response.headers["Cache-Control"]
    service.approve.assert_not_called()


def test_validation_never_echoes_private_payload(setup):
    client, app, _, _ = setup
    unlock(app)
    response = client.post(
        BASE + f"/{REQUEST_ID}/approve",
        json={
            "revision": "private-value-accidentally-pasted",
            "reviewDigest": "a" * 64,
            "documentIds": [str(uuid4())],
            "confirmed": True,
        },
    )
    assert response.status_code == 422
    assert "private-value-accidentally-pasted" not in response.text


def test_approval_only_acknowledges_pending_work(setup):
    client, app, service, _ = setup
    unlock(app)
    service.approve.return_value = {"status": "approved", "sharingStatus": "pending"}
    response = client.post(
        BASE + f"/{REQUEST_ID}/approve",
        json={
            "revision": 1,
            "reviewDigest": "a" * 64,
            "documentIds": [str(uuid4())],
            "confirmed": True,
        },
    )
    assert response.status_code == 202
    assert response.json() == {"status": "approved", "sharingStatus": "pending"}


@pytest.mark.parametrize(
    "error", [RuntimeError("secret-provider-body"), DriveSharingError("secret-provider-body")]
)
def test_unknown_errors_are_redacted(setup, error):
    client, app, service, _ = setup
    unlock(app)
    service.review.side_effect = error
    response = client.get(BASE + f"/{REQUEST_ID}/review")
    assert response.status_code == 503 and "secret-provider-body" not in response.text
    assert "no-store" in response.headers["Cache-Control"]


def google_identity(monkeypatch, app, *, firebase_uid="recipient", changes=None):
    app.dependency_overrides[require_firebase_auth_read_only] = lambda: firebase_uid
    claims = {
        "uid": "recipient",
        "email": "recipient@example.invalid",
        "email_verified": True,
        "auth_time": datetime.now(UTC).timestamp(),
        "firebase": {"sign_in_provider": "google.com", "identities": {"google.com": ["12345"]}},
        **(changes or {}),
    }
    app_marker = object()
    monkeypatch.setattr(routes, "get_firebase_auth_app", lambda: app_marker)
    verifier = Mock(return_value=claims)
    monkeypatch.setattr(routes.firebase_auth, "verify_id_token", verifier)
    monkeypatch.setattr(
        routes.firebase_auth,
        "get_user",
        Mock(
            return_value=SimpleNamespace(
                disabled=False,
                provider_data=[
                    SimpleNamespace(
                        provider_id="google.com", uid="12345", email="recipient@example.invalid"
                    )
                ],
            )
        ),
    )
    return verifier, app_marker


def create_body():
    return {
        "ownerUserId": "owner",
        "clientRequestId": str(uuid4()),
        "purpose": {"purpose": "Statements"},
    }


def test_request_uses_fresh_verified_google_identity_not_drive_connection(setup, monkeypatch):
    client, app, service, _ = setup
    unlock(app)
    verifier, marker = google_identity(monkeypatch, app)
    response = client.post(
        BASE, json=create_body(), headers={"Authorization": "Bearer synthetic-firebase"}
    )
    assert response.status_code == 202
    recipient = service.create.await_args.kwargs["recipient"]
    assert recipient.user_id == "recipient" and recipient.subject == "12345"
    verifier.assert_called_once_with("synthetic-firebase", app=marker, check_revoked=False)


def test_request_resolves_public_reference_without_accepting_identity_from_client(
    setup, monkeypatch
):
    client, app, service, current = setup
    unlock(app)
    google_identity(monkeypatch, app)
    target = str(uuid4())
    resolve = Mock(return_value=("resolved-owner", {"status": "connected"}))
    monkeypatch.setattr(
        routes, "PersonProfileService", lambda: SimpleNamespace(get_relationship_target=resolve)
    )
    body = {**create_body(), "ownerPersonRef": target}
    del body["ownerUserId"]
    response = client.post(BASE, json=body, headers={"Authorization": "Bearer synthetic-firebase"})
    assert response.status_code == 202
    resolve.assert_called_once_with(viewer_user_id="recipient", public_person_ref=target)
    assert service.create.await_args.kwargs["owner_user_id"] == "resolved-owner"
    assert "resolved-owner" not in response.text
    assert current.await_count >= 3


@pytest.mark.parametrize(
    "targets",
    [
        {},
        {"ownerUserId": "owner", "ownerPersonRef": str(uuid4())},
        {"ownerPersonRef": "private-invalid-value"},
    ],
)
def test_request_requires_exactly_one_valid_owner_target(setup, monkeypatch, targets):
    client, app, service, _ = setup
    unlock(app)
    google_identity(monkeypatch, app)
    body = create_body()
    del body["ownerUserId"]
    response = client.post(
        BASE, json={**body, **targets}, headers={"Authorization": "Bearer synthetic-firebase"}
    )
    assert response.status_code == 422
    assert "private-invalid-value" not in response.text
    service.create.assert_not_called()


@pytest.mark.parametrize(
    "failure",
    [routes.PersonProfileNotFoundError("missing"), TimeoutError("private-provider-error")],
)
def test_owner_reference_failure_is_redacted_and_does_not_mutate(setup, monkeypatch, failure):
    client, app, service, _ = setup
    unlock(app)
    google_identity(monkeypatch, app)
    monkeypatch.setattr(
        routes,
        "PersonProfileService",
        lambda: SimpleNamespace(get_relationship_target=Mock(side_effect=failure)),
    )
    body = create_body()
    del body["ownerUserId"]
    response = client.post(
        BASE,
        json={**body, "ownerPersonRef": str(uuid4())},
        headers={"Authorization": "Bearer synthetic-firebase"},
    )
    assert response.status_code in (404, 503)
    assert "private-provider-error" not in response.text
    service.create.assert_not_called()


def test_owner_lock_during_reference_lookup_prevents_create(setup, monkeypatch):
    client, app, service, current = setup
    unlock(app)
    google_identity(monkeypatch, app)

    def resolve(**kwargs):
        current.side_effect = HTTPException(401, "Owner locked")
        return "resolved-owner", {"status": "connected"}

    monkeypatch.setattr(
        routes, "PersonProfileService", lambda: SimpleNamespace(get_relationship_target=resolve)
    )
    body = create_body()
    del body["ownerUserId"]
    response = client.post(
        BASE,
        json={**body, "ownerPersonRef": str(uuid4())},
        headers={"Authorization": "Bearer synthetic-firebase"},
    )
    assert response.status_code == 401
    service.create.assert_not_called()


def test_crossed_firebase_and_vault_owners_fail_before_provider_lookup(setup, monkeypatch):
    client, app, service, _ = setup
    unlock(app)
    verifier, _ = google_identity(monkeypatch, app, firebase_uid="attacker")
    response = client.post(
        BASE, json=create_body(), headers={"Authorization": "Bearer synthetic-firebase"}
    )
    assert response.status_code == 403
    verifier.assert_not_called()
    service.create.assert_not_called()


@pytest.mark.parametrize(
    "changes",
    [
        {"firebase": {"identities": {"google.com": ["attacker"]}}},
        {"firebase": {"sign_in_provider": "password"}},
    ],
)
def test_missing_or_substituted_linked_identity_cannot_request(setup, monkeypatch, changes):
    client, app, service, _ = setup
    unlock(app)
    google_identity(monkeypatch, app, changes=changes)
    response = client.post(
        BASE, json=create_body(), headers={"Authorization": "Bearer synthetic-firebase"}
    )
    assert response.status_code == 409
    service.create.assert_not_called()


def test_prepare_rejects_client_claimed_foreground_authority(setup):
    client, app, _, _ = setup
    unlock(app)
    response = client.post(BASE + f"/{REQUEST_ID}/prepare", json={"foreground": True})
    assert response.status_code == 422


def test_prepare_rechecks_owner_and_sanitizes_failure(setup, monkeypatch):
    from hushh_mcp.services import drive_suggestion_service

    client, app, _, current = setup
    unlock(app)
    worker = SimpleNamespace(
        run_one=AsyncMock(side_effect=RuntimeError("private provider response"))
    )
    factory = Mock(return_value=worker)
    monkeypatch.setattr(drive_suggestion_service, "DriveSuggestionService", factory)
    response = client.post(BASE + f"/{REQUEST_ID}/prepare", json={})
    assert response.status_code == 503
    assert "private provider" not in response.text
    assert "no-store" in response.headers["Cache-Control"]
    assert current.await_count >= 1
    assert callable(factory.call_args.kwargs["require_owner"])
