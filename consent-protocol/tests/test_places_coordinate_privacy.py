"""A reader's position must never reach a URL, a log line, or a stream frame.

The places directory adds a third surface that takes coordinates, and a fourth
sink the advisor directory does not have: a long-lived response body. A stream
that echoed the request point back in a heartbeat would put it somewhere the
advisor tests never had to look.

Coordinates are treated as credential-grade here on purpose, for the same reason
they are on the advisor routes: a home address is not less sensitive than an
API key.
"""

from __future__ import annotations

import inspect
import json

from api.routes.one import places as places_routes


def _routes() -> list[tuple[str, frozenset[str]]]:
    return [(route.path, frozenset(route.methods or ())) for route in places_routes.router.routes]


def test_every_search_is_a_post_so_no_position_reaches_the_request_line() -> None:
    paths = dict(_routes())

    assert "POST" in paths["/api/one/places/stream"]
    assert "POST" in paths["/api/one/places/search"]
    assert "POST" in paths["/api/one/places/details"]


def test_no_places_route_accepts_a_location_as_a_query_parameter() -> None:
    """A GET route on this router would put coordinates back in the URL."""

    for route in places_routes.router.routes:
        if "GET" not in (route.methods or ()):
            continue
        params = inspect.signature(route.endpoint).parameters
        for name in ("lat", "lng", "latitude", "longitude", "postal_code", "postalCode"):
            assert name not in params, f"{route.path} takes {name} on a GET"


def test_no_places_route_is_a_get_at_all() -> None:
    """Every read here carries a position, so none of them can be a GET.

    Stated separately from the parameter check because a GET added later with a
    differently-named coordinate argument would slip past that one.
    """

    for path, methods in _routes():
        assert "GET" not in methods, f"{path} is a GET on a router that takes positions"


_COORDINATE_KEYS = {"lat", "lng", "latitude", "longitude", "coordinates", "location"}


def _keys(value: object) -> set[str]:
    """Every key anywhere in a decoded frame."""

    if isinstance(value, dict):
        found = set(value)
        for nested in value.values():
            found |= _keys(nested)
        return found
    if isinstance(value, list):
        found: set[str] = set()
        for nested in value:
            found |= _keys(nested)
        return found
    return set()


def test_a_heartbeat_frame_carries_no_position() -> None:
    """The stream stays open, so its filler frames are a sink of their own."""

    frame = places_routes._frame("heartbeat", {}).decode()
    payload = json.loads(frame.split("data: ", 1)[1].strip())

    assert payload == {"event": "heartbeat"}


def test_the_meta_frame_does_not_echo_the_request_point() -> None:
    """`meta` describes the query, and the query includes where the reader is."""

    meta = places_routes._meta(categories=["hotels_stays"], radius_mi=5.0, limit=8)
    rendered = places_routes._frame("meta", meta).decode()
    payload = json.loads(rendered.split("data: ", 1)[1].strip())

    assert payload["categories"] == ["hotels_stays"]
    # Checked on decoded keys, not on the raw text: "maps-platform" contains
    # "lat", and a substring match would fail on the attribution URL forever.
    assert not (_keys(payload) & _COORDINATE_KEYS)
    # And no coordinate-shaped value survived into the frame either.
    assert "12.9716" not in rendered
    assert "77.5946" not in rendered
