"""Calendar-only confirmation cannot consume Mail review authority."""

from __future__ import annotations

import asyncio

import pytest

from hushh_mcp.services.google_connection_service import GoogleConnectionError
from tests.services.test_calendar_attendance_service import _review, _service


def test_calendar_only_confirmation_cannot_consume_a_mail_review(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service, calendar, _, mail = _service(monkeypatch)
    review = asyncio.run(
        service.review(
            user_id="owner",
            event_id="event/id",
            response_status="declined",
            send_message=True,
            message="I cannot attend.",
            time_zone="UTC",
        )
    )

    with pytest.raises(GoogleConnectionError):
        asyncio.run(
            service.confirm_rsvp(
                user_id="owner",
                review_id=review["review_id"],
                review_token=review["review_token"],
            )
        )

    assert not any(request.get("method") == "PATCH" for request in calendar.requests)
    assert mail.sends == []


def test_calendar_only_confirmation_binds_account_and_claims_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service, calendar, _, mail = _service(monkeypatch)
    review = _review(service)
    calendar.connections.account_id = "different-account"
    with pytest.raises(GoogleConnectionError):
        asyncio.run(
            service.confirm_rsvp(
                user_id="owner",
                review_id=review["review_id"],
                review_token=review["review_token"],
            )
        )
    calendar.connections.account_id = "default"

    result = asyncio.run(
        service.confirm_rsvp(
            user_id="owner",
            review_id=review["review_id"],
            review_token=review["review_token"],
        )
    )
    assert result["calendar"] == "declined"
    assert result["email"] == "not_sent"
    assert len([request for request in calendar.requests if request.get("method") == "PATCH"]) == 1
    assert mail.sends == []
