from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth
from api.routes.one.connection_presence import router
from hushh_mcp.services.connections_service import ConnectionsError


def _client():
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[require_firebase_auth] = lambda: "user-a"
    return TestClient(app)


def test_directory_presence_read_is_private_and_owner_scoped():
    client = _client()
    with (
        patch("api.routes.one.connection_presence.connection_presence") as presence,
        patch("api.routes.one.connection_presence.ConnectionsService"),
    ):
        presence.get_directory_presence.return_value = {
            "listed": None,
            "roleLabel": "Pediatric nurse",
        }
        resp = client.get("/api/one/connections/directory-presence")
    assert resp.status_code == 200
    assert resp.json()["roleLabel"] == "Pediatric nurse"
    assert resp.headers["cache-control"] == "private, no-store"
    assert presence.get_directory_presence.call_args.kwargs == {"user_id": "user-a"}


def test_directory_presence_update_sends_only_the_fields_in_the_body():
    client = _client()
    with (
        patch("api.routes.one.connection_presence.connection_presence") as presence,
        patch("api.routes.one.connection_presence.ConnectionsService"),
    ):
        presence.update_directory_presence.return_value = {"listed": True}
        resp = client.put("/api/one/connections/directory-presence", json={"listed": True})
    assert resp.status_code == 200
    assert presence.update_directory_presence.call_args.kwargs == {
        "user_id": "user-a",
        "fields": {"listed"},
        "listed": True,
        "role_label": None,
    }


def test_directory_presence_update_returns_typed_validation_errors():
    client = _client()
    with (
        patch("api.routes.one.connection_presence.connection_presence") as presence,
        patch("api.routes.one.connection_presence.ConnectionsService"),
    ):
        presence.update_directory_presence.side_effect = ConnectionsError(
            "CONNECTION_ROLE_LABEL_TOO_LONG", "Keep what you do to 80 characters.", status_code=422
        )
        resp = client.put("/api/one/connections/directory-presence", json={"role_label": "x" * 81})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "CONNECTION_ROLE_LABEL_TOO_LONG"
