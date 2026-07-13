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
async def test_route_eta_parses_duration_and_traffic(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        field_mask = request.headers["X-Goog-FieldMask"]
        assert "routes.duration" in field_mask
        assert "routes.staticDuration" in field_mask
        import json as _json

        body = _json.loads(request.content)
        assert body["routingPreference"] == "TRAFFIC_AWARE"
        return httpx.Response(
            200,
            json={
                "routes": [
                    {
                        "duration": "2398s",
                        "staticDuration": "2000s",
                        "distanceMeters": 56902,
                    }
                ]
            },
        )

    monkeypatch.setattr(gms, "GOOGLE_MAPS_API_KEY", "k")
    monkeypatch.setattr(gms, "_async_client", lambda: _client_with(handler))
    svc = gms.GoogleMapsService()
    out = await svc.route_eta(
        origin_lat=37.77, origin_lng=-122.41, dest_lat=37.42, dest_lng=-122.08
    )
    # 2398 / 2000 = 1.199 -> moderate
    assert out == {
        "etaSeconds": 2398,
        "distanceMeters": 56902,
        "trafficLevel": "moderate",
    }


def test_classify_traffic_boundaries():
    assert gms._classify_traffic(100, 100) == "light"  # ratio 1.0
    assert gms._classify_traffic(114, 100) == "light"  # ratio 1.14
    assert gms._classify_traffic(115, 100) == "moderate"  # ratio 1.15
    assert gms._classify_traffic(139, 100) == "moderate"  # ratio 1.39
    assert gms._classify_traffic(140, 100) == "heavy"  # ratio 1.40
    assert gms._classify_traffic(300, 0) is None  # no baseline
    assert gms._classify_traffic(0, 100) is None  # no eta


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


@pytest.mark.asyncio
async def test_reverse_geocode_parses_name_and_address(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        assert "latlng=" in str(request.url)
        return httpx.Response(
            200,
            json={
                "results": [
                    {
                        "formatted_address": "476 5th Ave, New York, NY 10018, USA",
                        "types": ["point_of_interest", "establishment"],
                        "address_components": [
                            {"long_name": "Central Library", "types": ["point_of_interest"]}
                        ],
                    }
                ]
            },
        )

    monkeypatch.setattr(gms, "GOOGLE_MAPS_API_KEY", "k")
    monkeypatch.setattr(gms, "_async_client", lambda: _client_with(handler))
    svc = gms.GoogleMapsService()
    out = await svc.reverse_geocode(lat=40.75, lng=-73.98)
    assert out == {
        "name": "Central Library",
        "formattedAddress": "476 5th Ave, New York, NY 10018, USA",
    }


@pytest.mark.asyncio
async def test_reverse_geocode_empty_results_returns_nulls(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"results": []})

    monkeypatch.setattr(gms, "GOOGLE_MAPS_API_KEY", "k")
    monkeypatch.setattr(gms, "_async_client", lambda: _client_with(handler))
    svc = gms.GoogleMapsService()
    out = await svc.reverse_geocode(lat=1.0, lng=2.0)
    assert out == {"name": None, "formattedAddress": None}
