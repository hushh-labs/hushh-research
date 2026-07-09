"""Unit tests for MarketplaceCenterContributor.

Hermetic: inject a fake request service exposing the async ``list_requests`` /
``list_buyer_requests`` reads so no DB is required. Locks in the status -> bucket
mapping the /consents tabs depend on and the frontend recognition contract
(``metadata.request_source``).
"""

from __future__ import annotations

import pytest

from hushh_mcp.services.marketplace_center_contributor import (
    MARKETPLACE_REQUEST_SOURCE,
    MarketplaceCenterContributor,
)


class _FakeRequestService:
    def __init__(self, owned: list[dict] | None = None, bought: list[dict] | None = None):
        self._owned = owned or []
        self._bought = bought or []

    async def list_requests(self, *, owner_user_id: str, status=None):  # noqa: ARG002
        return self._owned

    async def list_buyer_requests(self, *, buyer_user_id: str, status=None):  # noqa: ARG002
        return self._bought


def _contributor(**kwargs) -> MarketplaceCenterContributor:
    return MarketplaceCenterContributor(request_service=_FakeRequestService(**kwargs))


def _request(**overrides) -> dict:
    base = {
        "id": "req_1",
        "ownerUserId": "user_a",
        "buyerUserId": "user_b",
        "buyerLabel": "Acme Research",
        "domain": "travel",
        "scopeHandle": "attr.travel.trips.*",
        "sliceName": "Recent trips",
        "priceCents": 500,
        "currency": "USD",
        "status": "pending",
        "message": "please",
        "createdAt": "2030-01-01T00:00:00Z",
    }
    base.update(overrides)
    return base


@pytest.mark.asyncio
async def test_pending_owned_request_maps_to_incoming():
    buckets = await _contributor(owned=[_request()]).collect("user_a")
    assert len(buckets["incoming_requests"]) == 1
    entry = buckets["incoming_requests"][0]
    assert entry["id"] == "marketplace_request:req_1"
    assert entry["kind"] == "incoming_request"
    assert entry["status"] == "pending"
    assert entry["action"] == "REQUESTED"
    assert entry["reason"] == "please"
    assert entry["counterpart_label"] == "Acme Research"
    assert entry["scope_description"] == "Recent trips"
    md = entry["metadata"]
    assert md["request_source"] == MARKETPLACE_REQUEST_SOURCE
    assert md["role"] == "owner"
    assert md["domain"] == "travel"
    assert md["scope_handle"] == "attr.travel.trips.*"
    assert md["price_cents"] == 500


@pytest.mark.asyncio
async def test_approved_owned_request_maps_to_active():
    buckets = await _contributor(owned=[_request(status="approved")]).collect("user_a")
    assert [e["kind"] for e in buckets["active_grants"]] == ["active_grant"]
    assert buckets["active_grants"][0]["action"] == "CONSENT_GRANTED"
    assert buckets["incoming_requests"] == []


@pytest.mark.asyncio
async def test_denied_and_expired_owned_requests_map_to_history():
    buckets = await _contributor(
        owned=[_request(id="d", status="denied"), _request(id="e", status="expired")]
    ).collect("user_a")
    assert {e["id"] for e in buckets["history"]} == {
        "marketplace_request:d",
        "marketplace_request:e",
    }
    assert buckets["active_grants"] == []


@pytest.mark.asyncio
async def test_buyer_pending_request_maps_to_outgoing_anonymized():
    buckets = await _contributor(bought=[_request(status="pending")]).collect("user_b")
    assert len(buckets["outgoing_requests"]) == 1
    entry = buckets["outgoing_requests"][0]
    assert entry["kind"] == "outgoing_request"
    # Buyer directory is anonymized: the owner's identity is never surfaced.
    assert entry["counterpart_label"] == "Data owner"
    assert entry["counterpart_id"] is None
    assert entry["metadata"]["role"] == "buyer"


@pytest.mark.asyncio
async def test_buyer_resolved_request_maps_to_history():
    buckets = await _contributor(bought=[_request(status="approved")]).collect("user_b")
    assert [e["kind"] for e in buckets["history"]] == ["history"]
    assert buckets["outgoing_requests"] == []


@pytest.mark.asyncio
async def test_counts_reflect_buckets():
    counts = await _contributor(
        owned=[
            _request(id="p", status="pending"),
            _request(id="a", status="approved"),
            _request(id="d", status="denied"),
        ]
    ).counts("user_a")
    assert counts == {"pending": 1, "active": 1, "previous": 1}


@pytest.mark.asyncio
async def test_collect_is_safe_when_service_raises():
    class _Boom:
        async def list_requests(self, *, owner_user_id, status=None):  # noqa: ARG002
            raise RuntimeError("db down")

        async def list_buyer_requests(self, *, buyer_user_id, status=None):  # noqa: ARG002
            raise RuntimeError("db down")

    buckets = await MarketplaceCenterContributor(request_service=_Boom()).collect("user_a")
    assert buckets == {
        "incoming_requests": [],
        "outgoing_requests": [],
        "active_grants": [],
        "history": [],
        "invites": [],
    }


@pytest.mark.asyncio
async def test_empty_user_returns_empty_buckets():
    buckets = await _contributor(owned=[_request()]).collect("")
    assert buckets["incoming_requests"] == []
