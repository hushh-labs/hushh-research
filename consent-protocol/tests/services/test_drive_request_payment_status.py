"""Legacy unpaid payment-state projection after terminal no-match outcomes."""

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import uuid4

import pytest

from hushh_mcp.services.drive_request_payment_store import DriveRequestPaymentStore
from hushh_mcp.services.drive_sharing_store import DriveSharingStore


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "order",
    [
        None,
        {
            "status": "awaiting_payment",
            "amount_cents": 1000,
            "currency": "usd",
            "reconciliation_required": False,
        },
    ],
)
async def test_no_match_request_closes_unpaid_payment_state(order, monkeypatch):
    request = {
        "request_id": str(uuid4()),
        "user_id": "owner",
        "recipient_user_id": "recipient",
        "payment_required": True,
        "status": "no_match",
        "expires_at": datetime.now(UTC) + timedelta(hours=1),
    }
    store = DriveRequestPaymentStore(db=object())
    monkeypatch.setattr(DriveSharingStore, "_open_request", lambda self, row: {})
    store._row = Mock(side_effect=[request, order])

    async def transaction(operation):
        return operation(SimpleNamespace())

    store._transaction = transaction
    state = await store.payment_state(
        requester_user_id="recipient", request_id=request["request_id"]
    )
    assert state["status"] == "expired"
    assert store._row.call_count == 2
