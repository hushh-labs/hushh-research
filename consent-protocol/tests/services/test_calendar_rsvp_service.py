"""Calendar-only confirmation cannot consume Mail review authority."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta

import pytest

from hushh_mcp.services.google_connection_service import GoogleConnectionError
from tests.services.test_calendar_attendance_service import _service


def _review(service, *, review_kind="rsvp"):
    return asyncio.run(
        service.review(
            user_id="owner",
            event_id="event/id",
            response_status="declined",
            time_zone="UTC",
            review_kind=review_kind,
        )
    )


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


@pytest.mark.parametrize(
    ("source", "destination"),
    [
        ("workspace", "rsvp"),
        ("legacy_owner", "rsvp"),
        ("rsvp", "workspace"),
        ("legacy_owner", "workspace"),
        ("workspace", "legacy_owner"),
        ("rsvp", "legacy_owner"),
    ],
)
def test_attendance_review_cannot_cross_authority_routes(
    monkeypatch: pytest.MonkeyPatch, source: str, destination: str
) -> None:
    service, calendar, db, mail = _service(monkeypatch)
    review = _review(service, review_kind=source)
    with pytest.raises(GoogleConnectionError) as caught:
        if destination == "rsvp":
            asyncio.run(
                service.confirm_rsvp(
                    user_id="owner",
                    review_id=review["review_id"],
                    review_token=review["review_token"],
                )
            )
        else:
            asyncio.run(
                service.confirm(
                    user_id="owner",
                    review_id=review["review_id"],
                    review_token=review["review_token"],
                    review_kind=destination,
                )
            )
    assert caught.value.status_code == 403
    assert db.rows[review["review_id"]]["state"] == "prepared"
    assert not any(request.get("method") == "PATCH" for request in calendar.requests)
    assert mail.sends == []


@pytest.mark.parametrize("review_kind", ["rsvp", "workspace"])
def test_direct_calendar_review_rejects_replay_and_changed_grant(
    monkeypatch: pytest.MonkeyPatch, review_kind: str
) -> None:
    service, calendar, _, mail = _service(monkeypatch)
    review = _review(service, review_kind=review_kind)
    confirm = service.confirm_rsvp if review_kind == "rsvp" else service.confirm
    kwargs = {
        "user_id": "owner",
        "review_id": review["review_id"],
        "review_token": review["review_token"],
    }
    if review_kind == "workspace":
        kwargs["review_kind"] = "workspace"
    result = asyncio.run(confirm(**kwargs))
    assert result["calendar"] == "declined"
    with pytest.raises(GoogleConnectionError) as caught:
        asyncio.run(confirm(**kwargs))
    assert caught.value.status_code == 409
    assert caught.value.reason_code == "calendar_confirmation_replayed"
    calendar.connections.binding = ("owner", "calendar", "revoked-grant")
    with pytest.raises(GoogleConnectionError) as revoked:
        asyncio.run(confirm(**kwargs))
    assert revoked.value.status_code == 409
    assert len([request for request in calendar.requests if request.get("method") == "PATCH"]) == 1
    assert mail.sends == []


@pytest.mark.parametrize("review_kind", ["rsvp", "workspace"])
def test_direct_calendar_review_rejects_read_only_grant_before_claim(
    monkeypatch: pytest.MonkeyPatch, review_kind: str
) -> None:
    service, calendar, db, mail = _service(monkeypatch)
    review = _review(service, review_kind=review_kind)
    calendar.allow_manage = False
    confirm = service.confirm_rsvp if review_kind == "rsvp" else service.confirm
    kwargs = {
        "user_id": "owner",
        "review_id": review["review_id"],
        "review_token": review["review_token"],
    }
    if review_kind == "workspace":
        kwargs["review_kind"] = "workspace"
    with pytest.raises(GoogleConnectionError) as caught:
        asyncio.run(confirm(**kwargs))
    assert caught.value.status_code == 403
    assert db.rows[review["review_id"]]["state"] == "prepared"
    assert not any(request.get("method") == "PATCH" for request in calendar.requests)
    assert mail.sends == []


def test_calendar_only_review_rejects_wrong_owner_tampering_and_expiry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service, calendar, db, mail = _service(monkeypatch)
    review = _review(service)
    kwargs = {"review_id": review["review_id"], "review_token": review["review_token"]}
    with pytest.raises(GoogleConnectionError) as wrong_owner:
        asyncio.run(service.confirm_rsvp(user_id="other-owner", **kwargs))
    assert wrong_owner.value.status_code == 403
    with pytest.raises(GoogleConnectionError):
        asyncio.run(
            service.confirm_rsvp(
                user_id="owner", **{**kwargs, "review_token": review["review_token"] + "x"}
            )
        )
    plan = service._open(review["review_token"], "calendar-review-v1")
    plan["expires"] = (datetime.now(UTC) - timedelta(seconds=1)).timestamp()
    with pytest.raises(GoogleConnectionError):
        asyncio.run(
            service.confirm_rsvp(
                user_id="owner",
                **{**kwargs, "review_token": service._seal(plan, "calendar-review-v1")},
            )
        )
    assert db.rows[review["review_id"]]["state"] == "prepared"
    assert not any(request.get("method") == "PATCH" for request in calendar.requests)
    assert mail.sends == []
