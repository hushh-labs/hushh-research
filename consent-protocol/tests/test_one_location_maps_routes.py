import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.middleware import require_vault_owner_token
from api.routes.one.location import router
from hushh_mcp.services import google_maps_service as gms


@pytest.fixture()
def client(monkeypatch):
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[require_vault_owner_token] = lambda: {"user_id": "u1"}
    return TestClient(app)


def test_autocomplete_route(client, monkeypatch):
    async def fake(self, input_text, *, session_token=None):
        assert input_text == "Starbucks"
        return [{"placeId": "p1", "text": "Starbucks"}]

    monkeypatch.setattr(gms.GoogleMapsService, "autocomplete", fake)
    res = client.post("/api/one/location/maps/autocomplete", json={"input": "Starbucks"})
    assert res.status_code == 200
    assert res.json()["suggestions"] == [{"placeId": "p1", "text": "Starbucks"}]


def test_place_details_route(client, monkeypatch):
    async def fake(self, place_id):
        return {"placeId": place_id, "label": "SB", "latitude": 1.0, "longitude": 2.0}

    monkeypatch.setattr(gms.GoogleMapsService, "place_details", fake)
    res = client.post("/api/one/location/maps/place-details", json={"placeId": "p1"})
    assert res.status_code == 200
    assert res.json()["place"]["latitude"] == 1.0


def test_route_eta_route(client, monkeypatch):
    async def fake(self, *, origin_lat, origin_lng, dest_lat, dest_lng):
        return {"etaSeconds": 600, "distanceMeters": 5000}

    monkeypatch.setattr(gms.GoogleMapsService, "route_eta", fake)
    res = client.post(
        "/api/one/location/maps/route-eta",
        json={"originLat": 1, "originLng": 1, "destLat": 2, "destLng": 2},
    )
    assert res.status_code == 200
    assert res.json()["eta"] == {"etaSeconds": 600, "distanceMeters": 5000}


def test_maps_unconfigured_returns_503(client, monkeypatch):
    async def fake(self, input_text, *, session_token=None):
        raise gms.GoogleMapsError("no key", status_code=503)

    monkeypatch.setattr(gms.GoogleMapsService, "autocomplete", fake)
    res = client.post("/api/one/location/maps/autocomplete", json={"input": "x"})
    assert res.status_code == 503
