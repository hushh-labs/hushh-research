"""Discovery coverage, strict boundaries and partial-provider regression contracts."""

import asyncio
import json

import httpx
import pytest

from hushh_mcp.services import google_maps_service as gms
from hushh_mcp.services.place_geometry import offset_coordinates


def _client_with(handler):
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def _hotel(place_id: str, *, name: str, lat: float, **extra):
    return {
        "id": place_id,
        "displayName": {"text": name},
        "shortFormattedAddress": "1 Main St",
        "businessStatus": "OPERATIONAL",
        "location": {"latitude": lat, "longitude": -122.1697},
        **extra,
    }


@pytest.mark.parametrize("origin", [(18.579, 73.738), (0, 179.999), (90, 0), (-90, 0)])
def test_refined_circles_cover_original_boundary_even_at_poles(origin):
    child_radius = 500 / (2**0.5)
    centers = [offset_coordinates(*origin, child_radius, b) for b in (45, 135, 225, 315)]
    for bearing in range(0, 360, 15):
        edge = offset_coordinates(*origin, 500, bearing)
        assert any(
            gms._distance_meters(
                origin_lat=c[0], origin_lng=c[1], destination_lat=edge[0], destination_lng=edge[1]
            )
            <= child_radius + 0.1
            for c in centers
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("sparse_location", [None, {"latitude": 37.4276, "longitude": -122.1697}])
async def test_sparse_duplicate_cannot_hide_a_valid_hotel_or_keep_generic_label(
    monkeypatch, sparse_location
):
    def handler(request):
        if json.loads(request.content).get("includedTypes"):
            place = _hotel("same", name="Real Hotel", lat=37.4276, primaryType="hotel")
        else:
            place = {
                "id": "same",
                "displayName": {"text": "Real Hotel"},
                "types": ["lodging"],
                "location": sparse_location,
            }
        return httpx.Response(200, json={"places": [place]})

    monkeypatch.setattr(gms, "GOOGLE_MAPS_API_KEY", "k")
    monkeypatch.setattr(gms, "_NEARBY_SWEEP_TYPES", {"hotels_stays": ("hotel",)})
    monkeypatch.setattr(gms, "_async_client", lambda: _client_with(handler))
    rows = await gms.GoogleMapsService().nearby_places(lat=37.4275, lng=-122.1697)
    assert len(rows) == 1
    assert rows[0]["categories"] == ["hotels_stays"]
    assert rows[0]["category"] == "Hotel"


def test_exact_radius_and_temporary_closure_preserve_real_venues():
    service = gms.GoogleMapsService()
    for distance, expected in [(500, True), (500.1, False)]:
        lat, lng = offset_coordinates(37.4275, -122.1697, distance, 0)
        place = _hotel(
            "boundary",
            name="Temporary closure",
            lat=lat,
            primaryType="hotel",
            businessStatus="CLOSED_TEMPORARILY",
        )
        place["location"]["longitude"] = lng
        assert (
            service._normalize_nearby_place(place, lat=37.4275, lng=-122.1697) is not None
        ) is expected


@pytest.mark.asyncio
async def test_discovery_retains_more_than_eighty_valid_places(monkeypatch):
    buckets = {
        "food_drink": ("restaurant",),
        "health": ("pharmacy",),
        "education": ("university",),
        "hotels_stays": ("hotel",),
        "cafes": ("cafe",),
    }

    def handler(request):
        types = json.loads(request.content).get("includedTypes")
        rows = (
            []
            if not types
            else [
                _hotel(f"{types[0]}-{i}", name=f"Venue {i}", lat=37.4276, primaryType=types[0])
                for i in range(18)
            ]
        )
        return httpx.Response(200, json={"places": rows})

    monkeypatch.setattr(gms, "GOOGLE_MAPS_API_KEY", "k")
    monkeypatch.setattr(gms, "_NEARBY_SWEEP_TYPES", buckets)
    monkeypatch.setattr(gms, "_async_client", lambda: _client_with(handler))
    rows = await gms.GoogleMapsService().nearby_places(lat=37.4275, lng=-122.1697)
    assert len(rows) == 90
    assert {row["placeId"] for row in rows} == {
        f"{types[0]}-{i}" for types in buckets.values() for i in range(18)
    }


@pytest.mark.asyncio
async def test_saturated_food_search_finds_farther_food_court_without_expanding_radius(monkeypatch):
    refined_calls = 0

    def handler(request):
        nonlocal refined_calls
        body = json.loads(request.content)
        if body["locationRestriction"]["circle"]["radius"] == 500:
            rows = [
                _hotel(f"r-{i}", name=f"Restaurant {i}", lat=37.4276, primaryType="restaurant")
                for i in range(20)
            ]
        else:
            refined_calls += 1
            rows = [
                _hotel(
                    "food-court", name="Madura Food Court", lat=37.4318, primaryType="food_court"
                ),
                _hotel("outside", name="Outside court", lat=37.4321, primaryType="food_court"),
                _hotel("cafe", name="Coffee", lat=37.4276, primaryType="cafe"),
            ]
        return httpx.Response(200, json={"places": rows})

    monkeypatch.setattr(gms, "GOOGLE_MAPS_API_KEY", "k")
    monkeypatch.setattr(gms, "_NEARBY_SWEEP_TYPES", {"food_drink": ("restaurant", "food_court")})
    monkeypatch.setattr(gms, "_async_client", lambda: _client_with(handler))
    rows = await gms.GoogleMapsService().nearby_places(
        lat=37.4275, lng=-122.1697, category="food_drink"
    )
    assert refined_calls == 4
    assert {row["placeId"] for row in rows} == {"food-court", *(f"r-{i}" for i in range(20))}
    assert all(row["categories"] == ["food_drink"] for row in rows)


@pytest.mark.asyncio
async def test_dense_children_are_refined_again_with_a_hard_query_budget(monkeypatch):
    calls = 0

    def handler(request):
        nonlocal calls
        calls += 1
        return httpx.Response(
            200,
            json={
                "places": [
                    _hotel(f"venue-{i}", name=f"School {i}", lat=37.4276, primaryType="school")
                    for i in range(20)
                ]
            },
        )

    monkeypatch.setattr(gms, "GOOGLE_MAPS_API_KEY", "k")
    monkeypatch.setattr(gms, "_NEARBY_DISCOVERY_MAX_QUERIES", 9)
    monkeypatch.setattr(gms, "_async_client", lambda: _client_with(handler))
    rows = await gms.GoogleMapsService().nearby_places(
        lat=37.4275, lng=-122.1697, category="education"
    )
    assert calls == 9  # One initial query, four children, then four grandchildren.
    assert len(rows) == 20
    assert rows.discovery_incomplete is True
    assert not gms._nearby_places_cache


@pytest.mark.asyncio
async def test_movement_inside_old_cache_cell_rechecks_both_radius_edges(monkeypatch):
    calls = 0

    def handler(request):
        nonlocal calls
        calls += 1
        return httpx.Response(
            200,
            json={
                "places": [
                    _hotel(
                        "leaving", name="Leaving", lat=37.4271 - 0.00449, primaryType="university"
                    ),
                    _hotel(
                        "entering", name="Entering", lat=37.4271 + 0.0046, primaryType="university"
                    ),
                ]
            },
        )

    monkeypatch.setattr(gms, "GOOGLE_MAPS_API_KEY", "k")
    monkeypatch.setattr(gms, "_async_client", lambda: _client_with(handler))
    assert gms._geo_cell(37.4271, -122.1697) == gms._geo_cell(37.4274, -122.1697)
    service = gms.GoogleMapsService()
    first = await service.nearby_places(lat=37.4271, lng=-122.1697, category="education")
    second = await service.nearby_places(lat=37.4274, lng=-122.1697, category="education")
    assert [row["placeId"] for row in first] == ["leaving"]
    assert [row["placeId"] for row in second] == ["entering"]
    assert calls == 2


@pytest.mark.asyncio
async def test_failed_sweep_is_retried_and_does_not_cache_missing_places(monkeypatch):
    fail = True

    def handler(request):
        types = json.loads(request.content).get("includedTypes")
        if types and fail:
            return httpx.Response(503)
        rows = (
            []
            if not types
            else [_hotel("recovered", name="Recovered", lat=37.4276, primaryType="hotel")]
        )
        return httpx.Response(200, json={"places": rows})

    monkeypatch.setattr(gms, "GOOGLE_MAPS_API_KEY", "k")
    monkeypatch.setattr(gms, "_NEARBY_SWEEP_TYPES", {"hotels_stays": ("hotel",)})
    monkeypatch.setattr(gms, "_async_client", lambda: _client_with(handler))
    service = gms.GoogleMapsService()
    assert await service.nearby_places(lat=37.4275, lng=-122.1697) == []
    fail = False
    assert [row["placeId"] for row in await service.nearby_places(lat=37.4275, lng=-122.1697)] == [
        "recovered"
    ]


@pytest.mark.asyncio
async def test_discovery_deadline_preserves_completed_results_and_cleans_up(monkeypatch):
    active = 0
    maximum_active = 0

    async def handler(request):
        nonlocal active, maximum_active
        active += 1
        maximum_active = max(maximum_active, active)
        try:
            if json.loads(request.content).get("includedTypes"):
                await asyncio.Event().wait()
            return httpx.Response(
                200,
                json={"places": [_hotel("ready", name="Ready", lat=37.4276, primaryType="hotel")]},
            )
        finally:
            active -= 1

    monkeypatch.setattr(gms, "GOOGLE_MAPS_API_KEY", "k")
    monkeypatch.setattr(gms, "_NEARBY_DISCOVERY_TIMEOUT_SECONDS", 0.05)
    monkeypatch.setattr(gms, "_NEARBY_DISCOVERY_CONCURRENCY", 2)
    monkeypatch.setattr(gms, "_async_client", lambda: _client_with(handler))
    rows = await gms.GoogleMapsService().nearby_places(lat=37.4275, lng=-122.1697)
    assert [row["placeId"] for row in rows] == ["ready"]
    assert maximum_active <= 2
    assert active == 0
    assert not gms._nearby_places_cache
