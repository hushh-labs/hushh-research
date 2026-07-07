import json

import httpx
import pytest

from hushh_mcp.services import google_maps_service as gms


def _client_with(handler):
    transport = httpx.MockTransport(handler)
    return httpx.AsyncClient(transport=transport)


@pytest.mark.asyncio
async def test_autocomplete_parses_suggestions(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["X-Goog-Api-Key"] == "k"
        assert json.loads(request.content.decode())["input"] == "Starbucks"
        return httpx.Response(
            200,
            json={
                "suggestions": [
                    {
                        "placePrediction": {
                            "placeId": "p1",
                            "text": {"text": "Starbucks, Market St"},
                        }
                    }
                ]
            },
        )

    monkeypatch.setattr(gms, "GOOGLE_MAPS_API_KEY", "k")
    monkeypatch.setattr(gms, "_async_client", lambda: _client_with(handler))
    svc = gms.GoogleMapsService()
    out = await svc.autocomplete("Starbucks")
    assert out == [{"placeId": "p1", "text": "Starbucks, Market St"}]


@pytest.mark.asyncio
async def test_place_details_parses_location(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path.endswith("/places/p1")
        return httpx.Response(
            200,
            json={
                "id": "p1",
                "displayName": {"text": "Starbucks"},
                "formattedAddress": "Market St, SF",
                "location": {"latitude": 37.79, "longitude": -122.4},
            },
        )

    monkeypatch.setattr(gms, "GOOGLE_MAPS_API_KEY", "k")
    monkeypatch.setattr(gms, "_async_client", lambda: _client_with(handler))
    svc = gms.GoogleMapsService()
    out = await svc.place_details("p1")
    assert out == {
        "placeId": "p1",
        "label": "Starbucks, Market St, SF",
        "latitude": 37.79,
        "longitude": -122.4,
    }


@pytest.mark.asyncio
async def test_route_eta_parses_duration_seconds(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        assert "routes.duration" in request.headers["X-Goog-FieldMask"]
        return httpx.Response(
            200,
            json={"routes": [{"duration": "2398s", "distanceMeters": 56902}]},
        )

    monkeypatch.setattr(gms, "GOOGLE_MAPS_API_KEY", "k")
    monkeypatch.setattr(gms, "_async_client", lambda: _client_with(handler))
    svc = gms.GoogleMapsService()
    out = await svc.route_eta(
        origin_lat=37.77, origin_lng=-122.41, dest_lat=37.42, dest_lng=-122.08
    )
    assert out == {"etaSeconds": 2398, "distanceMeters": 56902}


@pytest.mark.asyncio
async def test_missing_key_raises(monkeypatch):
    monkeypatch.setattr(gms, "GOOGLE_MAPS_API_KEY", None)
    svc = gms.GoogleMapsService()
    with pytest.raises(gms.GoogleMapsError) as excinfo:
        await svc.autocomplete("x")
    assert excinfo.value.status_code == 503


@pytest.mark.asyncio
async def test_upstream_error_maps_to_502(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(403, json={"error": {"message": "denied"}})

    monkeypatch.setattr(gms, "GOOGLE_MAPS_API_KEY", "k")
    monkeypatch.setattr(gms, "_async_client", lambda: _client_with(handler))
    svc = gms.GoogleMapsService()
    with pytest.raises(gms.GoogleMapsError) as excinfo:
        await svc.route_eta(origin_lat=1, origin_lng=1, dest_lat=2, dest_lng=2)
    assert excinfo.value.status_code == 502
