"""A follow-up review cannot execute an unrelated or superseded Calendar plan."""

import base64
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.services.calendar_email_followup_booking import (
    require_booking_request,
    seal_booking_review,
    verify_booking_review,
)
from hushh_mcp.services.calendar_email_followup_crypto import FollowupCipher, FollowupCryptoError
from hushh_mcp.services.calendar_email_followup_store import (
    CalendarEmailFollowupStore,
    FollowupStateError,
)


def fixture():
    store = CalendarEmailFollowupStore(
        db=object(), cipher=FollowupCipher(base64.urlsafe_b64encode(b"x" * 32).decode())
    )
    monitor = SimpleNamespace(
        user_id="owner", account_id="account-b", generation="generation", grant_epoch_digest="grant"
    )
    review = {
        "proposal_id": "proposal-b",
        "expires_at": (datetime.now(UTC) + timedelta(minutes=5)).isoformat(),
    }
    token = seal_booking_review(store, monitor, "request-b", 2, review)
    return store, monitor, token


def test_exact_review_is_accepted():
    store, monitor, token = fixture()
    verify_booking_review(store, monitor, "request-b", 2, "proposal-b", token)


@pytest.mark.parametrize(
    "field,value",
    [
        ("user_id", "other"),
        ("account_id", "account-c"),
        ("generation", "new"),
        ("grant_epoch_digest", "new"),
    ],
)
def test_other_owner_account_or_generation_cannot_use_review(field, value):
    store, monitor, token = fixture()
    setattr(monitor, field, value)
    with pytest.raises((FollowupCryptoError, FollowupStateError)):
        verify_booking_review(store, monitor, "request-b", 2, "proposal-b", token)


@pytest.mark.parametrize(
    "request_id,revision,proposal",
    [
        ("other", 2, "proposal-b"),
        ("request-b", 3, "proposal-b"),
        ("request-b", 2, "legacy-proposal"),
    ],
)
def test_review_cannot_be_repurposed(request_id, revision, proposal):
    store, monitor, token = fixture()
    with pytest.raises((FollowupCryptoError, FollowupStateError)):
        verify_booking_review(store, monitor, request_id, revision, proposal, token)


def test_expired_review_cannot_execute():
    store, monitor, _ = fixture()
    token = seal_booking_review(
        store,
        monitor,
        "request-b",
        2,
        {
            "proposal_id": "proposal-b",
            "expires_at": (datetime.now(UTC) - timedelta(seconds=1)).isoformat(),
        },
    )
    with pytest.raises(FollowupStateError):
        verify_booking_review(store, monitor, "request-b", 2, "proposal-b", token)


@pytest.mark.asyncio
async def test_request_recheck_refuses_changed_or_closed_followup():
    grant = SimpleNamespace(require_current=AsyncMock())
    store = SimpleNamespace(
        require_monitor_current=AsyncMock(),
        resolve_request=AsyncMock(return_value={"conversation_id": "thread"}),
        detail=AsyncMock(),
    )
    for row in (
        {"id": "request-b", "revision": 3, "state": "pending"},
        {"id": "request-b", "revision": 2, "state": "done"},
    ):
        store.detail.return_value = {"requests": [row]}
        with pytest.raises(FollowupStateError):
            await require_booking_request(store, object(), grant, "request-b", 2)
