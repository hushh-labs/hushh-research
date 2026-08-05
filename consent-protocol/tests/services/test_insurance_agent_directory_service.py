"""The insurance agent directory's stream handling, edge cases and normalising.

Every frame shape here was taken from a live call to the deployed service, not
from its README — two of the behaviours pinned below (a 200 with zero rows for
an unparseable ZIP, and an attribution block with no terms URL) are not
documented there.
"""

import json

import httpx
import pytest

from hushh_mcp.services import insurance_agent_directory_service as iads


def _ndjson(*frames: dict) -> bytes:
    return ("\n".join(json.dumps(frame) for frame in frames) + "\n").encode()


def _configure(monkeypatch) -> None:
    monkeypatch.setenv("INSURANCE_AGENTS_API_BASE_URL", "https://agents.example")
    monkeypatch.setenv("INSURANCE_AGENTS_API_KEY", "test-key")


def _service(monkeypatch, handler) -> iads.InsuranceAgentDirectoryService:
    _configure(monkeypatch)
    return iads.InsuranceAgentDirectoryService(transport=httpx.MockTransport(handler))


_AGENCY_STREAM = _ndjson(
    {
        "type": "meta",
        "query": "98033",
        "resolvedFrom": "postal",
        "resolvedLocation": {"city": "Kirkland", "state": "WA", "zip": "98033"},
        "estimatedTotal": 704,
        "available": 50,
        "returned": 1,
        "limit": 10,
        "hasMore": True,
        "nextOffset": 10,
        "truncatedBy": "upstreamPaging",
        "cache": "cold",
        "attribution": {
            "source": "Nationwide Agency Locator",
            "sourceUrl": "https://agency.nationwide.com",
            "notice": "Agency data retrieved from the Nationwide agency locator.",
        },
    },
    {
        "type": "batch",
        "seq": 1,
        "items": [
            {
                "id": "13342248",
                "name": "Nationwide Insurance: B G I Agency Network Inc.",
                "address": {
                    "line1": "10829 NE 68th St",
                    "line2": "Ste 202",
                    "city": "Kirkland",
                    "region": "WA",
                    "postalCode": "98033",
                    "formatted": "10829 NE 68th St, Ste 202, Kirkland, WA 98033",
                },
                "phone": "(206) 726-0906",
                "email": "lkoehler@bginetwork.com",
                "website": "https://agency.nationwide.com/wa/kirkland/98033/b-g-i",
                "products": ["Auto", "Commercial", "Farm", "Home"],
                "agencyType": "Standard Independent",
                "tier": None,
                "distanceMiles": 0.22,
            }
        ],
    },
    {"type": "ranking_final", "total": 1, "mode": "agency"},
    {"type": "done", "ms": 180, "returned": 1},
)


@pytest.mark.asyncio
async def test_a_search_row_is_flattened_onto_the_card_shape(monkeypatch):
    service = _service(
        monkeypatch,
        lambda request: httpx.Response(200, content=_AGENCY_STREAM),
    )
    result = await service.search(postal_code="98033")

    assert len(result["items"]) == 1
    card = result["items"][0]
    assert card["id"] == "13342248"
    assert card["phone"] == "(206) 726-0906"
    assert card["products"] == ["Auto", "Commercial", "Farm", "Home"]
    assert card["distanceMiles"] == pytest.approx(0.22)
    assert card["city"] == "Kirkland"
    assert card["state"] == "WA"
    assert card["address"]["line2"] == "Ste 202"


@pytest.mark.asyncio
async def test_the_repeated_carrier_prefix_is_stripped_from_the_name(monkeypatch):
    """Every row is a Nationwide agency and the credit line already says so."""
    service = _service(
        monkeypatch,
        lambda request: httpx.Response(200, content=_AGENCY_STREAM),
    )
    result = await service.search(postal_code="98033")
    assert result["items"][0]["name"] == "B G I Agency Network Inc."


def test_a_row_named_only_for_the_carrier_is_not_emptied():
    """Stripping must never leave a card with no name at all."""
    assert iads._display_name("Nationwide Insurance") == "Nationwide Insurance"
    assert iads._display_name("Nationwide Insurance: ") == "Nationwide Insurance:"


@pytest.mark.asyncio
async def test_an_uncovered_location_is_an_empty_list_not_an_error(monkeypatch):
    """The locator answers 200 with zero rows outside its coverage.

    Verified against the live service with lat=0&lng=-30. Mapping that onto an
    error would show a failure where the honest answer is "nobody here".
    """
    empty = _ndjson(
        {
            "type": "meta",
            "resolvedLocation": {"city": "", "state": "", "zip": ""},
            "available": 0,
            "returned": 0,
            "hasMore": False,
            "nextOffset": None,
            "limit": 10,
            "cache": "cold",
        },
        {"type": "done", "ms": 12, "returned": 0},
    )
    service = _service(monkeypatch, lambda request: httpx.Response(200, content=empty))
    result = await service.search(lat=0.0, lng=-30.0)

    assert result["items"] == []
    assert result["meta"]["available"] == 0
    assert result["meta"]["hasMore"] is False
    # All-blank strings must not become an empty "in  ,  " label.
    assert result["meta"]["resolvedLocation"] is None


@pytest.mark.asyncio
async def test_a_terminal_error_frame_on_a_200_is_still_a_failure(monkeypatch):
    """The stream can fail after the status line has already said 200."""
    stream = _ndjson(
        {"type": "meta", "returned": 0, "limit": 10},
        {"type": "error", "error": "upstream bot challenge"},
    )
    service = _service(monkeypatch, lambda request: httpx.Response(200, content=stream))
    with pytest.raises(iads.InsuranceAgentDirectoryError) as caught:
        await service.search(postal_code="98033")
    assert caught.value.status_code == 502


@pytest.mark.asyncio
async def test_an_upstream_auth_failure_is_never_reported_as_the_callers(monkeypatch):
    """A 401 means *our* key is wrong; a caller must not retry credentials."""
    service = _service(monkeypatch, lambda request: httpx.Response(401))
    with pytest.raises(iads.InsuranceAgentDirectoryError) as caught:
        await service.search(postal_code="98033")
    assert caught.value.status_code == 502


@pytest.mark.asyncio
async def test_a_busy_upstream_carries_its_retry_after_through(monkeypatch):
    service = _service(
        monkeypatch,
        lambda request: httpx.Response(429, headers={"retry-after": "42"}),
    )
    with pytest.raises(iads.InsuranceAgentDirectoryError) as caught:
        await service.search(postal_code="98033")
    assert caught.value.status_code == 429
    assert caught.value.retry_after_seconds == 42


@pytest.mark.asyncio
async def test_an_unconfigured_backend_says_so_without_calling_out(monkeypatch):
    monkeypatch.delenv("INSURANCE_AGENTS_API_BASE_URL", raising=False)
    monkeypatch.delenv("INSURANCE_AGENTS_API_BASE", raising=False)
    monkeypatch.delenv("INSURANCE_AGENTS_API_KEY", raising=False)
    service = iads.InsuranceAgentDirectoryService()
    with pytest.raises(iads.InsuranceAgentDirectoryError) as caught:
        await service.search(postal_code="98033")
    assert caught.value.status_code == 503


@pytest.mark.asyncio
async def test_a_search_needs_a_location_of_some_kind(monkeypatch):
    service = _service(monkeypatch, lambda request: httpx.Response(200, content=b""))
    with pytest.raises(iads.InsuranceAgentDirectoryError) as caught:
        await service.search()
    assert caught.value.status_code == 400


@pytest.mark.asyncio
async def test_coordinates_are_sent_at_six_decimals_and_clamped_limits(monkeypatch):
    seen: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(dict(request.url.params))
        return httpx.Response(200, content=_AGENCY_STREAM)

    service = _service(monkeypatch, handler)
    await service.search(lat=47.6769, lng=-122.206, radius_mi=999, limit=9999)

    assert seen["lat"] == "47.676900"
    assert seen["lng"] == "-122.206000"
    # Radius and limit are clamped to the contract, not passed through raw.
    assert seen["radiusMi"] == "100.0"
    assert seen["limit"] == "50"
    assert seen["stream"] == "ndjson"


@pytest.mark.asyncio
async def test_the_locators_own_credit_is_carried_through(monkeypatch):
    """The locator supplies no terms or error-reporting URL — inventing one
    would be worse than omitting it, so neither key is fabricated."""
    service = _service(
        monkeypatch,
        lambda request: httpx.Response(200, content=_AGENCY_STREAM),
    )
    result = await service.search(postal_code="98033")
    attribution = result["attribution"]

    assert attribution["source"] == "Nationwide Agency Locator"
    assert attribution["sourceUrl"] == "https://agency.nationwide.com"
    assert "termsUrl" not in attribution
    assert "errorReporting" not in attribution
    assert attribution["retrievedAt"]


@pytest.mark.asyncio
async def test_truncated_paging_is_reported_rather_than_promised(monkeypatch):
    """`estimatedTotal` is larger than what can actually be paged through."""
    service = _service(
        monkeypatch,
        lambda request: httpx.Response(200, content=_AGENCY_STREAM),
    )
    meta = (await service.search(postal_code="98033"))["meta"]

    assert meta["available"] == 50
    assert meta["truncated"] is True
    assert meta["nextOffset"] == 10
    assert "estimatedTotal" not in meta
    assert meta["resolvedLocation"] == {
        "city": "Kirkland",
        "state": "WA",
        "zip": "98033",
    }
