"""Bulk sharing routes expose only owner-reviewed, server-bound file sets."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from api.middleware import require_vault_owner_token
from api.routes import drive_sharing as routes
from hushh_mcp.services.drive_sharing_contract import DriveSharingError

BASE = "/api/connectors/google_drive/sharing/bulk"
SEARCH = "d188c49d-f13b-440f-889d-76165a823552"
CLIENT = "4e395607-251f-4b99-93ed-c1e43adb29c4"
SHARE = "dbb2e77b-d510-4eaf-86da-879a9b34ebad"
BODY = {"searchJobId": SEARCH, "clientRequestId": CLIENT, "audience": "trusted_circle"}


@pytest.fixture
def setup(monkeypatch):
    app = FastAPI()
    app.include_router(routes.router)
    service = SimpleNamespace(
        **{
            method: AsyncMock(return_value={"shareId": SHARE, "status": "review_ready"})
            for method in (
                "prepare",
                "list",
                "review",
                "files",
                "approve",
                "stop",
                "received",
                "received_files",
            )
        }
    )
    current = AsyncMock(return_value={"user_id": "owner-a"})
    monkeypatch.setattr(routes, "_bulk_share_service", lambda: service)
    monkeypatch.setattr(routes, "require_vault_owner_token", current)
    return app, TestClient(app), service, current


def unlock(app):
    app.dependency_overrides[require_vault_owner_token] = lambda: {
        "user_id": "owner-a",
        "token": "synthetic-owner",
    }


@pytest.mark.parametrize(
    "method,path,body",
    [
        ("post", "", BODY),
        ("get", "", None),
        ("get", f"/{SHARE}", None),
        ("get", f"/{SHARE}/files", None),
        ("get", "/received", None),
        ("get", f"/received/{SHARE}/files", None),
        ("post", f"/{SHARE}/approve", {"revision": 1, "reviewDigest": "a" * 64, "confirmed": True}),
        ("post", f"/{SHARE}/stop", {}),
    ],
)
def test_every_bulk_route_requires_owner(setup, method, path, body):
    _, client, service, _ = setup
    response = client.request(method, BASE + path, json=body)
    assert response.status_code == 401
    assert "no-store" in response.headers["Cache-Control"]
    assert not any(getattr(service, name).called for name in vars(service))


def test_prepare_binds_saved_job_and_verified_audience(setup):
    app, client, service, current = setup
    unlock(app)
    response = client.post(BASE, json=BODY)
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "private, no-store"
    service.prepare.assert_awaited_once_with(
        user_id="owner-a", search_job_id=SEARCH, client_request_id=CLIENT
    )
    assert current.await_count == 2


@pytest.mark.parametrize(
    "change",
    [
        {"audience": "public"},
        {"fileIds": ["invented-provider-id"]},
        {"recipientEmail": "other@example.test"},
        {"ownerUserId": "other"},
    ],
)
def test_prepare_rejects_caller_supplied_file_or_recipient_authority(setup, change):
    app, client, service, _ = setup
    unlock(app)
    response = client.post(BASE, json={**BODY, **change})
    assert response.status_code == 422
    assert "no-store" in response.headers["Cache-Control"]
    service.prepare.assert_not_awaited()


def test_history_preview_and_approval_keep_owner_scope(setup):
    app, client, service, _ = setup
    unlock(app)
    assert client.get(BASE).status_code == 200
    service.list.assert_awaited_with(user_id="owner-a", search_job_id=None)
    assert client.get(BASE + f"?searchJobId={SEARCH}").status_code == 200
    service.list.assert_awaited_with(user_id="owner-a", search_job_id=SEARCH)
    assert client.get(BASE + f"/{SHARE}/files?cursor=opaque").status_code == 200
    service.files.assert_awaited_once_with(user_id="owner-a", share_id=SHARE, cursor="opaque")
    response = client.post(
        BASE + f"/{SHARE}/approve",
        json={"revision": 2, "reviewDigest": "b" * 64, "confirmed": True},
    )
    assert response.status_code == 202
    service.approve.assert_awaited_once_with(
        user_id="owner-a", share_id=SHARE, revision=2, review_digest="b" * 64
    )


def test_recipient_collection_routes_are_owner_authenticated_and_private(setup):
    app, client, service, _ = setup
    unlock(app)
    inbox = client.get(BASE + "/received")
    files = client.get(BASE + f"/received/{SHARE}/files?cursor=opaque")
    assert inbox.status_code == 200 and files.status_code == 200
    assert "no-store" in inbox.headers["Cache-Control"]
    assert "no-store" in files.headers["Cache-Control"]
    service.received.assert_awaited_once_with(user_id="owner-a")
    service.received_files.assert_awaited_once_with(
        user_id="owner-a", share_id=SHARE, cursor="opaque"
    )
    service.review.assert_not_awaited()


def test_late_revocation_hides_private_review(setup):
    app, client, service, current = setup
    unlock(app)
    service.review.return_value = {"fileCount": 2000, "recipients": [{"email": "private@test"}]}
    current.side_effect = [{"user_id": "owner-a"}, HTTPException(401, "revoked")]
    response = client.get(BASE + f"/{SHARE}")
    assert response.status_code == 401
    assert "private@test" not in response.text


def test_approval_requires_exact_revision_and_review_digest(setup):
    app, client, service, _ = setup
    unlock(app)
    response = client.post(
        BASE + f"/{SHARE}/approve",
        json={"revision": "2", "reviewDigest": "b" * 64, "confirmed": True},
    )
    assert response.status_code == 422
    response = client.post(
        BASE + f"/{SHARE}/approve",
        json={"revision": 2, "reviewDigest": "not-a-digest", "confirmed": True},
    )
    assert response.status_code == 422
    service.approve.assert_not_awaited()


@pytest.mark.parametrize("confirmed", [None, False, "true", 1])
def test_bulk_approval_requires_explicit_true_confirmation(setup, confirmed):
    app, client, service, _ = setup
    unlock(app)
    body = {"revision": 2, "reviewDigest": "b" * 64}
    if confirmed is not None:
        body["confirmed"] = confirmed
    response = client.post(BASE + f"/{SHARE}/approve", json=body)
    assert response.status_code == 422
    service.approve.assert_not_awaited()


def test_incomplete_search_never_becomes_a_review_or_leaks_provider_text(setup):
    app, client, service, _ = setup
    unlock(app)
    service.prepare.side_effect = DriveSharingError("search_incomplete")
    response = client.post(BASE, json=BODY)
    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "search_incomplete"
    assert "no-store" in response.headers["Cache-Control"]
    assert SEARCH not in response.text
