"""Owner binding, private errors and the default-off group API contract."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from api.middleware import require_vault_owner_token
from api.routes import drive_groups as routes
from api.routes import drive_sharing_owner
from hushh_mcp.services import owner_placement_guard
from hushh_mcp.services.drive_groups.contract import FLAG
from hushh_mcp.services.drive_groups.folders import load_folders
from hushh_mcp.services.external_connector_lifecycle_store import ConnectorLifecycleError
from hushh_mcp.services.google_drive_adapter import DriveReadError

BASE = "/api/connectors/google_drive/groups"
ENDPOINTS = [
    ("get", "", None),
    (
        "post",
        "/processing",
        {"enabled": True, "disclosure": "drive-four-group-v1", "timeZone": "Asia/Kolkata"},
    ),
    ("get", "/financial_statements/files", None),
    ("post", "/erase", {"confirmed": True}),
]


@pytest.fixture
def setup(monkeypatch):
    monkeypatch.setenv(FLAG, "true")
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("CONNECTOR_INTERNAL_OWNER_COHORT", "owner")
    monkeypatch.setenv("CONNECTOR_UAT_ALL_USERS", "false")
    app = FastAPI()
    app.include_router(routes.router)
    store = SimpleNamespace(
        **{
            name: AsyncMock(return_value={})
            for name in ("status", "folders", "set_processing", "files", "erase")
        }
    )
    store.status.return_value = {"state": "off", "indexedFiles": 0}
    store.folders.return_value = []
    monkeypatch.setattr(routes, "_store", lambda: store)
    current = AsyncMock(return_value={"user_id": "owner"})
    monkeypatch.setattr(drive_sharing_owner, "require_vault_owner_token", current)
    monkeypatch.setattr(
        owner_placement_guard, "get_owner_hosting_mode", AsyncMock(return_value="shared")
    )
    return TestClient(app), app, store, current


def unlock(app):
    app.dependency_overrides[require_vault_owner_token] = lambda: {
        "user_id": "owner",
        "token": "synthetic-owner",
    }


def test_enabled_global_flag_cannot_admit_an_owner_outside_the_cohort(setup, monkeypatch):
    client, app, store, _ = setup
    unlock(app)
    monkeypatch.setenv("CONNECTOR_INTERNAL_OWNER_COHORT", "another-owner")
    response = client.get(BASE)
    assert response.status_code == 404
    assert response.headers["Cache-Control"] == "private, no-store"
    assert all(not method.called for method in vars(store).values())


@pytest.mark.parametrize("method,suffix,body", ENDPOINTS)
def test_every_endpoint_requires_owner_and_is_private(setup, method, suffix, body):
    client, _, store, _ = setup
    response = client.request(method, BASE + suffix, json=body)
    assert response.status_code == 401
    assert response.headers["Cache-Control"] == "private, no-store"
    assert all(not method.called for method in vars(store).values())


@pytest.mark.parametrize("method,suffix,body", ENDPOINTS)
def test_flag_off_hides_every_endpoint_before_store_or_body_validation(
    setup, monkeypatch, method, suffix, body
):
    client, app, store, _ = setup
    unlock(app)
    monkeypatch.delenv(FLAG)
    response = client.request(method, BASE + suffix, json=body)
    assert response.status_code == 404 and response.headers["Cache-Control"] == "private, no-store"
    assert all(not method.called for method in vars(store).values())


def test_api_uses_only_authenticated_owner_and_existing_store_projection(setup):
    client, app, store, current = setup
    unlock(app)
    response = client.get(BASE)
    assert response.json() == {
        "status": {"state": "off", "indexedFiles": 0},
        "folders": [],
        "groups": [{"shelf": shelf, "name": name} for shelf, name in load_folders().names.items()],
    }
    assert response.headers["Cache-Control"] == "private, no-store"
    store.status.assert_awaited_once_with(user_id="owner")
    store.folders.assert_awaited_once_with(user_id="owner")
    body = ENDPOINTS[1][2]
    assert client.post(BASE + "/processing", json=body).status_code == 200
    store.set_processing.assert_awaited_once_with(
        user_id="owner", enabled=True, disclosure=body["disclosure"], time_zone="Asia/Kolkata"
    )
    assert (
        client.get(
            BASE + "/financial_statements/files?period=FY26-Q1&cursor=2&limit=10"
        ).status_code
        == 200
    )
    store.files.assert_awaited_once_with(
        user_id="owner", shelf="financial_statements", period="FY26-Q1", cursor=2, limit=10
    )
    assert client.post(BASE + "/erase", json={"confirmed": True}).status_code == 200
    store.erase.assert_awaited_once_with(user_id="owner")
    assert current.await_count == 8


@pytest.mark.parametrize(
    "suffix,body",
    [
        ("/processing", {"enabled": True, "disclosure": "wrong", "timeZone": "UTC"}),
        ("/processing", {"enabled": "true", "timeZone": "private-value"}),
        ("/processing", {"enabled": False, "timeZone": "UTC", "userId": "someone-else"}),
        ("/processing", {"enabled": True, "disclosure": "drive-four-group-v1"}),
        ("/erase", {"confirmed": False}),
        ("/erase", {"confirmed": 1}),
    ],
)
def test_invalid_mutations_do_no_work_and_never_echo_input(setup, suffix, body):
    client, app, store, _ = setup
    unlock(app)
    response = client.post(BASE + suffix, json=body)
    assert response.status_code in (400, 422)
    assert "private-value" not in response.text and "someone-else" not in response.text
    assert response.headers["Cache-Control"] == "private, no-store"
    assert all(not method.called for method in vars(store).values())


@pytest.mark.parametrize("query", ["cursor=-1", "limit=101", "cursor=private-value", "limit=0"])
def test_invalid_paging_is_private_and_never_reaches_storage(setup, query):
    client, app, store, _ = setup
    unlock(app)
    response = client.get(BASE + "/kept/files?" + query)
    assert response.status_code == 422 and "private-value" not in response.text
    assert response.headers["Cache-Control"] == "private, no-store"
    store.files.assert_not_awaited()


def test_revocation_after_read_prevents_delivery(setup):
    client, app, store, current = setup
    unlock(app)
    store.status.return_value = {"private": "do-not-deliver"}
    current.side_effect = [{"user_id": "owner"}, HTTPException(403, "Revoked")]
    response = client.get(BASE)
    assert response.status_code == 403 and "do-not-deliver" not in response.text
    assert response.headers["Cache-Control"] == "private, no-store"


def test_placement_change_after_read_prevents_private_file_delivery(setup, monkeypatch):
    client, app, store, _ = setup
    unlock(app)
    store.files.return_value = {"items": [{"title": "do-not-deliver"}]}
    # Initial dependency + pre-operation check admit shared, final check refuses.
    monkeypatch.setattr(
        owner_placement_guard,
        "get_owner_hosting_mode",
        AsyncMock(side_effect=["shared", "shared", "byoc"]),
    )
    response = client.get(BASE + "/kept/files")
    assert response.status_code == 409 and "do-not-deliver" not in response.text
    assert response.headers["Cache-Control"] == "private, no-store"


@pytest.mark.parametrize(
    "error", [DriveReadError("private-provider-body"), ConnectorLifecycleError("private-sql-body")]
)
def test_storage_errors_are_authored_and_private(setup, error):
    client, app, store, _ = setup
    unlock(app)
    store.status.side_effect = error
    response = client.get(BASE)
    assert response.status_code == 503 and "private-" not in response.text
    assert response.json()["detail"]["code"] == "group_index_unavailable"
    assert response.headers["Cache-Control"] == "private, no-store"
