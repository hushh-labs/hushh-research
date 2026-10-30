"""Contract tests for the NWS v4 net-worth client.

Every fixture below is invented. The live roster is a small set of named
individuals with sworn financial declarations attached, and copying real people
and real amounts into a repository to make a test read well would republish
their finances somewhere they never agreed to be. The shapes are what matter,
and a synthetic profile exercises them identically.
"""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from hushh_mcp.services import nws_networth_service
from hushh_mcp.services.nws_networth_service import NwsNetWorthError, NwsNetWorthService

_DISCOVER = "/v4/net-worth/discover"
_CONSENT = "/v4/location-consent/receipt"


@pytest.fixture(autouse=True)
def _reset_cache():
    nws_networth_service.reset_cache()
    yield
    nws_networth_service.reset_cache()


def _configure(monkeypatch, **overrides: str) -> None:
    values = {
        "NWS_NEARBY_V4_API_BASE_URL": "https://nws.example",
        "NWS_NEARBY_V4_API_KEY": "nws_test_key_value_not_real",
        "NWS_NEARBY_V4_PROJECT_ID": "hushh-pda-uat",
        "NWS_NEARBY_V4_ACTOR_HMAC_KEY": "unit-test-actor-key",
    }
    values.update(overrides)
    for name, value in values.items():
        if value:
            monkeypatch.setenv(name, value)
        else:
            monkeypatch.delenv(name, raising=False)


def _covered_empty() -> dict[str, Any]:
    """The common live answer: a resolved location with nobody publishable in it."""
    return {
        "contract_version": "nws-nearby-net-worth-v4-preview-1",
        "coverage_contract": "BEST_EFFORT_VERIFIED_PUBLIC_FINANCIAL_PROFILES",
        "data_tier": "PUBLIC_SAFE",
        "query": {
            "label": "US ZCTA 10001 query area",
            "mode": "POSTAL_CODE",
            "postal_code": "10001",
            "country_code": "US",
            "approximate": True,
        },
        "coverage": {
            "status": "COVERED",
            "reason_code": "APPROVED_NATIONAL_INDEX",
            "market_label": "United States national public-association index",
            "country_code": "US",
        },
        "snapshot": {
            "model_version": "net-worth-v1.0.0",
            "scale_version": "nws-fixed-us-log-v1.0.0",
            "as_of": "2026-08-14",
            "upstream_complete": False,
        },
        "financial_coverage": {
            "upstream_status": "FINANCIAL_COVERAGE_INSUFFICIENT",
            "discovered_count": 1100,
            "evaluated_count": 1100,
            "upstream_scored_count": 0,
            "v4_eligible_count": 0,
        },
        "result_set": {
            "requested_count": 100,
            "upstream_result_count": 0,
            "eligible_count": 0,
            "returned_count": 0,
            "shortfall_count": 100,
            "target_satisfied": False,
            "reasons": ["FINANCIAL_COVERAGE_INSUFFICIENT"],
        },
        "generated_at": "2026-08-14T12:00:00Z",
        "disclosures": ["FINANCIAL_COVERAGE_NOT_NATIONWIDE"],
        "results": [],
    }


def _covered_populated() -> dict[str, Any]:
    payload = _covered_empty()
    payload["financial_coverage"].update(
        {"upstream_status": "PARTIAL", "upstream_scored_count": 1, "v4_eligible_count": 1}
    )
    payload["result_set"].update(
        {
            "upstream_result_count": 1,
            "eligible_count": 1,
            "returned_count": 1,
            "shortfall_count": 99,
        }
    )
    payload["results"] = [
        {
            "rank": 1,
            "person": {
                "id": "synthetic-profile-1",
                "name": "Example Officeholder",
                "headline": "Public official",
                "organization": "Example County",
            },
            "estimated_net_worth": {
                "status": "AVAILABLE",
                "currency": "USD",
                "p10_usd": 1_200_000,
                "median_usd": 1_500_000,
                "p90_usd": 1_800_000,
                "method": "DECLARED_TOTAL_SIMULATION",
                "as_of": "2026-08-14",
            },
            "observed_net_worth_floor": {
                "status": "AVAILABLE",
                "amount_usd": 1_200_000,
                "method": "DIRECT_DECLARED_TOTAL_P10",
                "supporting_asset_families": [],
            },
            "nws": {"value": 61.2, "scale_version": "nws-fixed-us-log-v1.0.0"},
            "confidence": {"score": 0.784, "grade": "B", "coverage": 1.0},
            "location_relationship": {
                "label": "Public service jurisdiction",
                "association_kind": "PUBLIC_SERVICE_JURISDICTION",
                "granularity": "COUNTY",
                "approximate_distance_band": "Within 10 miles",
            },
            "last_financial_update": "2026-08-14",
            "why_ranked": ["Sworn public declaration"],
            "source_families": ["disclosure.example.gov"],
        }
    ]
    return payload


def _receipt() -> dict[str, Any]:
    return {
        "receipt_id": "nwc1.c3ludGhldGljLXBheWxvYWQ.c3ludGhldGljLXNpZw",
        "purpose_id": "NET_WORTH_LOOKUP",
        "audit_actor": "ria-0123456789abcdef0123456789abcdef",
        "scope": "APPROXIMATE_LOCATION_QUERY",
        "issued_at": "2026-08-14T12:00:00+00:00",
        "expires_at": "2026-08-14T12:15:00+00:00",
    }


def _transport(handler):
    return httpx.MockTransport(handler)


# --------------------------------------------------------------- request shape


@pytest.mark.asyncio
async def test_postal_request_matches_the_upstream_contract(monkeypatch):
    _configure(monkeypatch)
    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["path"] = request.url.path
        seen["body"] = json.loads(request.content)
        seen["key"] = request.headers.get("X-NWS-API-Key")
        return httpx.Response(200, json=_covered_empty())

    await NwsNetWorthService(transport=_transport(handler)).discover(
        firebase_uid="uid-1", postal_code="10001"
    )

    assert seen["path"] == _DISCOVER
    body = seen["body"]
    assert body["query"] == {"postal_code": "10001", "country_code": "US"}
    assert body["selection"]["count"] == 100
    assert body["selection"]["financial_mode"] == "estimated"
    # strict-radius forwards its full radius into a legacy field capped well
    # below the documented maximum, so the upstream faults with a 500 instead of
    # rejecting the request. It must never be sent.
    assert body["selection"]["geography_mode"] == "nearest-count"
    assert body["selection"]["maximum_radius_miles"] == pytest.approx(62.137119)
    # Any non-empty asset family silently excludes every reviewed profile,
    # because their components publish as INCLUDED_IN_DECLARED_TOTAL and the
    # filter accepts only SUPPORTED / MODELED_RANGE. The answer stays a
    # cheerful 200 with nothing in it.
    assert body["filters"]["asset_families"] == []
    caller = body["caller_context"]
    assert caller["project_id"] == "hushh-pda-uat"
    assert caller["purpose_id"] == "NET_WORTH_LOOKUP"
    assert caller["authorization_scope"] == "PUBLIC_SAFE"
    assert caller["requested_data_tier"] == "PUBLIC_SAFE"
    # Compared against the live snapshot after authentication, so a drift here
    # surfaces as a coverage error rather than a configuration one.
    assert caller["model_version"] == "net-worth-v1.0.0"
    # A postal query that attaches a receipt is rejected outright.
    assert "coordinate_consent" not in body


@pytest.mark.asyncio
async def test_postal_query_never_mints_a_consent_receipt(monkeypatch):
    _configure(monkeypatch)
    paths: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        paths.append(request.url.path)
        return httpx.Response(200, json=_covered_empty())

    await NwsNetWorthService(transport=_transport(handler)).discover(
        firebase_uid="uid-1", postal_code="10001"
    )

    assert paths == [_DISCOVER]


# ------------------------------------------------------------------- coverage


@pytest.mark.asyncio
async def test_covered_but_empty_is_a_normal_answer_with_the_counts_kept_apart(monkeypatch):
    """The dominant live case, and the one most easily rendered as a bug.

    A resolved location reports a large discovery count and no publishable
    estimates. Those two numbers describe different planes and are never joined,
    so they must not arrive under names a screen could confuse.
    """
    _configure(monkeypatch)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=_covered_empty())

    result = await NwsNetWorthService(transport=_transport(handler)).discover(
        firebase_uid="uid-1", postal_code="10001"
    )

    assert result["coverage"]["status"] == "COVERED"
    assert result["counts"]["discoveredCount"] == 1100
    assert result["counts"]["eligibleCount"] == 0
    assert result["counts"]["returnedCount"] == 0
    assert result["results"] == []
    # The smallest count the upstream accepts is 100 while the reviewed roster
    # is far smaller, so every successful call reports a large shortfall and an
    # unsatisfied target. Neither is forwarded: both would read as a failure.
    assert "shortfall" not in json.dumps(result)
    assert "targetSatisfied" not in result


@pytest.mark.asyncio
async def test_a_populated_answer_carries_the_estimate_range(monkeypatch):
    _configure(monkeypatch)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=_covered_populated())

    result = await NwsNetWorthService(transport=_transport(handler)).discover(
        firebase_uid="uid-1", postal_code="33870"
    )

    assert result["counts"]["eligibleCount"] == 1
    row = result["results"][0]
    assert row["displayName"] == "Example Officeholder"
    assert row["estimate"]["medianUsd"] == 1_500_000
    assert row["estimate"]["p10Usd"] == 1_200_000
    assert row["estimate"]["p90Usd"] == 1_800_000
    assert row["sourceFamilies"] == ["disclosure.example.gov"]


@pytest.mark.asyncio
async def test_a_zero_estimate_is_a_real_value_not_a_missing_one(monkeypatch):
    """A declared total can legitimately be zero, and must survive as zero.

    The upstream deliberately applies no minimum amount, so a filer who declared
    nothing is published with nothing. Treating that as absent would blank a row
    that is factually correct.
    """
    _configure(monkeypatch)
    payload = _covered_populated()
    payload["results"][0]["estimated_net_worth"].update(
        {"p10_usd": 0, "median_usd": 0, "p90_usd": 0}
    )
    payload["results"][0]["observed_net_worth_floor"]["amount_usd"] = -5_000

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=payload)

    result = await NwsNetWorthService(transport=_transport(handler)).discover(
        firebase_uid="uid-1", postal_code="33130"
    )

    row = result["results"][0]
    assert row["estimate"]["medianUsd"] == 0
    # Supported assets minus supported liabilities, with no floor at zero.
    assert row["observedFloor"]["amountUsd"] == -5_000


# -------------------------------------------------------------------- consent


@pytest.mark.asyncio
async def test_coordinate_query_mints_a_receipt_and_echoes_it_unchanged(monkeypatch):
    """The signature covers the encoded receipt, so it must round-trip verbatim.

    Re-serialising the timestamps or re-encoding the token breaks both the HMAC
    and the replay digest, and every one of those failures returns the same
    opaque rejection.
    """
    _configure(monkeypatch)
    calls: list[tuple[str, dict[str, Any]]] = []
    receipt = _receipt()

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        calls.append((request.url.path, body))
        if request.url.path == _CONSENT:
            return httpx.Response(200, json=receipt)
        return httpx.Response(200, json=_covered_empty())

    await NwsNetWorthService(transport=_transport(handler)).discover(
        firebase_uid="uid-1", latitude=27.4991, longitude=-81.4409
    )

    assert [path for path, _ in calls] == [_CONSENT, _DISCOVER]
    mint_body = calls[0][1]
    assert mint_body["scope"] == "APPROXIMATE_LOCATION_QUERY"
    assert mint_body["consent_granted"] is True
    # The mint call learns nothing about where the advisor is.
    assert "latitude" not in json.dumps(mint_body)
    assert "longitude" not in json.dumps(mint_body)

    discover_body = calls[1][1]
    assert discover_body["coordinate_consent"] == receipt
    # The upstream coarsens to two decimals itself; doing it here means the
    # precise coordinate never leaves this process either.
    assert discover_body["query"]["latitude"] == 27.5
    assert discover_body["query"]["longitude"] == -81.44
    # The receipt binds to the same actor the caller context declares.
    assert mint_body["audit_actor"] == discover_body["caller_context"]["audit_actor"]


@pytest.mark.asyncio
async def test_a_coordinate_answer_is_never_cached(monkeypatch):
    """A receipt is single-use and issued for one advisor.

    Serving a second advisor from a cached coordinate answer would hand them a
    result produced under consent they never gave.
    """
    _configure(monkeypatch)
    discover_calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal discover_calls
        if request.url.path == _CONSENT:
            return httpx.Response(200, json=_receipt())
        discover_calls += 1
        return httpx.Response(200, json=_covered_empty())

    service = NwsNetWorthService(transport=_transport(handler))
    await service.discover(firebase_uid="uid-1", latitude=27.5, longitude=-81.44)
    await service.discover(firebase_uid="uid-2", latitude=27.5, longitude=-81.44)

    assert discover_calls == 2


@pytest.mark.asyncio
async def test_a_postal_answer_is_cached(monkeypatch):
    _configure(monkeypatch)
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(200, json=_covered_empty())

    service = NwsNetWorthService(transport=_transport(handler))
    await service.discover(firebase_uid="uid-1", postal_code="10001")
    await service.discover(firebase_uid="uid-2", postal_code="10001")

    assert calls == 1


# ---------------------------------------------------------------------- actor


@pytest.mark.asyncio
async def test_the_advisor_identifier_never_leaves_this_process(monkeypatch):
    _configure(monkeypatch)
    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["raw"] = request.content.decode()
        return httpx.Response(200, json=_covered_empty())

    await NwsNetWorthService(transport=_transport(handler)).discover(
        firebase_uid="firebase-uid-abcdef", postal_code="10001"
    )

    assert "firebase-uid-abcdef" not in seen["raw"]
    assert "ria-" in seen["raw"]


def test_the_actor_is_stable_per_advisor_and_distinct_between_them(monkeypatch):
    _configure(monkeypatch)
    first = nws_networth_service.audit_actor("uid-1")
    again = nws_networth_service.audit_actor("uid-1")
    other = nws_networth_service.audit_actor("uid-2")

    assert first == again
    assert first != other
    assert first.startswith("ria-")
    # Comfortably inside the upstream's 2..128 identifier bound.
    assert 2 <= len(first) <= 128


def test_a_missing_actor_key_is_a_configuration_fault_not_a_shared_constant(monkeypatch):
    _configure(monkeypatch, NWS_NEARBY_V4_ACTOR_HMAC_KEY="")
    with pytest.raises(NwsNetWorthError) as excinfo:
        nws_networth_service.audit_actor("uid-1")
    assert excinfo.value.status_code == 503


# ------------------------------------------------------------------ configure


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "missing",
    [
        "NWS_NEARBY_V4_API_BASE_URL",
        "NWS_NEARBY_V4_API_KEY",
        "NWS_NEARBY_V4_PROJECT_ID",
        "NWS_NEARBY_V4_ACTOR_HMAC_KEY",
    ],
)
async def test_an_incomplete_configuration_attempts_no_call(monkeypatch, missing):
    _configure(monkeypatch, **{missing: ""})
    called = False

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal called
        called = True
        return httpx.Response(200, json=_covered_empty())

    with pytest.raises(NwsNetWorthError) as excinfo:
        await NwsNetWorthService(transport=_transport(handler)).discover(
            firebase_uid="uid-1", postal_code="10001"
        )

    assert excinfo.value.status_code == 503
    assert not called


# ------------------------------------------------------------------- failures


@pytest.mark.asyncio
@pytest.mark.parametrize("status", [401, 403])
async def test_an_access_rejection_is_our_fault_and_never_reads_as_empty(monkeypatch, status):
    """A rejected credential must not degrade into "nobody here".

    An empty list is a truthful answer for most locations, so a configuration
    failure that rendered as one would be indistinguishable from success.
    """
    _configure(monkeypatch)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, json={"detail": {"code": "INVALID_CREDENTIALS"}})

    with pytest.raises(NwsNetWorthError) as excinfo:
        await NwsNetWorthService(transport=_transport(handler)).discover(
            firebase_uid="uid-1", postal_code="10001"
        )

    assert excinfo.value.status_code == 502
    assert excinfo.value.code == "RIA_NETWORTH_NOT_CONFIGURED"
    assert "nws_test_key_value_not_real" not in str(excinfo.value)


@pytest.mark.asyncio
async def test_a_schema_rejection_does_not_crash_the_error_handler(monkeypatch):
    """A 422 body is a list of errors, not an object carrying a code.

    Reading it as the policy envelope raises inside the handler, which is how a
    rejected request becomes an unhandled 500.
    """
    _configure(monkeypatch)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            422,
            json={
                "detail": [
                    {"type": "missing", "loc": ["body", "selection"], "msg": "Field required"}
                ]
            },
        )

    with pytest.raises(NwsNetWorthError) as excinfo:
        await NwsNetWorthService(transport=_transport(handler)).discover(
            firebase_uid="uid-1", postal_code="10001"
        )

    assert excinfo.value.status_code == 502


@pytest.mark.asyncio
async def test_a_snapshot_outage_is_its_own_state(monkeypatch):
    """A stale financial snapshot hard-fails rather than returning an empty list.

    It is temporary and not our fault, so it must not be reported as a
    configuration problem the advisor cannot retry past.
    """
    _configure(monkeypatch)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            503,
            json={"detail": {"code": "NET_WORTH_SNAPSHOT_UNAVAILABLE"}},
        )

    with pytest.raises(NwsNetWorthError) as excinfo:
        await NwsNetWorthService(transport=_transport(handler)).discover(
            firebase_uid="uid-1", postal_code="33870"
        )

    assert excinfo.value.status_code == 503
    assert excinfo.value.code == "RIA_NETWORTH_SOURCE_UNAVAILABLE"


@pytest.mark.asyncio
async def test_an_unsatisfiable_request_is_distinguishable_from_an_empty_one(monkeypatch):
    _configure(monkeypatch)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(409, json={"detail": {"code": "V4_REQUEST_CANNOT_BE_SATISFIED"}})

    with pytest.raises(NwsNetWorthError) as excinfo:
        await NwsNetWorthService(transport=_transport(handler)).discover(
            firebase_uid="uid-1", postal_code="33870"
        )

    assert excinfo.value.status_code == 409
    assert excinfo.value.code == "RIA_NETWORTH_COVERAGE_UNAVAILABLE"


@pytest.mark.asyncio
async def test_a_rate_limit_preserves_the_upstream_retry_hint(monkeypatch):
    _configure(monkeypatch)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(429, headers={"Retry-After": "30"}, json={"detail": {}})

    with pytest.raises(NwsNetWorthError) as excinfo:
        await NwsNetWorthService(transport=_transport(handler)).discover(
            firebase_uid="uid-1", postal_code="10001"
        )

    assert excinfo.value.status_code == 429
    assert excinfo.value.retry_after_seconds == 30


@pytest.mark.asyncio
async def test_a_transport_failure_does_not_leak_its_cause(monkeypatch):
    _configure(monkeypatch)

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("upstream detail")

    with pytest.raises(NwsNetWorthError) as excinfo:
        await NwsNetWorthService(transport=_transport(handler)).discover(
            firebase_uid="uid-1", postal_code="10001"
        )

    assert excinfo.value.status_code == 502
    assert "upstream detail" not in str(excinfo.value)


# ------------------------------------------------------------------ local gate


@pytest.mark.asyncio
async def test_surrounding_whitespace_is_canonicalised_rather_than_rejected(monkeypatch):
    """v4 does no trimming of its own, so a stray space is a hard rejection there.

    Trimming here turns a typo into a working search instead of an error, and
    sends the one canonical form the upstream accepts.
    """
    _configure(monkeypatch)
    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json=_covered_empty())

    await NwsNetWorthService(transport=_transport(handler)).discover(
        firebase_uid="uid-1", postal_code="  10001 "
    )

    assert seen["body"]["query"]["postal_code"] == "10001"


@pytest.mark.asyncio
@pytest.mark.parametrize("postal", ["1000", "SW1A 1AA", "abcde", "10001-12"])
async def test_a_location_the_upstream_would_reject_is_refused_here(monkeypatch, postal):
    """v4 accepts only a US ZIP, and no other country's postal format at all.

    Spending the product's shared per-minute grant to be told so upstream is
    waste, and a coordinate lookup spends it twice.
    """
    _configure(monkeypatch)
    called = False

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal called
        called = True
        return httpx.Response(200, json=_covered_empty())

    with pytest.raises(NwsNetWorthError) as excinfo:
        await NwsNetWorthService(transport=_transport(handler)).discover(
            firebase_uid="uid-1", postal_code=postal
        )

    assert excinfo.value.status_code == 400
    assert not called


@pytest.mark.asyncio
async def test_zip_plus_four_is_accepted(monkeypatch):
    _configure(monkeypatch)
    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json=_covered_empty())

    await NwsNetWorthService(transport=_transport(handler)).discover(
        firebase_uid="uid-1", postal_code="10001-1234"
    )

    assert seen["body"]["query"]["postal_code"] == "10001-1234"


@pytest.mark.asyncio
async def test_a_half_supplied_coordinate_is_refused_without_minting_consent(monkeypatch):
    _configure(monkeypatch)
    called = False

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal called
        called = True
        return httpx.Response(200, json=_receipt())

    with pytest.raises(NwsNetWorthError) as excinfo:
        await NwsNetWorthService(transport=_transport(handler)).discover(
            firebase_uid="uid-1", latitude=27.5
        )

    assert excinfo.value.status_code == 400
    assert not called


@pytest.mark.asyncio
async def test_an_unsupported_result_count_is_refused(monkeypatch):
    _configure(monkeypatch)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=_covered_empty())

    with pytest.raises(NwsNetWorthError) as excinfo:
        await NwsNetWorthService(transport=_transport(handler)).discover(
            firebase_uid="uid-1", postal_code="10001", count=25
        )

    assert excinfo.value.status_code == 400


# ---------------------------------------------------------------- degradation


@pytest.mark.asyncio
async def test_a_response_missing_a_block_still_renders(monkeypatch):
    """An older upstream revision must degrade, not fault."""
    _configure(monkeypatch)
    payload = _covered_empty()
    payload.pop("financial_coverage")
    payload.pop("snapshot")

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=payload)

    result = await NwsNetWorthService(transport=_transport(handler)).discover(
        firebase_uid="uid-1", postal_code="10001"
    )

    assert result["counts"]["discoveredCount"] == 0
    assert result["counts"]["eligibleCount"] == 0
    assert result["coverage"]["status"] == "COVERED"
