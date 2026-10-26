"""Area preference/search request boundaries over real FastAPI handlers."""

from unittest.mock import AsyncMock

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_firebase_auth_read_only
from api.routes.one import area_discovery as route


def client():
    app = FastAPI()
    app.include_router(route.router)
    app.dependency_overrides[require_firebase_auth_read_only] = lambda: "signed-in-owner"
    return TestClient(app)


def test_owner_is_from_auth_and_search_never_accepts_extra_narrowing_fields(monkeypatch):
    choose = AsyncMock(return_value={"enabled": True})
    search = AsyncMock(return_value={"items": [], "hasMore": False, "suppressed": True})
    monkeypatch.setattr(route.service, "choose_preference", choose)
    monkeypatch.setattr(route.service, "search", search)
    c = client()
    payload = {
        "enabled": True,
        "postalCode": "98033",
        "expectedRevision": 0,
        "consentVersion": "one-area-discovery-v1",
        "adultConfirmed": True,
    }
    response = c.put("/api/one/area-discovery/me", json=payload)
    assert response.status_code == 200
    assert response.headers["cache-control"] == "private, no-store"
    assert choose.await_args.args == ("signed-in-owner",)
    assert (
        c.put("/api/one/area-discovery/me", json={**payload, "userId": "another"}).status_code
        == 422
    )
    assert (
        c.post(
            "/api/one/area-discovery/search", json={"postalCode": "98033", "page": 1}
        ).status_code
        == 200
    )
    for extra in [{"name": "Maya"}, {"age": 30}, {"page": 6}, {"postalCode": "9803"}]:
        assert (
            c.post(
                "/api/one/area-discovery/search", json={"postalCode": "98033", **extra}
            ).status_code
            == 422
        )
    assert search.await_count == 1
    assert c.get("/api/one/area-discovery/search?postalCode=98033").status_code == 405


def test_authentication_is_required_before_any_preference_or_search(monkeypatch):
    app = FastAPI()
    app.include_router(route.router)
    c = TestClient(app)
    read = AsyncMock()
    monkeypatch.setattr(route.service, "preference", read)
    assert c.get("/api/one/area-discovery/me").status_code == 401
    assert not read.called
