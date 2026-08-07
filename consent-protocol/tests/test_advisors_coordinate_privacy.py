"""A user's position must never reach a log line or a URL.

Two independent sinks leaked it before this was pinned:

1. The inbound request line. ``GET /api/one/advisors/nearby?lat=..&lng=..`` is
   recorded verbatim by the access log, and also lands in browser history and
   any Referer header. The search is a POST so there is no query string.

2. The outbound provider call. httpx logs every request URL at INFO, and the
   upstream directory requires coordinates as query parameters, so the only
   lever there is redaction.

Coordinates are treated as credential-grade here on purpose: a home address is
not less sensitive than an API key.
"""

from __future__ import annotations

import logging

import pytest

from api.routes.one import advisors as advisors_routes
from mcp_modules.log_redaction import SensitiveLogFilter


def _redact(message: str) -> str:
    record = logging.LogRecord("httpx", logging.INFO, "", 0, "%s", (message,), None)
    SensitiveLogFilter().filter(record)
    args = record.args
    return args[0] if isinstance(args, tuple) else str(args)


@pytest.mark.parametrize(
    "query",
    [
        "https://x/v1/advisors?lat=47.676900&lng=-122.206000&radiusMi=10.0",
        "https://x/v1/advisors?latitude=47.6769&longitude=-122.206",
        "https://maps.googleapis.com/maps/api/geocode/json?latlng=47.67,-122.20&key=k",
        "https://x/v1/advisors?postalCode=98033&limit=10",
    ],
)
def test_coordinates_are_redacted_from_outbound_request_logs(query: str) -> None:
    redacted = _redact(f"HTTP Request: GET {query}")

    assert "[REDACTED]" in redacted
    for leak in ("47.676900", "47.6769", "-122.206000", "-122.206", "98033"):
        assert leak not in redacted


def test_redaction_leaves_harmless_parameters_readable() -> None:
    """Over-redacting would make production logs useless for debugging."""
    redacted = _redact("HTTP Request: GET https://x/v1/advisors?lat=1.0&radiusMi=10.0&limit=5")

    assert "radiusMi=10.0" in redacted
    assert "limit=5" in redacted


def _routes() -> list[tuple[str, frozenset[str]]]:
    return [(route.path, frozenset(route.methods or ())) for route in advisors_routes.router.routes]


def test_the_search_is_a_post_so_no_position_reaches_the_request_line() -> None:
    paths = dict(_routes())

    assert "POST" in paths["/api/one/advisors/search"]
    # The GET this replaced must be gone, not merely unused.
    assert "/api/one/advisors/nearby" not in paths


def test_no_advisor_route_accepts_a_location_as_a_query_parameter() -> None:
    """A GET route on this router would put coordinates back in the URL."""
    import inspect

    for route in advisors_routes.router.routes:
        if "GET" not in (route.methods or ()):
            continue
        params = inspect.signature(route.endpoint).parameters
        for name in ("lat", "lng", "latitude", "longitude", "postal_code", "postalCode"):
            assert name not in params, f"{route.path} takes {name} on a GET"


def test_the_profile_route_carries_only_a_public_identifier() -> None:
    """A CRD is a public FINRA id, so it is safe in a path; nothing else is."""
    paths = dict(_routes())

    assert "GET" in paths["/api/one/advisors/{crd}"]
