"""Authenticated person-profile bundle history contract."""

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth
from api.routes.one import people
from hushh_mcp.services.person_profile_service import PersonProfileNotFoundError

PERSON_REF = "11111111-1111-4111-8111-111111111111"


class _HistoryService:
    def __init__(self) -> None:
        self.calls = []

    async def get_request_history_page(self, **kwargs):
        self.calls.append(kwargs)
        if kwargs["viewer_user_id"] == "not-allowed":
            raise PersonProfileNotFoundError("Person profile was not found.")
        if kwargs["cursor"] == "bad":
            raise ValueError("Invalid request history cursor.")
        return {"bundles": [{"bundleId": "bundle-1", "itemCount": 150}], "nextCursor": None}


def test_request_history_route_binds_authenticated_viewer_and_bounds_inputs(monkeypatch) -> None:
    service = _HistoryService()
    monkeypatch.setattr(people, "_service", lambda: service)
    app = FastAPI()
    app.include_router(people.router)
    viewer = {"uid": "viewer"}
    app.dependency_overrides[require_firebase_auth] = lambda: viewer["uid"]
    client = TestClient(app, raise_server_exceptions=False)

    response = client.get(f"/api/one/people/{PERSON_REF}/request-history?limit=1")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "private, no-store"
    assert response.json()["bundles"][0]["itemCount"] == 150
    assert service.calls[-1] == {
        "viewer_user_id": "viewer",
        "public_person_ref": PERSON_REF,
        "limit": 1,
        "cursor": None,
    }

    assert client.get(f"/api/one/people/{PERSON_REF}/request-history?limit=51").status_code == 422
    assert client.get(f"/api/one/people/{PERSON_REF}/request-history?cursor=bad").status_code == 400
    assert client.get("/api/one/people/not-a-uuid/request-history").status_code == 404
    viewer["uid"] = "not-allowed"
    assert client.get(f"/api/one/people/{PERSON_REF}/request-history").status_code == 404
