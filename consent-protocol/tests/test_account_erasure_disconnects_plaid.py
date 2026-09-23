"""Erasing a person disconnects their banks at Plaid first.

Deleting only our rows left every Plaid connection live, with access nobody
could use or revoke. The disconnect is best effort per item and never blocks
the erasure itself."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from hushh_mcp.services.account_service import AccountService
from hushh_mcp.services.plaid_portfolio_service import PlaidPortfolioService


def _portfolio_service(rows):
    service = PlaidPortfolioService.__new__(PlaidPortfolioService)
    service._db = MagicMock()
    service._db.execute_raw.return_value = SimpleNamespace(data=rows)
    service._decrypt_access_token = MagicMock(side_effect=lambda row: f"tok-{row['n']}")
    return service


def test_every_live_item_is_removed_and_one_failure_does_not_stop_the_rest():
    service = _portfolio_service([{"n": 1, "plaid_env": "sandbox"}, {"n": 2}, {"n": 3}])
    calls = []

    async def post(path, payload, environment=None):
        calls.append((path, payload["access_token"]))
        if payload["access_token"] == "tok-2":
            raise RuntimeError("plaid unavailable")
        return {}

    service._post = post
    counts = asyncio.run(service.disconnect_all_items_for_erasure(user_id="owner"))
    assert counts == {"attempted": 3, "removed": 2, "failed": 1}
    assert [path for path, _ in calls] == ["/item/remove"] * 3
    sql = service._db.execute_raw.call_args.args[0]
    assert "status" in sql and "'removed'" in sql


def test_no_connections_means_nothing_is_called():
    service = _portfolio_service([])
    service._post = AsyncMock()
    counts = asyncio.run(service.disconnect_all_items_for_erasure(user_id="owner"))
    assert counts == {"attempted": 0, "removed": 0, "failed": 0}
    service._post.assert_not_awaited()


def test_account_erasure_records_the_outcome_and_never_raises():
    account = AccountService.__new__(AccountService)
    results: dict = {}
    with (
        patch(
            "hushh_mcp.services.plaid_portfolio_service.PlaidPortfolioService",
            side_effect=RuntimeError("no plaid config"),
        ),
        patch("hushh_mcp.services.broker_funding_service.BrokerFundingService") as funding,
    ):
        funding.return_value.disconnect_all_funding_items_for_erasure = AsyncMock(
            return_value={"attempted": 0, "removed": 0, "failed": 0}
        )
        asyncio.run(account._disconnect_plaid_before_erasure("owner", results))
    assert results["plaid_disconnected_at_plaid"] is False

    results = {}
    with (
        patch("hushh_mcp.services.plaid_portfolio_service.PlaidPortfolioService") as portfolio,
        patch("hushh_mcp.services.broker_funding_service.BrokerFundingService") as funding,
    ):
        portfolio.return_value.disconnect_all_items_for_erasure = AsyncMock(
            return_value={"attempted": 2, "removed": 2, "failed": 0}
        )
        funding.return_value.disconnect_all_funding_items_for_erasure = AsyncMock(
            return_value={"attempted": 1, "removed": 1, "failed": 0}
        )
        asyncio.run(account._disconnect_plaid_before_erasure("owner", results))
    assert results["plaid_disconnected_at_plaid"] is True
