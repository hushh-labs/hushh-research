"""A source scan must detect rows discarded while shaping an activity page."""

from datetime import UTC, datetime

import pytest

from hushh_mcp.services import payout_activity_service as activity_module
from hushh_mcp.services.payout_activity_service import PayoutActivityService


@pytest.mark.asyncio
async def test_raw_page_count_exposes_a_skipped_final_row(monkeypatch):
    now = datetime(2026, 10, 14, tzinfo=UTC)
    row = {
        "kind": "deposit",
        "item_id": "deposit:po_bad!",
        "occurred_at": now,
        "updated_at": now,
        "coins_delta": None,
        "balance_after": None,
    }

    async def read(_self, operation):
        return operation(None)

    monkeypatch.setattr(PayoutActivityService, "_read", read)
    monkeypatch.setattr(
        activity_module,
        "_row",
        lambda _connection, _sql, _params: {
            "as_of": now,
            "wallet_id": None,
            "account_id": "acct_owner",
        },
    )
    monkeypatch.setattr(
        activity_module,
        "_rows",
        lambda _connection, _sql, _params: [row],
    )

    page = await PayoutActivityService(db=object()).activity(user_id="owner", mode="live")
    assert page["items"] == []
    assert page["nextCursor"] is None
    assert page["sourceItemCount"] == 1
