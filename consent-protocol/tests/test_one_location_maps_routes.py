import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_vault_owner_token
from api.routes.one import location as location_routes
from api.routes.one.location import router
from hushh_mcp.services import google_maps_service as gms


@pytest.fixture()
def client(monkeypatch):
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "u1"}
    return TestClient(app)


def test_autocomplete_route(client, monkeypatch):
    async def fake(self, input_text, *, session_token=None, nearby_only=False, lat=None, lng=None):
        assert input_text == "Starbucks"
        assert nearby_only is False
        assert lat is None and lng is None
        return [{"placeId": "p1", "text": "Starbucks"}]

    monkeypatch.setattr(gms.GoogleMapsService, "autocomplete", fake)
    res = client.post("/api/one/location/maps/autocomplete", json={"input": "Starbucks"})
    assert res.status_code == 200
    assert res.headers["cache-control"] == "private, no-store"
    assert res.json()["suggestions"] == [{"placeId": "p1", "text": "Starbucks"}]


def test_place_details_route(client, monkeypatch):
    async def fake(self, place_id):
        return {"placeId": place_id, "label": "SB", "latitude": 1.0, "longitude": 2.0}

    monkeypatch.setattr(gms.GoogleMapsService, "place_details", fake)
    res = client.post("/api/one/location/maps/place-details", json={"placeId": "p1"})
    assert res.status_code == 200
    assert res.headers["cache-control"] == "private, no-store"
    assert res.json()["place"]["latitude"] == 1.0


def test_route_eta_route(client, monkeypatch):
    async def fake(self, *, origin_lat, origin_lng, dest_lat, dest_lng):
        return {"etaSeconds": 600, "distanceMeters": 4200, "trafficLevel": "light"}

    monkeypatch.setattr(gms.GoogleMapsService, "route_eta", fake)
    res = client.post(
        "/api/one/location/maps/route-eta",
        json={"originLat": 1, "originLng": 1, "destLat": 2, "destLng": 2},
    )
    assert res.status_code == 200
    data = res.json()
    assert data["eta"]["etaSeconds"] == 600
    assert data["eta"]["distanceMeters"] == 4200
    assert data["eta"]["trafficLevel"] == "light"


def test_reverse_geocode_route(client, monkeypatch):
    async def fake(self, *, lat, lng):
        return {
            "name": "Central Library",
            "formattedAddress": "476 5th Ave",
            "countryCode": "US",
        }

    monkeypatch.setattr(gms.GoogleMapsService, "reverse_geocode", fake)
    res = client.post(
        "/api/one/location/maps/reverse-geocode",
        json={"lat": 40.75, "lng": -73.98},
    )
    assert res.status_code == 200
    data = res.json()
    assert data["place"]["name"] == "Central Library"
    assert data["place"]["formattedAddress"] == "476 5th Ave"
    assert data["place"]["countryCode"] == "US"


def test_maps_unconfigured_returns_503(client, monkeypatch):
    async def fake(self, input_text, *, session_token=None, nearby_only=False, lat=None, lng=None):
        raise gms.GoogleMapsError("no key", status_code=503)

    monkeypatch.setattr(gms.GoogleMapsService, "autocomplete", fake)
    res = client.post("/api/one/location/maps/autocomplete", json={"input": "x"})
    assert res.status_code == 503


def test_private_map_state_is_authenticated_and_ciphertext_only(client, monkeypatch):
    class FakeService:
        def list_map_state(self, *, user_id):
            assert user_id == "u1"
            return {
                "preferences": {"presenceMode": "ghost", "rendererConsentVersion": None},
                "freshnessSeconds": 90,
                "markers": [
                    {
                        "grant": {"id": "grant-1", "ownerUserId": "owner", "recipientUserId": "u1"},
                        "envelope": {"id": "envelope-1", "ciphertext": "opaque", "iv": "opaque"},
                    }
                ],
            }

    monkeypatch.setattr(location_routes, "_service", lambda: FakeService())
    res = client.get("/api/one/location/map-state")
    assert res.status_code == 200
    payload = res.json()
    assert payload["markers"][0]["envelope"]["ciphertext"] == "opaque"
    assert "latitude" not in str(payload).lower()
    assert "longitude" not in str(payload).lower()


def test_private_map_preferences_validate_presence(client, monkeypatch):
    class FakeService:
        def update_map_preferences(self, **kwargs):
            assert kwargs["user_id"] == "u1"
            assert kwargs["presence_mode"] == "foreground_private"
            return {"presenceMode": "foreground_private", "rendererConsentVersion": None}

    monkeypatch.setattr(location_routes, "_service", lambda: FakeService())
    res = client.patch(
        "/api/one/location/map-preferences",
        json={"presenceMode": "foreground_private"},
    )
    assert res.status_code == 200
    assert res.json()["preferences"]["presenceMode"] == "foreground_private"


@pytest.mark.parametrize("category", ["health", "cafes", "other_stays"])
def test_nearby_place_picker_is_bounded_and_authenticated(client, monkeypatch, category):
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.delenv("ONE_LOCATION_NEARBY_PRESENCE_MODE", raising=False)
    monkeypatch.delenv("ONE_LOCATION_NEARBY_PRESENCE_COHORT", raising=False)
    requested_category = category

    async def nearby_places(self, *, lat, lng, category):
        assert (lat, lng) == (12.9716, 77.5946)
        assert category == requested_category
        return gms.NearbyPlaceSuggestions(
            [
                {
                    "placeId": "place-a",
                    "text": "Spot A",
                    "distanceMeters": 42,
                }
            ],
            incomplete=True,
        )

    monkeypatch.setattr(gms.GoogleMapsService, "nearby_places", nearby_places)
    response = client.post(
        "/api/one/location/maps/nearby-places",
        json={"lat": 12.9716, "lng": 77.5946, "category": requested_category},
    )

    assert response.status_code == 200
    assert response.headers["cache-control"] == "private, no-store"
    assert response.json()["suggestions"][0]["placeId"] == "place-a"
    assert response.json()["discoveryIncomplete"] is True
