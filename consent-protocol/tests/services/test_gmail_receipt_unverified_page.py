"""One message whose receipt evidence doesn't verify no longer fails its page."""

from __future__ import annotations

import pytest

from hushh_mcp.services import gmail_live_receipts_service as live_receipts_module
from tests.services.test_gmail_receipt_live_service import (  # noqa: F401 - autouse lock fixture
    _message,
    _model_for,
    _scan,
    _service,
    receipt_owner_locks,
)


@pytest.mark.parametrize("verifies_on_retry", [False, True])
async def test_an_unverifiable_message_is_asked_once_more_then_counted_not_failing_the_page(
    monkeypatch, verifies_on_retry
):
    # UAT, Oct 22-29: one such message failed every scan of its page (502), so
    # the owner's receipt sync never finished and chat had no receipts.
    monkeypatch.setattr(live_receipts_module, "_EXTRACTOR_RETRY_DELAY_SECONDS", 0)
    good = _message(
        "msg-good",
        subject="Receipt for order #GOOD-1",
        sender="Apple <orders@apple.com>",
        body="Order total: USD 10.00",
    )
    odd = _message(
        "msg-odd",
        subject="Your receipt for order #ODD-2",
        sender="Apple <orders@apple.com>",
        body="Order total: USD 12.00",
    )
    asked: list[str] = []

    async def extractor(payload: dict, _user: str, _token: str) -> dict:
        model = _model_for(payload)
        if "ODD-2" in payload["subject"]:
            asked.append("odd")
            if not (verifies_on_retry and len(asked) > 1):
                # Well-formed, but its cited receipt evidence is not in this message.
                model["receipt_evidence_ids"] = ["receipt:not-in-this-message"]
        return model

    service = _service([good, odd])
    service._extractor = extractor
    result = await _scan(service)

    coverage = result["coverage"]
    assert asked == ["odd", "odd"]  # Asked once more, never more.
    assert result["returned_count"] == coverage["matched_count"] == (2 if verifies_on_retry else 1)
    assert coverage["rejection_counts"]["extractor_not_receipt"] == (0 if verifies_on_retry else 1)
    # The installed app's check: every candidate is a match or a counted rejection.
    assert (
        sum(coverage["rejection_counts"].values()) + coverage["matched_count"]
        == coverage["candidate_count"]
    )
