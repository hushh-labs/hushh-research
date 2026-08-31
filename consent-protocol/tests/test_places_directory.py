"""The places directory: its taxonomy, its streaming, and what it must not cost.

The sharpest risk in this feature is not the new surface, it is the old one.
`nearby_places` builds its "All" sweep by iterating `_NEARBY_SWEEP_TYPES`, so a
bucket added to that table becomes another concurrent provider call on every
check-in drawer open — a cost increase on a shipped feature that no test would
otherwise notice. The first test here pins that table's size.

Note what that does NOT cover any more: the drawer's CHIPS are no longer that
table. Classification moved to `place_taxonomy`, which is exhaustive over
Google's Table A, so a chip can be added for nothing. Only this table is a cost
argument.
"""

from __future__ import annotations

import asyncio
import inspect
import json

import pytest

from api.routes.one import places as places_routes
from hushh_mcp.services import google_maps_service as maps

# --------------------------------------------------------------------------- #
# The check-in picker must not pay for the directory's finer buckets.
# --------------------------------------------------------------------------- #


def test_the_check_in_sweep_still_costs_what_it_did() -> None:
    """One request per bucket, plus one unfiltered. Adding a bucket adds a call.

    Nine, up from the seven this test was written against. Worship and Civic
    bought their own buckets deliberately: neither family was in any bucket, so a
    temple or a police station reached the drawer only when the single unfiltered
    sweep happened to catch one. Folding them into the landmarks bucket instead
    would have kept the count at seven and let twenty nearby temples take every
    slot in it -- see the sibling test below, which is the guard that matters.
    """

    assert len(maps._NEARBY_SWEEP_TYPES) == 9
    assert set(maps._NEARBY_SWEEP_TYPES) == {
        "food_drink",
        "health",
        "shopping_services",
        "hotels_stays",
        "education",
        "outdoors_landmarks",
        "transit",
        "worship",
        "civic",
    }


def test_every_swept_type_belongs_to_the_bucket_that_fetches_it() -> None:
    """A bucket's types must classify to that bucket's own chip.

    The types in a bucket are free to REQUEST -- Google caps `includedTypes` at
    50 -- but the response is capped at 20 and ranked by distance, so every type
    in a bucket competes for the same twenty slots. A bucket that fetches types
    belonging to some other chip therefore spends its budget on rows it will not
    show, and starves its own chip.

    That is not hypothetical: worship and government types were briefly packed
    into the landmarks bucket to keep the bucket count down, and in a pilgrimage
    city twenty nearby temples would have taken every slot and left the Leisure
    chip empty at a spot with parks and museums in range. This is a better guard
    than the count above, because a count cannot see it.
    """

    for chip, place_types in maps._NEARBY_SWEEP_TYPES.items():
        for place_type in place_types:
            assert chip in maps._taxonomy.place_categories([place_type]), (
                f"the {chip!r} bucket fetches {place_type!r}, which is classified as "
                f"{maps._taxonomy.place_categories([place_type])} and can never show under {chip!r}"
            )


def test_the_two_taxonomies_are_separate_objects() -> None:
    """Aliasing them would silently couple the picker's cost to the directory."""

    assert maps._DIRECTORY_CATEGORY_TYPES is not maps._NEARBY_SWEEP_TYPES


def test_the_directory_offers_exactly_ten_categories() -> None:
    assert len(maps._DIRECTORY_CATEGORY_TYPES) == 10
    assert maps.DIRECTORY_CATEGORY_SLUGS == (
        "hotels_stays",
        "food_drink",
        "health",
        "banking",
        "shops",
        "fitness_beauty",
        "auto",
        "transit",
        "education",
        "outdoors",
    )


def test_every_directory_place_type_is_one_the_picker_already_used() -> None:
    """The three new buckets re-partition an existing chip; they invent nothing.

    A type here that the picker never asked for would be an unreviewed guess at
    a provider vocabulary, which is exactly how a category quietly returns
    nothing in production.
    """

    # Checked against the picker's full taxonomy rather than the handful of
    # types its sweep happens to request. That table is exhaustive over Google's
    # Table A now, so the two hardcoded exceptions this test used to carry
    # (`spa`, `electric_vehicle_charging_station`) are simply members of it.
    known = set(maps._taxonomy.CHIP_BY_PLACE_TYPE)

    for slug, types in maps._DIRECTORY_CATEGORY_TYPES.items():
        for place_type in types:
            assert place_type in known, f"{slug} invents the type {place_type}"


# --------------------------------------------------------------------------- #
# Category resolution
# --------------------------------------------------------------------------- #


def test_unknown_categories_are_dropped_not_fatal() -> None:
    """A client one release ahead should get the nine we have, not an error."""

    resolved = places_routes._resolve_categories(["hotels_stays", "teleportation"])

    assert resolved == ["hotels_stays"]


def test_categories_come_back_in_the_tables_order_not_the_requests() -> None:
    resolved = places_routes._resolve_categories(["outdoors", "hotels_stays", "banking"])

    assert resolved == ["hotels_stays", "banking", "outdoors"]


def test_duplicate_categories_collapse() -> None:
    """Two of the same slug would otherwise be two provider calls."""

    assert places_routes._resolve_categories(["banking", "banking"]) == ["banking"]


# --------------------------------------------------------------------------- #
# The origin box takes an area name, not just a postcode.
# --------------------------------------------------------------------------- #


def test_an_area_name_is_a_valid_origin() -> None:
    """The bound was 12 characters, which is a postcode and nothing else.

    `_resolve_origin` hands this straight to Places Text Search, which resolves
    "Koramangala, Bengaluru" perfectly well -- but the schema rejected it before
    it ever got there, and the resulting 422 reached the reader as an outage.
    """

    payload = places_routes.PlacesSearchRequest(postalCode="Koramangala, Bengaluru")

    assert payload.postal_code == "Koramangala, Bengaluru"


def test_a_postcode_still_resolves() -> None:
    assert places_routes.PlacesSearchRequest(postalCode="560034").postal_code == "560034"


def test_an_unbounded_origin_is_still_refused() -> None:
    """Widened, not opened: this string is forwarded to a paid provider."""

    with pytest.raises(ValueError):
        places_routes.PlacesSearchRequest(postalCode="x" * 121)


# --------------------------------------------------------------------------- #
# Streaming
# --------------------------------------------------------------------------- #


class _NeverDisconnected:
    async def is_disconnected(self) -> bool:
        return False


def _frames(chunks: list[bytes]) -> list[dict]:
    parsed = []
    for chunk in chunks:
        for block in chunk.decode().split("\n\n"):
            if not block.strip():
                continue
            data = block.split("data: ", 1)[1]
            parsed.append(json.loads(data))
    return parsed


async def _collect(monkeypatch, behaviour) -> list[dict]:
    monkeypatch.setattr(
        maps.GoogleMapsService,
        "search_directory_category",
        behaviour,
        raising=True,
    )
    chunks = [
        chunk
        async for chunk in places_routes._stream_categories(
            request=_NeverDisconnected(),
            lat=12.9716,
            lng=77.5946,
            categories=["hotels_stays", "food_drink"],
            radius_meters=8046.72,
            limit=8,
            meta=places_routes._meta(
                categories=["hotels_stays", "food_drink"], radius_mi=5.0, limit=8
            ),
        )
    ]
    return _frames(chunks)


def test_each_category_is_its_own_frame(monkeypatch) -> None:
    async def behaviour(self, *, lat, lng, category, radius_meters, limit):
        return [{"placeId": f"{category}-1", "name": category}]

    frames = asyncio.run(_collect(monkeypatch, behaviour))
    events = [frame["event"] for frame in frames]

    assert events[0] == "meta"
    assert events[-1] == "done"
    assert events.count("results") == 2


def test_a_slow_category_does_not_hold_back_a_fast_one(monkeypatch) -> None:
    """The whole point: results leave as they land, not after the slowest.

    `asyncio.gather` would order these by the request list; emitting on
    completion orders them by who answered first.
    """

    async def behaviour(self, *, lat, lng, category, radius_meters, limit):
        if category == "hotels_stays":
            await asyncio.sleep(0.05)
        return [{"placeId": f"{category}-1", "name": category}]

    frames = asyncio.run(_collect(monkeypatch, behaviour))
    results = [frame["category"] for frame in frames if frame["event"] == "results"]

    # food_drink was requested second and answered first.
    assert results == ["food_drink", "hotels_stays"]


def test_one_failing_category_does_not_empty_the_stream(monkeypatch) -> None:
    async def behaviour(self, *, lat, lng, category, radius_meters, limit):
        if category == "hotels_stays":
            raise maps.GoogleMapsError("upstream said no", status_code=502)
        return [{"placeId": "cafe-1", "name": "Third Wave"}]

    frames = asyncio.run(_collect(monkeypatch, behaviour))
    events = [frame["event"] for frame in frames]

    assert "results" in events
    assert "category_error" in events
    # The stream still completes cleanly; a dead category is not a dead request.
    assert frames[-1]["event"] == "done"
    assert frames[-1]["failed"] == ["hotels_stays"]
    assert frames[-1]["delivered"] == 1


def test_an_unexpected_crash_is_contained_to_its_category(monkeypatch) -> None:
    """A bug in one bucket must not take the other nine with it."""

    async def behaviour(self, *, lat, lng, category, radius_meters, limit):
        if category == "hotels_stays":
            raise ValueError("something we did not anticipate")
        return [{"placeId": "cafe-1", "name": "Third Wave"}]

    frames = asyncio.run(_collect(monkeypatch, behaviour))

    assert frames[-1]["event"] == "done"
    assert frames[-1]["failed"] == ["hotels_stays"]
    assert frames[-1]["delivered"] == 1


def test_the_stream_carries_the_headers_that_stop_it_being_buffered() -> None:
    """Without these the stream is an ordinary response with extra steps.

    Checked at the source because the header dict is built inside the route and
    the route is auth-gated; the repo already asserts deploy wiring this way.
    `no-transform` is the subtle one: the frontend runs with `compress: true`,
    and a compressing intermediary may buffer a body in order to compress it.
    """

    source = inspect.getsource(places_routes)

    assert "no-transform" in source
    assert '"X-Accel-Buffering": "no"' in source
    assert 'media_type="text/event-stream"' in source


def test_every_frame_is_named_because_the_parser_drops_unnamed_ones() -> None:
    """`parseSSEBlocks` skips any block without an `event:` line.

    A heartbeat sent as a bare SSE comment would therefore never reach the
    client and could not reset its idle timer -- the one job it has.
    """

    for event in ("meta", "results", "category_error", "heartbeat", "done"):
        rendered = places_routes._frame(event, {}).decode()
        assert rendered.startswith(f"event: {event}\n")
        assert "\ndata: " in rendered
        assert rendered.endswith("\n\n")


def test_the_done_frame_is_terminal() -> None:
    """Clients need one unambiguous end, not an inference from a closed socket."""

    rendered = places_routes._frame("done", {"delivered": 0, "failed": [], "terminal": True})

    assert json.loads(rendered.decode().split("data: ", 1)[1])["terminal"] is True


# --------------------------------------------------------------------------- #
# Provider request shaping
# --------------------------------------------------------------------------- #


def test_radius_is_clamped_to_what_the_provider_accepts() -> None:
    """Google rejects a radius above 50 km, so an over-wide ask must be bounded."""

    assert maps._DIRECTORY_MAX_RADIUS_METERS == 50_000.0
    # The route's own ceiling keeps a request from ever reaching that clamp.
    assert places_routes._MAX_RADIUS_MI * places_routes._METERS_PER_MILE < 50_000.0


def test_the_list_field_mask_stays_off_the_dearer_tiers() -> None:
    """Rating, hours, phone and website are billed higher, and are per-row here.

    They belong on the detail call, which happens once for the one place a
    reader opened, not once per row of every category they scrolled past.
    """

    for expensive in (
        "places.rating",
        "places.regularOpeningHours",
        "places.nationalPhoneNumber",
        "places.websiteUri",
        "places.priceLevel",
    ):
        assert expensive not in maps._DIRECTORY_LIST_FIELD_MASK


def test_the_detail_mask_buys_what_the_sheet_actually_shows() -> None:
    for needed in ("nationalPhoneNumber", "websiteUri", "regularOpeningHours"):
        assert needed in maps._DIRECTORY_DETAIL_FIELD_MASK


@pytest.mark.parametrize(
    "place",
    [
        {"id": "", "displayName": {"text": "No id"}},
        {"id": "x", "displayName": {"text": ""}},
        {"id": "x", "displayName": {"text": "No location"}},
        {"id": "x", "displayName": {"text": "Bad location"}, "location": {"latitude": "nope"}},
    ],
)
def test_unusable_provider_rows_are_dropped(place: dict) -> None:
    row = maps.GoogleMapsService()._normalize_directory_place(
        place, lat=12.97, lng=77.59, category="shops"
    )

    assert row is None


def test_a_geocoded_address_is_not_a_business() -> None:
    """The unfiltered sweep can surface street addresses; a directory must not."""

    row = maps.GoogleMapsService()._normalize_directory_place(
        {
            "id": "x",
            "displayName": {"text": "12 Residency Rd"},
            "location": {"latitude": 12.97, "longitude": 77.59},
            "primaryType": "street_address",
        },
        lat=12.97,
        lng=77.59,
        category="shops",
    )

    assert row is None


def test_a_normalized_row_carries_its_own_bucket_and_a_real_distance() -> None:
    row = maps.GoogleMapsService()._normalize_directory_place(
        {
            "id": "place-1",
            "displayName": {"text": "Hotel Vivanta"},
            "shortFormattedAddress": "12 Residency Rd",
            "location": {"latitude": 12.9800, "longitude": 77.5946},
            "primaryType": "hotel",
            "primaryTypeDisplayName": {"text": "Hotel"},
            "businessStatus": "OPERATIONAL",
        },
        lat=12.9716,
        lng=77.5946,
        category="hotels_stays",
    )

    assert row is not None
    assert row["category"] == "hotels_stays"
    assert row["name"] == "Hotel Vivanta"
    assert row["categoryLabel"] == "Hotel"
    # ~930 m north; the exact figure matters less than it being computed at all.
    assert 800 < row["distanceMeters"] < 1100
