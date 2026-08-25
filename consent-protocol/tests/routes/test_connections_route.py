from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth
from api.routes.one.connections import router


def _client():
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[require_firebase_auth] = lambda: "user-a"
    return TestClient(app)


def test_create_request_returns_request_payload():
    client = _client()
    with patch("api.routes.one.connections.ConnectionsService") as svc_cls:
        svc_cls.return_value.create_request.return_value = {
            "id": "req-1",
            "requesterUserId": "user-a",
            "addresseeUserId": "user-b",
            "status": "pending",
            "message": None,
        }
        resp = client.post("/api/one/connections/requests", json={"addressee_user_id": "user-b"})
    assert resp.status_code == 200
    assert resp.json()["request"]["id"] == "req-1"


def test_directory_lists_items():
    client = _client()
    with patch("api.routes.one.connections.ConnectionsService") as svc_cls:
        svc_cls.return_value.search_directory.return_value = {
            "items": [],
            "page": 1,
            "hasMore": False,
        }
        resp = client.get("/api/one/connections/directory?query=bo")
    assert resp.status_code == 200
    assert resp.json() == {"items": [], "page": 1, "hasMore": False}


def test_connections_no_params_preserves_legacy_complete_shape():
    client = _client()
    with patch("api.routes.one.connections.ConnectionsService") as svc_cls:
        svc_cls.return_value.list_connections.return_value = [{"connectionId": "cx-1"}]
        resp = client.get("/api/one/connections")
    assert resp.status_code == 200
    assert resp.json() == {"items": [{"connectionId": "cx-1"}]}
    assert resp.headers["cache-control"] == "private, no-store"
    svc_cls.return_value.list_connections.assert_called_once_with("user-a")
    svc_cls.return_value.list_connections_page.assert_not_called()


def test_connections_paging_filters_ria_before_returning_a_bounded_page():
    client = _client()
    with patch("api.routes.one.connections.ConnectionsService") as svc_cls:
        svc_cls.return_value.list_connections_page.return_value = {
            "items": [{"connectionId": "cx-101", "connectedFromContacts": True}],
            "page": 2,
            "hasMore": True,
            "totalCount": 5000,
            "audience": "ria",
        }
        resp = client.get("/api/one/connections?page=2&limit=100&query=alex&audience=ria")
    assert resp.status_code == 200
    assert resp.json()["totalCount"] == 5000
    assert resp.headers["cache-control"] == "private, no-store"
    svc_cls.return_value.list_connections_page.assert_called_once_with(
        "user-a", page=2, limit=100, query="alex", audience="ria"
    )
