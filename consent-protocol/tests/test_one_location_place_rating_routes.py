from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_vault_owner_token
from api.routes.one import location


class _FakePlaceRatingService:
    def place_summaries(self, *, place_ids):
        assert place_ids == ["place-1", "place-2"]
        return [{"placeId": "place-1", "average": 4.6, "countBucket": "5+"}]


def _app(*, authenticated: bool) -> FastAPI:
    app = FastAPI()
    app.include_router(location.router)
    if authenticated:
        app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "owner-1"}
    return app


def test_rating_summaries_require_vault_owner_authentication(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "test")
    response = TestClient(_app(authenticated=False)).post(
        "/api/one/location/place-ratings/summaries",
        json={"placeIds": ["place-1"]},
    )

    assert response.status_code in {401, 403}


def test_rating_summaries_are_bounded_private_and_author_free(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setattr(
        location,
        "_place_rating_service",
        lambda: _FakePlaceRatingService(),
    )
    response = TestClient(_app(authenticated=True)).post(
        "/api/one/location/place-ratings/summaries",
        json={"placeIds": ["place-1", "place-2"]},
    )

    assert response.status_code == 200
    assert response.headers["cache-control"] == "private, no-store"
    assert response.headers["pragma"] == "no-cache"
    assert response.json() == {
        "summaries": [{"placeId": "place-1", "average": 4.6, "countBucket": "5+"}]
    }
    assert "author" not in response.text.lower()


def test_rating_summaries_stay_dark_outside_the_enabled_cohort(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "production")
    monkeypatch.delenv("ONE_LOCATION_NEARBY_PRESENCE_MODE", raising=False)
    response = TestClient(_app(authenticated=True)).post(
        "/api/one/location/place-ratings/summaries",
        json={"placeIds": ["place-1"]},
    )

    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "NEARBY_PRESENCE_UNAVAILABLE"
