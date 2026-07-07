"""Tests for the earnings summary's real-demand accrual + payout honesty.

`earnings_summary` folds the durable access-request inbox (migration 076) into
its response so it reports genuine buyer demand — but it must NEVER imply money.
These tests fake both collaborators (a PKM that has published nothing and a
request service returning a fixed mix) so the demand math and the core honesty
guarantee are covered without a database.
"""

from __future__ import annotations

from typing import Any

from hushh_mcp.services.marketplace_information_service import MarketplaceInformationService


class _FakePkm:
    """No published slices — earnings then depends only on buyer demand."""

    async def get_index_v2(self, _user_id: str):
        return None


class _FakeRequestService:
    def __init__(self, requests: list[dict[str, Any]], *, raise_on_list: bool = False):
        self._requests = requests
        self._raise = raise_on_list

    async def list_requests(self, *, owner_user_id: str, status: str | None = None):
        if self._raise:
            raise RuntimeError("inbox unavailable")
        return self._requests


def _service(requests, *, raise_on_list=False) -> MarketplaceInformationService:
    return MarketplaceInformationService(
        pkm_service=_FakePkm(),
        request_service=_FakeRequestService(requests, raise_on_list=raise_on_list),
    )


def _req(status: str, *, buyer_id=None, label=None, req_id="r"):
    return {"id": req_id, "status": status, "buyerUserId": buyer_id, "buyerLabel": label}


async def test_earnings_reports_real_buyer_demand():
    requests = [
        _req("pending", buyer_id="b1", req_id="r1"),
        _req("pending", buyer_id="b1", req_id="r2"),  # same buyer, still 2 requests
        _req("approved", buyer_id="b2", req_id="r3"),
        _req("denied", buyer_id="b3", req_id="r4"),  # denied is neither pending nor approved
    ]
    summary = await _service(requests).earnings_summary(user_id="owner")

    assert summary["pendingRequestCount"] == 2
    assert summary["approvedBuyerCount"] == 1
    # distinct buyers across pending+approved: b1 (x2 → 1) + b2 = 2
    assert summary["interestedBuyerCount"] == 2
    assert summary["hasBuyers"] is True


async def test_has_buyers_is_false_without_an_approved_request():
    # Pending interest alone is demand, not an approved buyer.
    summary = await _service([_req("pending", buyer_id="b1", req_id="r1")]).earnings_summary(
        user_id="owner"
    )
    assert summary["pendingRequestCount"] == 1
    assert summary["approvedBuyerCount"] == 0
    assert summary["hasBuyers"] is False


async def test_payouts_disabled_and_nothing_accrued_always():
    # The core honesty guarantee: even with an approved buyer, no money exists.
    summary = await _service([_req("approved", buyer_id="b2", req_id="r3")]).earnings_summary(
        user_id="owner"
    )
    assert summary["accruedCents"] == 0
    assert summary["payoutsEnabled"] is False
    assert summary["hasPaymentRail"] is False
    assert "coming soon" in summary["note"].lower()


async def test_anonymous_requests_each_count_as_a_distinct_buyer():
    # No buyerUserId and no label → fall back to request id so they don't collapse.
    requests = [
        _req("pending", req_id="r1"),
        _req("pending", req_id="r2"),
    ]
    summary = await _service(requests).earnings_summary(user_id="owner")
    assert summary["interestedBuyerCount"] == 2


async def test_no_demand_summary_is_honest():
    summary = await _service([]).earnings_summary(user_id="owner")
    assert summary["pendingRequestCount"] == 0
    assert summary["approvedBuyerCount"] == 0
    assert summary["interestedBuyerCount"] == 0
    assert summary["hasBuyers"] is False
    assert summary["payoutsEnabled"] is False
    assert "coming soon" in summary["note"].lower()


async def test_inbox_failure_degrades_to_zero_demand():
    # A broken inbox must not break the earnings summary — demand degrades to zero.
    summary = await _service([], raise_on_list=True).earnings_summary(user_id="owner")
    assert summary["pendingRequestCount"] == 0
    assert summary["approvedBuyerCount"] == 0
    assert summary["hasBuyers"] is False
    assert summary["accruedCents"] == 0
    assert summary["payoutsEnabled"] is False
