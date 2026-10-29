"""One message whose receipt evidence doesn't verify no longer fails its page."""

from __future__ import annotations

from tests.services.test_gmail_receipt_live_service import (  # noqa: F401 - autouse lock fixture
    _message,
    _model_for,
    _scan,
    _service,
    receipt_owner_locks,
)


async def test_an_unverifiable_message_is_not_a_receipt_and_the_page_keeps_the_rest():
    # UAT, Oct 22-29: one such message failed every scan of its page (502), so
    # the owner's receipt sync never finished and chat had no receipts.
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

    async def extractor(payload: dict, _user: str, _token: str) -> dict:
        model = _model_for(payload)
        if "ODD-2" in payload["subject"]:
            # Well-formed, but its cited receipt evidence is not in this message.
            model["receipt_evidence_ids"] = ["receipt:not-in-this-message"]
        return model

    service = _service([good, odd])
    service._extractor = extractor
    result = await _scan(service)

    coverage = result["coverage"]
    assert result["returned_count"] == coverage["matched_count"] == 1
    assert coverage["rejection_counts"]["extractor_not_receipt"] == 1
    # The installed app's check: every candidate is a match or a counted rejection.
    assert sum(coverage["rejection_counts"].values()) + 1 == coverage["candidate_count"]
