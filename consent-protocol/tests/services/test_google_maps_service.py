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
async def test_autocomplete_applies_location_bias_without_restricting_search(
    monkeypatch,
):
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content.decode())
        assert body["locationBias"]["circle"] == {
            "center": {"latitude": 37.4275, "longitude": -122.1697},
            "radius": 2_000.0,
        }
        assert "locationRestriction" not in body
        return httpx.Response(200, json={"suggestions": []})

    monkeypatch.setattr(gms, "GOOGLE_MAPS_API_KEY", "k")
    monkeypatch.setattr(gms, "_async_client", lambda: _client_with(handler))

    assert (
        await gms.GoogleMapsService().autocomplete(
            "Stanford",
            lat=37.4275,
            lng=-122.1697,
        )
        == []
    )


@pytest.mark.asyncio
async def test_autocomplete_can_restrict_check_in_search_to_500_m(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content.decode())
        assert body["locationRestriction"]["circle"] == {
            "center": {"latitude": 37.4275, "longitude": -122.1697},
            "radius": 500.0,
        }
        assert body["origin"] == {
            "latitude": 37.4275,
            "longitude": -122.1697,
        }
        assert "locationBias" not in body
        return httpx.Response(
            200,
            json={
                "suggestions": [
                    {
                        "placePrediction": {
                            "placeId": "clinic-1",
                            "text": {"text": "Campus Clinic"},
                            "distanceMeters": 72,
                        }
                    }
                ]
            },
        )

    monkeypatch.setattr(gms, "GOOGLE_MAPS_API_KEY", "k")
    monkeypatch.setattr(gms, "_async_client", lambda: _client_with(handler))

    result = await gms.GoogleMapsService().autocomplete(
        "clinic",
        lat=37.4275,
        lng=-122.1697,
        nearby_only=True,
    )

    assert result == [
        {
            "placeId": "clinic-1",
            "text": "Campus Clinic",
            "distanceMeters": 72,
        }
    ]


@pytest.mark.asyncio
async def test_nearby_places_returns_bounded_distance_ranked_picker(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path.endswith("/v1/places:searchNearby")
        body = json.loads(request.content.decode())
        assert body["maxResultCount"] == 20
        assert body["rankPreference"] == "DISTANCE"
        assert body["locationRestriction"]["circle"]["radius"] == 500.0
        return httpx.Response(
            200,
            json={
                "places": [
                    {
                        "id": "spot-a",
                        "displayName": {"text": "Spot A"},
                        "shortFormattedAddress": "Stanford, CA",
                        "primaryType": "university",
                        "primaryTypeDisplayName": {"text": "University"},
                        "businessStatus": "OPERATIONAL",
                        "location": {
                            "latitude": 37.4276,
                            "longitude": -122.1697,
                        },
                    }
                ]
            },
        )

    monkeypatch.setattr(gms, "GOOGLE_MAPS_API_KEY", "k")
    monkeypatch.setattr(gms, "_async_client", lambda: _client_with(handler))

    result = await gms.GoogleMapsService().nearby_places(
        lat=37.4275,
        lng=-122.1697,
    )

    assert result == [
        {
            "placeId": "spot-a",
            "name": "Spot A",
            "address": "Stanford, CA",
            "text": "Spot A, Stanford, CA",
            "distanceMeters": 11,
            "latitude": 37.4276,
            "longitude": -122.1697,
            "primaryType": "university",
            "category": "University",
            "categories": ["education"],
        }
    ]


def _hotel(place_id: str, *, name: str, lat: float, **extra):
    return {
        "id": place_id,
        "displayName": {"text": name},
        "shortFormattedAddress": "1 Main St",
        "businessStatus": "OPERATIONAL",
        "location": {"latitude": lat, "longitude": -122.1697},
        **extra,
    }


@pytest.mark.asyncio
async def test_nearby_places_all_sweeps_every_category_bucket(monkeypatch):
    """The 20-result provider cap must not let one category bury another.

    Regression: twenty cafes inside 40 m consumed the whole unfiltered response,
    so the hotel one street back never reached the picker and the drawer looked
    like it had skipped it.
    """

    seen_included_types: list[list[str] | None] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content.decode())
        included = body.get("includedTypes")
        seen_included_types.append(included)
        if included is None:
            # The unfiltered sweep is saturated by nearer cafes.
            return httpx.Response(
                200,
                json={
                    "places": [
                        _hotel(
                            f"cafe-{index}",
                            name=f"Cafe {index}",
                            lat=37.42751,
                            primaryType="cafe",
                        )
                        for index in range(20)
                    ]
                },
            )
        if "hotel" in included:
            return httpx.Response(
                200,
                json={
                    "places": [
                        _hotel(
                            "hotel-1",
                            name="Hotel One",
                            lat=37.4276,
                            primaryType="hotel",
                        ),
                        # No primaryType at all -- exactly the shape Google
                        # returns for many independent hotels.
                        _hotel(
                            "hotel-2",
                            name="Hotel Two",
                            lat=37.4278,
                            types=["lodging", "establishment"],
                        ),
                    ]
                },
            )
        return httpx.Response(200, json={"places": []})

    monkeypatch.setattr(gms, "GOOGLE_MAPS_API_KEY", "k")
    monkeypatch.setattr(gms, "_async_client", lambda: _client_with(handler))

    result = await gms.GoogleMapsService().nearby_places(lat=37.4275, lng=-122.1697)
    place_ids = [place["placeId"] for place in result]

    assert None in seen_included_types
    assert len(seen_included_types) == len(gms._NEARBY_PLACE_CATEGORY_TYPES) + 1
    # Both hotels survive the cafe flood, and the one with no primaryType does
    # not get silently dropped.
    assert "hotel-1" in place_ids
    assert "hotel-2" in place_ids
    assert len(place_ids) == len(set(place_ids)), "merged sweep must de-duplicate"
    distances = [place["distanceMeters"] for place in result]
    assert distances == sorted(distances)
    hotel_two = next(place for place in result if place["placeId"] == "hotel-2")
    assert hotel_two["categories"] == ["hotels_stays"]
    assert hotel_two["latitude"] == 37.4278


@pytest.mark.asyncio
async def test_nearby_places_files_a_generic_venue_under_the_chip_that_found_it(
    monkeypatch,
):
    """An `establishment`-only venue must still be reachable from its chip.

    Google reports many independent businesses with no descriptive type. Such a
    place maps to no category of its own, so without this it would appear under
    "All" and then vanish the moment the owner tapped "Hotels".
    """

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content.decode())
        included = body.get("includedTypes")
        if included and "hotel" in included:
            return httpx.Response(
                200,
                json={
                    "places": [
                        _hotel(
                            "generic-hotel",
                            name="Blue Pearl Lodge",
                            lat=37.4276,
                            types=["establishment", "point_of_interest"],
                        )
                    ]
                },
            )
        return httpx.Response(200, json={"places": []})

    monkeypatch.setattr(gms, "GOOGLE_MAPS_API_KEY", "k")
    monkeypatch.setattr(gms, "_async_client", lambda: _client_with(handler))

    result = await gms.GoogleMapsService().nearby_places(lat=37.4275, lng=-122.1697)

    assert [place["placeId"] for place in result] == ["generic-hotel"]
    assert result[0]["categories"] == ["hotels_stays"]


@pytest.mark.asyncio
async def test_nearby_places_survives_a_partial_bucket_failure(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content.decode())
        if body.get("includedTypes") is None:
            return httpx.Response(500, json={})
        return httpx.Response(
            200,
            json={
                "places": [
                    _hotel(
                        "hotel-1",
                        name="Hotel One",
                        lat=37.4276,
                        primaryType="hotel",
                    )
                ]
            },
        )

    monkeypatch.setattr(gms, "GOOGLE_MAPS_API_KEY", "k")
    monkeypatch.setattr(gms, "_async_client", lambda: _client_with(handler))

    result = await gms.GoogleMapsService().nearby_places(lat=37.4275, lng=-122.1697)

    assert [place["placeId"] for place in result] == ["hotel-1"]


@pytest.mark.asyncio
async def test_nearby_places_all_buckets_failing_raises(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={})

    monkeypatch.setattr(gms, "GOOGLE_MAPS_API_KEY", "k")
    monkeypatch.setattr(gms, "_async_client", lambda: _client_with(handler))

    with pytest.raises(gms.GoogleMapsError):
        await gms.GoogleMapsService().nearby_places(lat=37.4275, lng=-122.1697)


@pytest.mark.asyncio
async def test_nearby_places_still_rejects_address_records_without_primary_type(
    monkeypatch,
):
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content.decode())
        if body.get("includedTypes") is not None:
            return httpx.Response(200, json={"places": []})
        return httpx.Response(
            200,
            json={
                "places": [
                    _hotel(
                        "address-record",
                        name="12 Main Street",
                        lat=37.4276,
                        types=["street_address", "geocode"],
                    ),
                    _hotel("no-types", name="Unknown", lat=37.4276),
                    _hotel(
                        "named-venue",
                        name="Corner Shop",
                        lat=37.4276,
                        types=["establishment", "point_of_interest"],
                    ),
                ]
            },
        )

    monkeypatch.setattr(gms, "GOOGLE_MAPS_API_KEY", "k")
    monkeypatch.setattr(gms, "_async_client", lambda: _client_with(handler))

    result = await gms.GoogleMapsService().nearby_places(lat=37.4275, lng=-122.1697)

    assert [place["placeId"] for place in result] == ["named-venue"]
    assert result[0]["categories"] == []


@pytest.mark.asyncio
async def test_nearby_places_filters_category_closed_duplicate_and_outside_results(
    monkeypatch,
):
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content.decode())
        assert body["includedTypes"] == [
            "hospital",
            "medical_clinic",
            "doctor",
            "dentist",
            "pharmacy",
        ]
        return httpx.Response(
            200,
            json={
                "places": [
                    {
                        "id": "clinic-open",
                        "displayName": {"text": "Open Clinic"},
                        "formattedAddress": "1 Main St",
                        "primaryType": "medical_clinic",
                        "businessStatus": "OPERATIONAL",
                        "location": {"latitude": 37.4277, "longitude": -122.1697},
                    },
                    {
                        "id": "clinic-open",
                        "displayName": {"text": "Duplicate Clinic"},
                        "location": {"latitude": 37.4278, "longitude": -122.1697},
                    },
                    {
                        "id": "clinic-closed",
                        "displayName": {"text": "Closed Clinic"},
                        "businessStatus": "CLOSED_PERMANENTLY",
                        "location": {"latitude": 37.4276, "longitude": -122.1697},
                    },
                    {
                        "id": "street-record",
                        "displayName": {"text": "Main Street"},
                        "primaryType": "route",
                        "location": {"latitude": 37.4276, "longitude": -122.1697},
                    },
                    {
                        "id": "mobile-service",
                        "displayName": {"text": "Mobile Repair Service"},
                        "primaryType": "service",
                        "pureServiceAreaBusiness": True,
                        "location": {"latitude": 37.4276, "longitude": -122.1697},
                    },
                    {
                        "id": "outside",
                        "displayName": {"text": "Far Clinic"},
                        "primaryType": "medical_clinic",
                        "location": {"latitude": 37.4375, "longitude": -122.1697},
                    },
                ]
            },
        )

    monkeypatch.setattr(gms, "GOOGLE_MAPS_API_KEY", "k")
    monkeypatch.setattr(gms, "_async_client", lambda: _client_with(handler))

    result = await gms.GoogleMapsService().nearby_places(
        lat=37.4275,
        lng=-122.1697,
        category="health",
    )

    assert [place["placeId"] for place in result] == ["clinic-open"]
    assert result[0]["category"] == "Medical Clinic"


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
@pytest.mark.parametrize(
    "invalid_metadata",
    [
        {"primaryType": "route"},
        {"primaryType": "restaurant", "businessStatus": "CLOSED_PERMANENTLY"},
        {"primaryType": "plumber", "pureServiceAreaBusiness": True},
        {"primaryType": "administrative_area_level_4"},
        {"primaryType": "postal_town"},
        {"primaryType": "plus_code"},
        {"primaryType": ""},
        {"primaryType": {"unexpected": "restaurant"}},
        {"primaryType": "restaurant", "displayName": {"text": ""}},
        {"primaryType": "restaurant", "displayName": {"text": ["Cafe"]}},
    ],
)
async def test_place_details_rejects_non_check_in_places(
    monkeypatch,
    invalid_metadata,
):
    def handler(request: httpx.Request) -> httpx.Response:
        payload = {
            "id": "invalid-place",
            "displayName": {"text": "Invalid place"},
            "formattedAddress": "1 Main St",
            "primaryType": "restaurant",
            "businessStatus": "OPERATIONAL",
            "location": {"latitude": 37.79, "longitude": -122.4},
        }
        payload.update(invalid_metadata)
        return httpx.Response(200, json=payload)

    monkeypatch.setattr(gms, "GOOGLE_MAPS_API_KEY", "k")
    monkeypatch.setattr(gms, "_async_client", lambda: _client_with(handler))

    with pytest.raises(gms.GoogleMapsError) as raised:
        await gms.GoogleMapsService().place_details(
            "invalid-place",
            require_check_inable=True,
        )

    assert raised.value.status_code == 422
    assert raised.value.code == "ONE_LOCATION_PLACE_NOT_CHECK_INABLE"
    assert str(raised.value) == "The selected place is not available for check-in."


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
                            {
                                "long_name": "Central Library",
                                "types": ["point_of_interest"],
                            },
                            {
                                "long_name": "United States",
                                "short_name": "US",
                                "types": ["country", "political"],
                            },
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
        "countryCode": "US",
    }


@pytest.mark.asyncio
async def test_reverse_geocode_empty_results_returns_nulls(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path.endswith("/geocode/json")
        return httpx.Response(200, json={"status": "ZERO_RESULTS", "results": []})

    monkeypatch.setattr(gms, "GOOGLE_MAPS_API_KEY", "k")
    monkeypatch.setattr(gms, "_async_client", lambda: _client_with(handler))
    svc = gms.GoogleMapsService()
    out = await svc.reverse_geocode(lat=1.0, lng=2.0)
    assert out == {
        "name": None,
        "formattedAddress": None,
        "countryCode": None,
    }


@pytest.mark.asyncio
async def test_reverse_geocode_falls_back_to_nearest_place_address(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/geocode/json"):
            return httpx.Response(
                200,
                json={"status": "REQUEST_DENIED", "results": []},
            )
        assert request.method == "POST"
        assert request.url.path.endswith("/v1/places:searchNearby")
        assert request.headers["X-Goog-FieldMask"] == (
            "places.displayName,places.formattedAddress,places.addressComponents"
        )
        assert json.loads(request.content)["locationRestriction"]["circle"]["radius"] == 100.0
        return httpx.Response(
            200,
            json={
                "places": [
                    {
                        "displayName": {"text": "Cubbon Park"},
                        "formattedAddress": ("Kasturba Road, Bengaluru, Karnataka 560001, India"),
                        "addressComponents": [
                            {
                                "longText": "India",
                                "shortText": "IN",
                                "types": ["country", "political"],
                            }
                        ],
                    }
                ]
            },
        )

    monkeypatch.setattr(gms, "GOOGLE_MAPS_API_KEY", "k")
    monkeypatch.setattr(gms, "_async_client", lambda: _client_with(handler))
    svc = gms.GoogleMapsService()
    out = await svc.reverse_geocode(lat=12.9763, lng=77.5929)
    assert out == {
        "name": "Cubbon Park",
        "formattedAddress": "Kasturba Road, Bengaluru, Karnataka 560001, India",
        "countryCode": "IN",
    }


# ---------------------------------------------------------------------------
# Postal-code resolution — Text Search, because the Geocoding API is not
# enabled for this key (REQUEST_DENIED: "This API is not activated").
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_resolve_postal_code_reads_the_places_component(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path.endswith("/places:searchText")
        assert json.loads(request.content)["textQuery"] == "MENDOCINO, CA, USA"
        return httpx.Response(
            200,
            json={
                "places": [
                    {
                        "addressComponents": [
                            {"longText": "Mendocino", "types": ["locality", "political"]},
                            {"longText": "95460", "types": ["postal_code"]},
                        ]
                    }
                ]
            },
        )

    monkeypatch.setattr(gms, "GOOGLE_MAPS_API_KEY", "k")
    monkeypatch.setattr(gms, "_async_client", lambda: _client_with(handler))
    assert await gms.GoogleMapsService().resolve_postal_code(query="MENDOCINO, CA, USA") == "95460"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(200, json={"places": []}),
        httpx.Response(200, json={"places": [{"addressComponents": []}]}),
        httpx.Response(403, json={"error": {"message": "denied"}}),
        httpx.Response(200, content=b"not json"),
    ],
    ids=["no-place", "no-postal-component", "upstream-error", "unparseable"],
)
async def test_resolve_postal_code_never_raises_into_the_caller(monkeypatch, response):
    """Enrichment only: a lookup failure must not fail the dossier worker."""
    monkeypatch.setattr(gms, "GOOGLE_MAPS_API_KEY", "k")
    monkeypatch.setattr(gms, "_async_client", lambda: _client_with(lambda _r: response))
    assert await gms.GoogleMapsService().resolve_postal_code(query="SANDY, UT") == ""


@pytest.mark.asyncio
async def test_resolve_postal_code_without_a_key_makes_no_call(monkeypatch):
    called = False

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal called
        called = True
        return httpx.Response(200, json={"places": []})

    monkeypatch.setattr(gms, "GOOGLE_MAPS_API_KEY", "")
    monkeypatch.setattr(gms, "_async_client", lambda: _client_with(handler))
    assert await gms.GoogleMapsService().resolve_postal_code(query="SANDY, UT") == ""
    assert called is False


# --------------------------------------------------------------------------- #
# Response cache -- repeat opens at a spot that has not moved must not re-bill
# Google. See `_PLACES_CACHE_TTL_SECONDS` / `_geo_cell` in google_maps_service.
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_nearby_places_reuses_a_cached_answer_for_the_same_cell(monkeypatch):
    """A drawer reopened at home ten times a day must cost one provider call."""

    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(
            200,
            json={
                "places": [
                    {
                        "id": "spot-a",
                        "displayName": {"text": "Spot A"},
                        "shortFormattedAddress": "Stanford, CA",
                        "primaryType": "university",
                        "primaryTypeDisplayName": {"text": "University"},
                        "businessStatus": "OPERATIONAL",
                        "location": {"latitude": 37.4276, "longitude": -122.1697},
                    }
                ]
            },
        )

    monkeypatch.setattr(gms, "GOOGLE_MAPS_API_KEY", "k")
    monkeypatch.setattr(gms, "_async_client", lambda: _client_with(handler))

    svc = gms.GoogleMapsService()
    first = await svc.nearby_places(lat=37.4275, lng=-122.1697, category="education")
    second = await svc.nearby_places(lat=37.4275, lng=-122.1697, category="education")

    assert calls == 1
    assert first == second


@pytest.mark.asyncio
async def test_nearby_places_cache_misses_for_a_materially_different_cell(monkeypatch):
    """A real move to a new area must still reach Google, not a stale cache."""

    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(200, json={"places": []})

    monkeypatch.setattr(gms, "GOOGLE_MAPS_API_KEY", "k")
    monkeypatch.setattr(gms, "_async_client", lambda: _client_with(handler))

    svc = gms.GoogleMapsService()
    await svc.nearby_places(lat=37.4275, lng=-122.1697, category="education")
    await svc.nearby_places(lat=37.9000, lng=-122.1697, category="education")

    assert calls == 2


@pytest.mark.asyncio
async def test_nearby_places_cache_expires_after_the_ttl(monkeypatch):
    calls = 0
    clock = {"t": 0.0}

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(200, json={"places": []})

    monkeypatch.setattr(gms, "GOOGLE_MAPS_API_KEY", "k")
    monkeypatch.setattr(gms, "_async_client", lambda: _client_with(handler))
    monkeypatch.setattr(gms, "_cache_clock", lambda: clock["t"])

    svc = gms.GoogleMapsService()
    await svc.nearby_places(lat=37.4275, lng=-122.1697, category="education")
    clock["t"] += gms._PLACES_CACHE_TTL_SECONDS + 1
    await svc.nearby_places(lat=37.4275, lng=-122.1697, category="education")

    assert calls == 2


@pytest.mark.asyncio
async def test_clear_places_cache_forces_a_fresh_lookup(monkeypatch):
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(200, json={"places": []})

    monkeypatch.setattr(gms, "GOOGLE_MAPS_API_KEY", "k")
    monkeypatch.setattr(gms, "_async_client", lambda: _client_with(handler))

    svc = gms.GoogleMapsService()
    await svc.nearby_places(lat=37.4275, lng=-122.1697, category="education")
    gms.clear_places_cache()
    await svc.nearby_places(lat=37.4275, lng=-122.1697, category="education")

    assert calls == 2


@pytest.mark.asyncio
async def test_search_directory_category_reuses_a_cached_answer(monkeypatch):
    """Reopening the same directory category on the same visit costs one call."""

    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(
            200,
            json={
                "places": [
                    {
                        "id": "hotel-a",
                        "displayName": {"text": "Hotel A"},
                        "location": {"latitude": 12.9716, "longitude": 77.5946},
                        "businessStatus": "OPERATIONAL",
                    }
                ]
            },
        )

    monkeypatch.setattr(gms, "GOOGLE_MAPS_API_KEY", "k")
    monkeypatch.setattr(gms, "_async_client", lambda: _client_with(handler))

    svc = gms.GoogleMapsService()
    first = await svc.search_directory_category(
        lat=12.9716, lng=77.5946, category="hotels_stays", radius_meters=8046.72, limit=8
    )
    second = await svc.search_directory_category(
        lat=12.9716, lng=77.5946, category="hotels_stays", radius_meters=8046.72, limit=8
    )

    assert calls == 1
    assert first == second


@pytest.mark.asyncio
async def test_search_directory_category_cache_key_includes_radius(monkeypatch):
    """A different radius tier is a genuinely different answer, not a cache hit."""

    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(200, json={"places": []})

    monkeypatch.setattr(gms, "GOOGLE_MAPS_API_KEY", "k")
    monkeypatch.setattr(gms, "_async_client", lambda: _client_with(handler))

    svc = gms.GoogleMapsService()
    await svc.search_directory_category(
        lat=12.9716, lng=77.5946, category="hotels_stays", radius_meters=1_600.0, limit=8
    )
    await svc.search_directory_category(
        lat=12.9716, lng=77.5946, category="hotels_stays", radius_meters=24_000.0, limit=8
    )

    assert calls == 2


# --------------------------------------------------------------------------- #
# Redis tier -- shared across every Cloud Run instance and worker. A fake
# async client stands in for a real server; no test here talks to a network.
# --------------------------------------------------------------------------- #


class _FakeRedis:
    def __init__(self, *, fail: bool = False):
        self.store: dict[str, str] = {}
        self.fail = fail
        self.get_calls = 0
        self.set_calls = 0

    async def get(self, key):
        self.get_calls += 1
        if self.fail:
            raise ConnectionError("redis unavailable")
        return self.store.get(key)

    async def set(self, key, value, ex=None):
        self.set_calls += 1
        if self.fail:
            raise ConnectionError("redis unavailable")
        self.store[key] = value


def test_redis_url_prefers_the_dedicated_override_then_the_rate_limit_uri(monkeypatch):
    """Same Memorystore instance the rate limiter already uses -- second consumer."""

    monkeypatch.delenv("PLACES_CACHE_REDIS_URL", raising=False)
    monkeypatch.delenv("RATE_LIMIT_STORAGE_URI", raising=False)
    assert gms._redis_url() == ""

    monkeypatch.setenv("RATE_LIMIT_STORAGE_URI", "redis://shared:6379/0")
    assert gms._redis_url() == "redis://shared:6379/0"

    monkeypatch.setenv("PLACES_CACHE_REDIS_URL", "redis://dedicated:6379/1")
    assert gms._redis_url() == "redis://dedicated:6379/1"


def test_no_redis_configured_means_client_is_none(monkeypatch):
    monkeypatch.delenv("PLACES_CACHE_REDIS_URL", raising=False)
    monkeypatch.delenv("RATE_LIMIT_STORAGE_URI", raising=False)
    assert gms._get_redis_client() is None


@pytest.mark.asyncio
async def test_a_cell_another_instance_already_cached_in_redis_is_not_rebilled(monkeypatch):
    """The whole point of L2: one instance's paid call is every instance's free hit."""

    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(200, json={"places": []})

    monkeypatch.setattr(gms, "GOOGLE_MAPS_API_KEY", "k")
    monkeypatch.setattr(gms, "_async_client", lambda: _client_with(handler))

    fake = _FakeRedis()
    monkeypatch.setattr(gms, "_get_redis_client", lambda: fake)
    cache_key = gms._cache_key_string("nearby", ("education", *gms._geo_cell(37.4275, -122.1697)))
    fake.store[cache_key] = json.dumps([{"placeId": "seeded", "name": "Seeded Spot"}])

    result = await gms.GoogleMapsService().nearby_places(
        lat=37.4275, lng=-122.1697, category="education"
    )

    assert calls == 0
    assert result == [{"placeId": "seeded", "name": "Seeded Spot"}]


@pytest.mark.asyncio
async def test_nearby_places_writes_through_to_redis_on_a_fresh_fetch(monkeypatch):
    monkeypatch.setattr(gms, "GOOGLE_MAPS_API_KEY", "k")
    monkeypatch.setattr(
        gms,
        "_async_client",
        lambda: _client_with(lambda r: httpx.Response(200, json={"places": []})),
    )

    fake = _FakeRedis()
    monkeypatch.setattr(gms, "_get_redis_client", lambda: fake)

    await gms.GoogleMapsService().nearby_places(lat=37.4275, lng=-122.1697, category="education")

    cache_key = gms._cache_key_string("nearby", ("education", *gms._geo_cell(37.4275, -122.1697)))
    assert cache_key in fake.store
    assert json.loads(fake.store[cache_key]) == []
    assert fake.set_calls == 1


@pytest.mark.asyncio
async def test_a_redis_hit_backfills_the_local_cache_so_the_second_call_stays_local(monkeypatch):
    monkeypatch.setattr(gms, "GOOGLE_MAPS_API_KEY", "k")
    monkeypatch.setattr(
        gms,
        "_async_client",
        lambda: _client_with(lambda r: httpx.Response(200, json={"places": []})),
    )

    fake = _FakeRedis()
    monkeypatch.setattr(gms, "_get_redis_client", lambda: fake)
    cache_key = gms._cache_key_string("nearby", ("education", *gms._geo_cell(37.4275, -122.1697)))
    fake.store[cache_key] = json.dumps([{"placeId": "seeded", "name": "Seeded"}])

    svc = gms.GoogleMapsService()
    await svc.nearby_places(lat=37.4275, lng=-122.1697, category="education")
    assert fake.get_calls == 1

    await svc.nearby_places(lat=37.4275, lng=-122.1697, category="education")
    assert fake.get_calls == 1  # served from L1 this time, no second round trip


@pytest.mark.asyncio
async def test_a_broken_redis_degrades_to_a_fresh_provider_call_instead_of_failing(monkeypatch):
    """Losing Redis must cost money, never correctness -- this is the whole point
    of never letting a cache-layer exception reach the caller."""

    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(200, json={"places": []})

    monkeypatch.setattr(gms, "GOOGLE_MAPS_API_KEY", "k")
    monkeypatch.setattr(gms, "_async_client", lambda: _client_with(handler))
    monkeypatch.setattr(gms, "_get_redis_client", lambda: _FakeRedis(fail=True))

    result = await gms.GoogleMapsService().nearby_places(
        lat=37.4275, lng=-122.1697, category="education"
    )

    assert result == []
    assert calls == 1


@pytest.mark.asyncio
async def test_search_directory_category_also_writes_through_to_redis(monkeypatch):
    monkeypatch.setattr(gms, "GOOGLE_MAPS_API_KEY", "k")
    monkeypatch.setattr(
        gms,
        "_async_client",
        lambda: _client_with(lambda r: httpx.Response(200, json={"places": []})),
    )

    fake = _FakeRedis()
    monkeypatch.setattr(gms, "_get_redis_client", lambda: fake)

    await gms.GoogleMapsService().search_directory_category(
        lat=12.9716, lng=77.5946, category="hotels_stays", radius_meters=8046.72, limit=8
    )

    cache_key = gms._cache_key_string(
        "directory", ("hotels_stays", *gms._geo_cell(12.9716, 77.5946), 8047, 8)
    )
    assert cache_key in fake.store
    assert fake.set_calls == 1
