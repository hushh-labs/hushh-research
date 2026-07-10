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
