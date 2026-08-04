import json

import httpx
import pytest

from hushh_mcp.services import advisor_directory_service as ads


def _ndjson(*frames: dict) -> bytes:
    return ("\n".join(json.dumps(frame) for frame in frames) + "\n").encode()


def _configure(monkeypatch) -> None:
    monkeypatch.setenv("ADVISORS_API_BASE_URL", "https://advisors.example")
    monkeypatch.setenv("ADVISORS_API_KEY", "test-key")


def _service(monkeypatch, handler) -> ads.AdvisorDirectoryService:
    _configure(monkeypatch)
    return ads.AdvisorDirectoryService(transport=httpx.MockTransport(handler))


_PERSON_STREAM = _ndjson(
    {
        "type": "meta",
        "radiusMi": 5,
        "radiusRequested": 10,
        "radiusAdjusted": True,
        "returned": 1,
        "available": 300,
        "hasMore": True,
        "nextOffset": 10,
        "limit": 10,
        "grouped": False,
    },
    {
        "type": "batch",
        "seq": 1,
        "items": [
            {
                "crd": "862222",
                "name": "CHRISTINE NOELLE COTE",
                "yearsExperience": 47.5,
                "hasDisclosures": True,
                "distanceMiles": 0.47,
                "firm": {
                    "firmId": "149777",
                    "firmName": "MORGAN STANLEY",
                    "branchCity": "Kirkland",
                    "branchState": "WA",
                    "phone": "914-225-1000",
                    "officeAddress": {"city": "PURCHASE"},
                },
            }
        ],
    },
    {"type": "done", "ms": 120},
)


@pytest.mark.asyncio
async def test_search_sends_bearer_key_and_list_tuned_params(monkeypatch):
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["auth"] = request.headers.get("Authorization")
        seen["path"] = request.url.path
        seen["params"] = dict(request.url.params)
        return httpx.Response(200, content=_PERSON_STREAM)

    await _service(monkeypatch, handler).search(lat=47.6769, lng=-122.206)

    assert seen["auth"] == "Bearer test-key"
    assert seen["path"] == "/v1/advisors"
    # A search row already carries everything a card needs, so the list must not
    # pay for profile hydration.
    assert seen["params"]["detail"] == "false"
    assert seen["params"]["stream"] == "ndjson"
    assert seen["params"]["type"] == "ia"
    assert seen["params"]["status"] == "active"
    assert seen["params"]["lat"].startswith("47.676")


@pytest.mark.asyncio
async def test_search_normalizes_person_rows(monkeypatch):
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=_PERSON_STREAM)

    result = await _service(monkeypatch, handler).search(lat=47.6769, lng=-122.206)

    assert result["items"] == [
        {
            "kind": "advisor",
            "id": "862222",
            "crd": "862222",
            "name": "CHRISTINE NOELLE COTE",
            "firmName": "MORGAN STANLEY",
            "yearsExperience": 47.5,
            "hasDisclosures": True,
            "distanceMiles": 0.47,
            "city": "Kirkland",
            "state": "WA",
            "phone": "914-225-1000",
        }
    ]
    assert result["meta"]["radiusAdjusted"] is True
    assert result["meta"]["radiusMi"] == 5
    assert result["meta"]["nextOffset"] == 10
    assert result["meta"]["grouped"] is False
    assert result["attribution"]["source"] == "FINRA BrokerCheck"


@pytest.mark.asyncio
async def test_search_flattens_branch_rows_onto_the_same_card_shape(monkeypatch):
    """Dense metros return branch offices instead of people; one card shape."""

    stream = _ndjson(
        {"type": "meta", "grouped": True, "returned": 1, "hasMore": False},
        {
            "type": "branches",
            "items": [
                {
                    "branchOfficeId": "408168",
                    "firmName": "MORGAN STANLEY",
                    "advisorCount": 74,
                    "distanceMeters": 800,
                    "city": "New York",
                    "state": "NY",
                    "advisors": [{"name": "A ADVISOR"}, {"name": "B ADVISOR"}],
                }
            ],
        },
        {"type": "done"},
    )

    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=stream)

    result = await _service(monkeypatch, handler).search(lat=40.75, lng=-73.99)
    row = result["items"][0]

    assert result["meta"]["grouped"] is True
    assert row["kind"] == "branch"
    assert row["name"] == "MORGAN STANLEY"
    assert row["advisorCount"] == 74
    assert row["advisorNames"] == ["A ADVISOR", "B ADVISOR"]
    assert row["distanceMiles"] == pytest.approx(0.497, abs=0.01)


@pytest.mark.asyncio
async def test_search_accepts_postal_code_and_strips_punctuation(monkeypatch):
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["params"] = dict(request.url.params)
        return httpx.Response(200, content=_PERSON_STREAM)

    await _service(monkeypatch, handler).search(postal_code="98033-1234 ")

    assert seen["params"]["postalCode"] == "980331234"
    assert "lat" not in seen["params"]


@pytest.mark.asyncio
async def test_search_clamps_radius_and_limit(monkeypatch):
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["params"] = dict(request.url.params)
        return httpx.Response(200, content=_PERSON_STREAM)

    await _service(monkeypatch, handler).search(
        lat=1.0, lng=1.0, radius_mi=9_000, limit=5_000, offset=-4
    )

    assert seen["params"]["radiusMi"] == "100.0"
    assert seen["params"]["limit"] == "50"
    assert seen["params"]["offset"] == "0"


@pytest.mark.asyncio
async def test_search_without_location_is_a_client_error(monkeypatch):
    def handler(_: httpx.Request) -> httpx.Response:  # pragma: no cover - not reached
        raise AssertionError("upstream must not be called")

    with pytest.raises(ads.AdvisorDirectoryError) as excinfo:
        await _service(monkeypatch, handler).search()

    assert excinfo.value.status_code == 400


@pytest.mark.asyncio
async def test_upstream_auth_failure_never_surfaces_as_a_caller_auth_error(monkeypatch):
    """A 401 means our key is wrong — the caller must not be told to re-auth."""

    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"ok": False, "error": "bad key"})

    with pytest.raises(ads.AdvisorDirectoryError) as excinfo:
        await _service(monkeypatch, handler).search(lat=1.0, lng=1.0)

    assert excinfo.value.status_code == 502
    assert "bad key" not in str(excinfo.value)


@pytest.mark.asyncio
async def test_mid_stream_error_frame_fails_the_request(monkeypatch):
    """Errors arrive as a frame on an HTTP 200 — status alone is not enough."""

    stream = _ndjson(
        {"type": "meta", "returned": 0},
        {"type": "error", "error": "upstream exploded"},
    )

    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=stream)

    with pytest.raises(ads.AdvisorDirectoryError) as excinfo:
        await _service(monkeypatch, handler).search(lat=1.0, lng=1.0)

    assert excinfo.value.status_code == 502


@pytest.mark.asyncio
async def test_upstream_rate_limit_is_passed_through(monkeypatch):
    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(429)

    with pytest.raises(ads.AdvisorDirectoryError) as excinfo:
        await _service(monkeypatch, handler).search(lat=1.0, lng=1.0)

    assert excinfo.value.status_code == 429


@pytest.mark.asyncio
async def test_unconfigured_backend_reports_unavailable(monkeypatch):
    monkeypatch.delenv("ADVISORS_API_BASE_URL", raising=False)
    monkeypatch.delenv("ADVISORS_API_BASE", raising=False)
    monkeypatch.delenv("ADVISORS_API_KEY", raising=False)

    assert ads.is_configured() is False
    with pytest.raises(ads.AdvisorDirectoryError) as excinfo:
        await ads.AdvisorDirectoryService().search(lat=1.0, lng=1.0)

    assert excinfo.value.status_code == 503


@pytest.mark.asyncio
async def test_profile_reads_the_standalone_endpoint_envelope(monkeypatch):
    """The live endpoint wraps the record in {ok, profile, firm, attribution}.

    Reading the payload as if it were flat produced an all-null profile, which
    only showed up against the real service — so this pins the real envelope.
    """

    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "ok": True,
                "profile": {
                    "crd": "862222",
                    "name": "CHRISTINE NOELLE COTE",
                    "yearsExperience": 47.5,
                    "firmCount": 7,
                    "hasDisclosures": True,
                    "disclosures": [{"type": "Regulatory"}],
                },
                "firm": {"firmId": "149777", "firmName": "MORGAN STANLEY"},
                "attribution": {"source": "FINRA BrokerCheck"},
            },
        )

    profile = (await _service(monkeypatch, handler).profile("862222"))["profile"]

    assert profile["crd"] == "862222"
    assert profile["name"] == "CHRISTINE NOELLE COTE"
    assert profile["firmName"] == "MORGAN STANLEY"
    assert profile["yearsExperience"] == 47.5
    assert profile["disclosureCount"] == 1


@pytest.mark.asyncio
async def test_profile_normalizes_current_firm_and_counts(monkeypatch):
    """A stream `detail` frame carries the same record flat, with no firm block."""

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/advisors/862222"
        return httpx.Response(
            200,
            json={
                "crd": "862222",
                "name": "CHRISTINE NOELLE COTE",
                "yearsExperience": 47.5,
                "firmCount": 7,
                "firmHistory": [
                    {"firmName": "SMITH BARNEY", "current": False},
                    {"firmName": "MORGAN STANLEY", "current": True},
                ],
                "exams": [{"category": "Series 7"}],
                "registeredStates": [{"state": "Washington"}],
                "hasDisclosures": True,
                "disclosures": [{"type": "Regulatory"}, {"type": "Customer"}],
                "isBarred": False,
                "branches": [
                    {
                        "street1": "4000 Carillon Point",
                        "city": "Kirkland",
                        "state": "WA",
                        "zip": "98033",
                    }
                ],
                "reportUrl": "https://files.brokercheck.finra.org/individual/x.pdf",
            },
        )

    result = await _service(monkeypatch, handler).profile("862222")
    profile = result["profile"]

    assert profile["firmName"] == "MORGAN STANLEY"
    assert profile["disclosureCount"] == 2
    assert profile["states"] == ["Washington"]
    assert profile["exams"] == ["Series 7"]
    assert profile["office"]["city"] == "Kirkland"


@pytest.mark.asyncio
async def test_profile_rejects_a_non_numeric_crd(monkeypatch):
    def handler(_: httpx.Request) -> httpx.Response:  # pragma: no cover - not reached
        raise AssertionError("upstream must not be called")

    with pytest.raises(ads.AdvisorDirectoryError) as excinfo:
        await _service(monkeypatch, handler).profile("../../etc/passwd")

    assert excinfo.value.status_code == 400
