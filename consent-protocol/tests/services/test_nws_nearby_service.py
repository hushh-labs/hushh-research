"""NWS Nearby service: coverage fidelity, error taxonomy, and coordinate hygiene.

The payloads below are trimmed copies of real responses from the deployed
service, so a contract drift upstream shows up here rather than on the screen.
"""

import httpx
import pytest

from hushh_mcp.services import nws_nearby_service as nws


@pytest.fixture(autouse=True)
def _clear_cache():
    nws.reset_cache()
    yield
    nws.reset_cache()


def _configure(monkeypatch) -> None:
    monkeypatch.setenv("NWS_NEARBY_API_BASE_URL", "https://nws.example")
    monkeypatch.setenv("NWS_NEARBY_API_KEY", "test-key")


def _service(monkeypatch, handler, **kwargs) -> nws.NwsNearbyService:
    _configure(monkeypatch)
    return nws.NwsNearbyService(transport=httpx.MockTransport(handler), **kwargs)


_COVERED = {
    "query": {"label": "Kirkland public-association bootstrap query area"},
    "coverage": {
        "status": "COVERED",
        "reason_code": "APPROVED_BOOTSTRAP_MARKET",
        "market_id": "us-wa-kirkland-bootstrap",
        "market_label": "Kirkland public-association bootstrap",
        "country_code": "US",
        "complete": False,
        "data_mode": "VERIFIED_PUBLIC_BOOTSTRAP",
        "message": "Results are limited to reviewed public-association records.",
    },
    "snapshot": {
        "data_mode": "VERIFIED_PUBLIC_BOOTSTRAP",
        "score_status": "PROVISIONAL",
        "complete": False,
        "model_version": "nws-v2.2.0-bootstrap.2026-08-12",
        "verified_at": "2026-08-12",
    },
    "score_definition": "NWS estimates public professional network strength.",
    "summary": {
        "verified_seed_candidate_count": 11,
        "returned_count": 1,
        "search_performed": True,
        "effective_radius_km": 20,
    },
    "results": [
        {
            "rank": 1,
            "person_id": "bootstrap_michael_hsing",
            "display_name": "Michael R. Hsing",
            "headline": "Chairman, President and CEO",
            "organization": "Monolithic Power Systems",
            "lane": "BUILDER",
            "global_nws": 83.4022,
            "nearby_rank_score": 83.4259,
            "score_status": "PROVISIONAL",
            "confidence": {"score": 0.9306, "grade": "A"},
            "public_location": {
                "label": "Monolithic Power Systems public Kirkland office association",
                "association_kind": "CURRENT_ORGANIZATION_OFFICE",
                "granularity": "EXACT_PUBLIC_VENUE",
                "approximate_distance_band": "within 2 km",
                "note": "Distance is to a public professional association, never a residence.",
            },
            "reasons": ["High-authority roles at influential institutions"],
            "warnings": [],
            "tags": ["semiconductors", "founder", "board"],
            "revalidation_required": False,
            "sources": [
                {
                    "publisher": "Monolithic Power Systems",
                    "title": "Management",
                    "url": "https://www.monolithicpower.com/management",
                }
            ],
            "model_version": "nws-v2.2.0-bootstrap.2026-08-12",
        }
    ],
}

_NOT_COVERED = {
    "query": {"label": "Coarsened coordinate query area"},
    "coverage": {
        "status": "NOT_COVERED",
        "reason_code": "NO_APPROVED_MARKET_DATA",
        "country_code": "IN",
        "complete": False,
        "data_mode": "VERIFIED_PUBLIC_BOOTSTRAP",
        "message": "The location was accepted, but this release has no approved dataset.",
    },
    "snapshot": {"score_status": "PROVISIONAL", "complete": False},
    "summary": {"returned_count": 0, "search_performed": False},
    "results": [],
}

_UNRESOLVED = {
    "query": {"label": "Postal-code query area"},
    "coverage": {
        "status": "LOCATION_UNRESOLVED",
        "reason_code": "POSTAL_CODE_NOT_IN_GEOGRAPHY_INDEX",
        "country_code": "IN",
        "complete": False,
        "data_mode": "VERIFIED_PUBLIC_BOOTSTRAP",
        "message": "The postal code was accepted, but there is no canonical geography for it.",
    },
    "snapshot": {"score_status": "PROVISIONAL", "complete": False},
    "summary": {"returned_count": 0, "search_performed": False},
    "results": [],
}

_COUNTRY_MISMATCH = {
    "query": {"label": "Coarsened coordinate query area"},
    "coverage": {
        "status": "NOT_COVERED",
        "reason_code": "COUNTRY_CONTEXT_DOES_NOT_MATCH_APPROVED_MARKET",
        "country_code": "IN",
        "complete": False,
        "data_mode": "VERIFIED_PUBLIC_BOOTSTRAP",
        "message": "The supplied country context does not match the approved market.",
    },
    "snapshot": {"score_status": "PROVISIONAL", "complete": False},
    "summary": {"returned_count": 0, "search_performed": False},
    "results": [],
}


# ---------------------------------------------------------------- coverage


@pytest.mark.asyncio
async def test_covered_market_returns_ranked_records(monkeypatch):
    service = _service(monkeypatch, lambda request: httpx.Response(200, json=_COVERED))
    result = await service.discover(postal_code="98033")

    assert result["coverage"]["status"] == "COVERED"
    assert result["coverage"]["reasonCode"] == "APPROVED_BOOTSTRAP_MARKET"
    assert result["coverage"]["marketLabel"] == "Kirkland public-association bootstrap"
    assert result["summary"]["returnedCount"] == 1

    row = result["results"][0]
    assert row["displayName"] == "Michael R. Hsing"
    assert row["lane"] == "BUILDER"
    # Both scores travel: the list ranks by one and labels the other.
    assert row["nearbyRankScore"] == pytest.approx(83.4259)
    assert row["globalNws"] == pytest.approx(83.4022)
    assert row["confidence"]["grade"] == "A"
    assert row["publicLocation"]["distanceBand"] == "within 2 km"
    assert row["sources"][0]["publisher"] == "Monolithic Power Systems"


@pytest.mark.parametrize(
    ("payload", "status", "reason"),
    [
        (_NOT_COVERED, "NOT_COVERED", "NO_APPROVED_MARKET_DATA"),
        (_UNRESOLVED, "LOCATION_UNRESOLVED", "POSTAL_CODE_NOT_IN_GEOGRAPHY_INDEX"),
        (
            _COUNTRY_MISMATCH,
            "NOT_COVERED",
            "COUNTRY_CONTEXT_DOES_NOT_MATCH_APPROVED_MARKET",
        ),
    ],
)
@pytest.mark.asyncio
async def test_uncovered_states_pass_through_with_no_results(monkeypatch, payload, status, reason):
    """A coverage miss is a correct answer, not an error, and never borrows data."""
    service = _service(monkeypatch, lambda request: httpx.Response(200, json=payload))
    result = await service.discover(latitude=28.6139, longitude=77.209)

    assert result["coverage"]["status"] == status
    assert result["coverage"]["reasonCode"] == reason
    assert result["results"] == []
    assert result["summary"]["returnedCount"] == 0
    # The distinct upstream message is what lets the screen explain itself.
    assert result["coverage"]["message"]


@pytest.mark.asyncio
async def test_no_kirkland_data_leaks_into_an_uncovered_market(monkeypatch):
    """The negative-coverage guarantee the service's own expansion gate demands."""
    service = _service(monkeypatch, lambda request: httpx.Response(200, json=_NOT_COVERED))
    result = await service.discover(latitude=28.6139, longitude=77.209)

    serialized = repr(result)
    assert "Kirkland" not in serialized
    assert "bootstrap_michael_hsing" not in serialized
    assert result["coverage"]["marketId"] is None


# ------------------------------------------------------- coordinate hygiene


@pytest.mark.asyncio
async def test_coordinates_are_coarsened_before_leaving_this_process(monkeypatch):
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        import json as _json

        seen.update(_json.loads(request.content))
        return httpx.Response(200, json=_COVERED)

    service = _service(monkeypatch, handler)
    await service.discover(latitude=47.671523, longitude=-122.213387)

    assert seen["query"]["latitude"] == 47.67
    assert seen["query"]["longitude"] == -122.21
    # The precise coordinate must not survive anywhere in the outbound body.
    assert "47.671523" not in repr(seen)


@pytest.mark.asyncio
async def test_a_coordinate_query_carries_no_country_context(monkeypatch):
    """A guessed country suppresses results for a covered coordinate.

    We do no reverse geocoding, so a country attached to a coordinate would be
    a guess — and a wrong one returns COUNTRY_CONTEXT_DOES_NOT_MATCH.
    """
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        import json as _json

        seen.update(_json.loads(request.content))
        return httpx.Response(200, json=_COVERED)

    service = _service(monkeypatch, handler)
    await service.discover(latitude=47.6715, longitude=-122.2133, country_code="IN")

    assert "country_code" not in seen["query"]


@pytest.mark.asyncio
async def test_postal_query_keeps_the_country_the_advisor_typed(monkeypatch):
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        import json as _json

        seen.update(_json.loads(request.content))
        return httpx.Response(200, json=_UNRESOLVED)

    service = _service(monkeypatch, handler)
    await service.discover(postal_code="110001", country_code="in")

    assert seen["query"] == {"postal_code": "110001", "country_code": "IN"}


@pytest.mark.asyncio
async def test_api_key_travels_as_a_header_and_never_in_the_body(monkeypatch):
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["header"] = request.headers.get("x-nws-api-key")
        seen["body"] = request.content.decode()
        return httpx.Response(200, json=_COVERED)

    service = _service(monkeypatch, handler)
    await service.discover(postal_code="98033")

    assert seen["header"] == "test-key"
    assert "test-key" not in seen["body"]


# --------------------------------------------------------------- validation


@pytest.mark.asyncio
async def test_postal_without_country_is_refused_except_the_legacy_value(monkeypatch):
    service = _service(monkeypatch, lambda request: httpx.Response(200, json=_COVERED))

    with pytest.raises(nws.NwsNearbyError) as caught:
        await service.discover(postal_code="110001")
    assert caught.value.status_code == 400

    # 98033 is the one postal code the upstream still accepts bare.
    assert (await service.discover(postal_code="98033"))["coverage"]["status"] == "COVERED"


@pytest.mark.asyncio
async def test_malformed_location_input_never_reaches_the_upstream(monkeypatch):
    """Bad input is refused locally so it cannot spend a shared upstream quota."""
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(200, json=_COVERED)

    service = _service(monkeypatch, handler)

    for kwargs in (
        {},  # nothing at all
        {"latitude": 47.6},  # half a pair
        {"postal_code": "98033", "latitude": 47.6, "longitude": -122.2},  # both forms
        {"latitude": 91.0, "longitude": 0.0},  # out of range
        {"postal_code": "98033", "country_code": "USA"},  # not alpha-2
        {"postal_code": "!!"},  # not a postal shape
    ):
        with pytest.raises(nws.NwsNearbyError) as caught:
            await service.discover(**kwargs)
        assert caught.value.status_code == 400

    assert calls == []


@pytest.mark.asyncio
async def test_unknown_lane_or_grade_is_refused(monkeypatch):
    service = _service(monkeypatch, lambda request: httpx.Response(200, json=_COVERED))

    with pytest.raises(nws.NwsNearbyError):
        await service.discover(postal_code="98033", lanes=["NOPE"])
    with pytest.raises(nws.NwsNearbyError):
        await service.discover(postal_code="98033", minimum_confidence_grade="Z")


@pytest.mark.asyncio
async def test_filters_reach_the_upstream_in_its_own_vocabulary(monkeypatch):
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        import json as _json

        seen.update(_json.loads(request.content))
        return httpx.Response(200, json=_COVERED)

    service = _service(monkeypatch, handler)
    await service.discover(
        postal_code="98033",
        lanes=["builder", "BUILDER", "civic"],
        tags=["founder"],
        minimum_confidence_grade="a",
    )

    # Deduped and upper-cased; tags stay verbatim because the upstream matches
    # them as a subset of the candidate's own tags.
    assert seen["filters"]["lanes"] == ["BUILDER", "CIVIC"]
    assert seen["filters"]["tags"] == ["founder"]
    assert seen["filters"]["minimum_confidence_grade"] == "A"


# ------------------------------------------------------------ error taxonomy


@pytest.mark.asyncio
async def test_unconfigured_backend_reports_503_without_calling_out(monkeypatch):
    monkeypatch.delenv("NWS_NEARBY_API_BASE_URL", raising=False)
    monkeypatch.delenv("NWS_NEARBY_API_KEY", raising=False)
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(200, json=_COVERED)

    service = nws.NwsNearbyService(transport=httpx.MockTransport(handler))
    with pytest.raises(nws.NwsNearbyError) as caught:
        await service.discover(postal_code="98033")

    assert caught.value.status_code == 503
    assert calls == []
    assert nws.is_configured() is False


@pytest.mark.asyncio
async def test_upstream_401_is_reported_as_502_and_never_echoes_the_key(monkeypatch):
    """A 401 means *our* key is wrong — never the caller's business."""
    service = _service(monkeypatch, lambda request: httpx.Response(401, json={"detail": "nope"}))

    with pytest.raises(nws.NwsNearbyError) as caught:
        await service.discover(postal_code="98033")

    assert caught.value.status_code == 502
    assert "test-key" not in str(caught.value)
    assert "401" not in str(caught.value)


@pytest.mark.asyncio
async def test_upstream_429_preserves_retry_after(monkeypatch):
    service = _service(
        monkeypatch,
        lambda request: httpx.Response(429, headers={"Retry-After": "42"}, json={}),
    )

    with pytest.raises(nws.NwsNearbyError) as caught:
        await service.discover(postal_code="98033")

    assert caught.value.status_code == 429
    assert caught.value.retry_after_seconds == 42


@pytest.mark.asyncio
async def test_transport_and_garbage_failures_become_502(monkeypatch):
    def boom(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused")

    with pytest.raises(nws.NwsNearbyError) as caught:
        await _service(monkeypatch, boom).discover(postal_code="98033")
    assert caught.value.status_code == 502

    garbage = _service(monkeypatch, lambda request: httpx.Response(200, text="not json"))
    with pytest.raises(nws.NwsNearbyError) as caught:
        await garbage.discover(postal_code="98033")
    assert caught.value.status_code == 502


# ------------------------------------------------------------------- caching


@pytest.mark.asyncio
async def test_identical_queries_are_served_once(monkeypatch):
    """The upstream's 60/min is shared by every Hushh caller, so repeats cache."""
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(200, json=_COVERED)

    service = _service(monkeypatch, handler)
    first = await service.discover(postal_code="98033")
    second = await service.discover(postal_code="98033")

    assert len(calls) == 1
    assert first == second


@pytest.mark.asyncio
async def test_a_changed_filter_is_a_different_query(monkeypatch):
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(200, json=_COVERED)

    service = _service(monkeypatch, handler)
    await service.discover(postal_code="98033")
    await service.discover(postal_code="98033", lanes=["CIVIC"])
    await service.discover(postal_code="98033", minimum_confidence_grade="A")

    assert len(calls) == 3


@pytest.mark.asyncio
async def test_cache_can_be_disabled_for_a_caller(monkeypatch):
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(200, json=_COVERED)

    service = _service(monkeypatch, handler, use_cache=False)
    await service.discover(postal_code="98033")
    await service.discover(postal_code="98033")

    assert len(calls) == 2
