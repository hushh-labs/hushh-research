"""Review/confirm cannot mutate an organizer or overstate Calendar/Mail success."""

from __future__ import annotations

import asyncio
import copy
import json
import threading
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from urllib.parse import urldefrag

import pytest

from hushh_mcp.runtime_settings import clear_runtime_settings_caches
from hushh_mcp.services.calendar_schedule_service import CalendarScheduleService
from hushh_mcp.services.google_calendar_service import GoogleCalendarService
from hushh_mcp.services.google_connection_service import GoogleConnectionError


class _Db:
    def __init__(self) -> None:
        self.rows: dict[str, dict[str, object]] = {}
        self.lock = threading.Lock()

    def execute_raw(self, sql: str, params: dict[str, object]) -> SimpleNamespace:
        with self.lock:
            if sql.startswith("DELETE"):
                return SimpleNamespace(data=[])
            review_id = str(params["review_id"])
            if sql.startswith("INSERT"):
                self.rows[review_id] = {"user_id": params["user_id"], "state": "prepared"}
                return SimpleNamespace(data=[])
            row = self.rows.get(review_id)
            if row is None or row["user_id"] != params["user_id"]:
                return SimpleNamespace(data=[])
            if "SET state = 'executing'" in sql:
                if row["state"] != "prepared":
                    return SimpleNamespace(data=[])
                row["state"] = "executing"
                return SimpleNamespace(data=[{"review_id": review_id}])
            if "SET state = 'complete'" in sql:
                row.update(state="complete", result_json=json.loads(str(params["result"])))
                return SimpleNamespace(data=[])
            if sql.startswith("SELECT"):
                return SimpleNamespace(data=[copy.deepcopy(row)])
            raise AssertionError(f"Unexpected Calendar persistence statement: {sql}")


class _Connections:
    def __init__(self) -> None:
        self.binding = ("owner", "calendar", "provider-sub", "connected-at", "grant-generation")

    async def status(self, **_: object) -> dict[str, object]:
        return {"google_email": "owner@example.com", "connected": True, "access_level": "manage"}

    async def read_grant_binding(self, **_: object) -> tuple[str, ...]:
        return self.binding


class _Calendar:
    _merged_busy_intervals = GoogleCalendarService._merged_busy_intervals

    def __init__(self) -> None:
        self.connections = _Connections()
        self.requests: list[dict[str, object]] = []
        self.fail_patch: Exception | None = None
        self.allow_manage = True
        self.event = {
            "id": "event/id",
            "etag": '"reviewed"',
            "summary": "Partner meeting",
            "status": "confirmed",
            "organizer": {"email": "organizer@example.com"},
            "htmlLink": "https://calendar.google.com/event?eid=meeting",
            "start": {"dateTime": "2030-10-14T10:00:00Z"},
            "end": {"dateTime": "2030-10-14T11:00:00Z"},
            "attendees": [
                {"email": "organizer@example.com", "organizer": True, "responseStatus": "accepted"},
                {"email": "owner@example.com", "self": True, "responseStatus": "accepted"},
                {"email": "other@example.com", "responseStatus": "tentative"},
            ],
        }

    async def _check_read_binding(self, user_id: str, binding: tuple[str, ...]) -> None:
        assert user_id == "owner"
        if binding != self.connections.binding:
            raise GoogleConnectionError("Calendar connection changed", status_code=409)

    async def _request(self, **kwargs: object) -> dict[str, object]:
        self.requests.append(kwargs)
        assert kwargs["user_id"] == "owner"
        if kwargs.get("access") == "manage" and not self.allow_manage:
            raise GoogleConnectionError("Allow Calendar management", status_code=403)
        if kwargs["method"] == "PATCH":
            if self.fail_patch:
                raise self.fail_patch
            self.event["attendees"][1]["responseStatus"] = "declined"
            self.event["etag"] = '"declined"'
        return copy.deepcopy(self.event)

    async def freebusy(self, **kwargs: object) -> dict[str, object]:
        self.requests.append({"method": "FREEBUSY", **kwargs})
        return {"calendars": {"primary": {"busy": []}, "work": {"busy": []}}}


class _Mail:
    def __init__(self) -> None:
        self.prepares: list[dict[str, object]] = []
        self.sends: list[dict[str, object]] = []
        self.fail_send: Exception | None = None

    async def prepare(self, **kwargs: object) -> dict[str, object]:
        self.prepares.append(copy.deepcopy(kwargs))
        return {
            "action_id": "mail-review",
            "sender_token": "sender-token",
            "sender_label": "Connected Mail",
        }

    async def execute(self, **kwargs: object) -> dict[str, object]:
        self.sends.append(copy.deepcopy(kwargs))
        if self.fail_send:
            raise self.fail_send
        return {"state": "sent"}


def _service(monkeypatch: pytest.MonkeyPatch):
    calendar, db, mail = _Calendar(), _Db(), _Mail()
    service = CalendarScheduleService(calendar=calendar, db=db, mail=mail)
    monkeypatch.setenv("APP_FRONTEND_ORIGIN", "https://one.example.com")
    clear_runtime_settings_caches()

    async def availability(**_: object) -> dict[str, object]:
        return {
            "openings": [{"start_at": "2030-10-15T10:00:00Z", "end_at": "2030-10-15T10:30:00Z"}],
            "calendars": [{"id": "primary"}, {"id": "work"}],
        }

    monkeypatch.setattr(service, "availability", availability)
    return service, calendar, db, mail


def _review(service: CalendarScheduleService, *, offer_times: bool = False):
    return asyncio.run(
        service.review(
            user_id="owner",
            event_id="event/id",
            offer_times=offer_times,
            message="Could we meet tomorrow instead?",
            date="2030-10-15",
            time_zone="UTC",
        )
    )


def _confirm(service: CalendarScheduleService, review: dict[str, object], *, user_id="owner"):
    return asyncio.run(
        service.confirm(
            user_id=user_id,
            review_id=review["review_id"],
            review_token=review["review_token"],
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
    "origin",
    [
        "http://localhost:3000",
        "https://localhost",
        "https://127.0.0.1",
        "https://10.0.0.1",
        "https://user@one.example.com",
        "https://localhost.",
        "https://2130706433",
        "https://one",
        "https://one.local",
        "https://224.0.0.1",
        "https://127.1",
    ],
)
def test_local_or_private_origins_cannot_be_sent_as_recipient_accessible_rescheduling_links(
    monkeypatch: pytest.MonkeyPatch, origin: str
) -> None:
    service, calendar, db, mail = _service(monkeypatch)
    monkeypatch.setenv("APP_FRONTEND_ORIGIN", origin)
    clear_runtime_settings_caches()

    try:
        with pytest.raises(GoogleConnectionError) as caught:
            _review(service, offer_times=True)

        assert caught.value.status_code == 503
        assert caught.value.reason_code == "calendar_rescheduling_unavailable"
        assert mail.prepares == []
        assert mail.sends == []
        assert not any(request["method"] == "PATCH" for request in calendar.requests)
        assert db.rows == {}
    finally:
        clear_runtime_settings_caches()


def test_configured_origin_normalization_does_not_leak_a_query_into_the_recipient_link(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from urllib.parse import urlparse

    service, calendar, _, mail = _service(monkeypatch)
    monkeypatch.setenv("APP_FRONTEND_ORIGIN", "https://one.example.com/?token=configuration-only")
    clear_runtime_settings_caches()
    try:
        review = _review(service, offer_times=True)
        link = urlparse(review["rescheduling_link"])
        assert link.scheme == "https"
        assert link.netloc == "one.example.com"
        assert link.path == "/calendar/reschedule"
        assert link.query == ""
        assert link.fragment
        assert "configuration-only" not in mail.prepares[0]["draft_payload"]["body"]
        assert mail.sends == []
        assert not any(request["method"] == "PATCH" for request in calendar.requests)
    finally:
        clear_runtime_settings_caches()


def test_review_cannot_decline_without_management_access(monkeypatch: pytest.MonkeyPatch) -> None:
    service, calendar, db, mail = _service(monkeypatch)
    calendar.allow_manage = False

    with pytest.raises(GoogleConnectionError) as caught:
        _review(service)

    assert caught.value.status_code == 403
    assert db.rows == {}
    assert mail.prepares == []


def test_provider_self_flag_cannot_impersonate_the_connected_google_account(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service, calendar, db, mail = _service(monkeypatch)
    calendar.event["attendees"][1]["email"] = "different-google-account@example.com"

    with pytest.raises(GoogleConnectionError) as caught:
        _review(service)

    assert caught.value.status_code == 403
    assert db.rows == {}
    assert mail.prepares == []


def test_foreign_owner_cannot_confirm_a_review(monkeypatch: pytest.MonkeyPatch) -> None:
    service, calendar, _, mail = _service(monkeypatch)
    review = _review(service, offer_times=True)
    calendar.requests.clear()

    with pytest.raises(GoogleConnectionError) as caught:
        _confirm(service, review, user_id="other")

    assert caught.value.status_code == 403
    assert calendar.requests == []
    assert mail.sends == []


def test_confirm_updates_only_self_and_replay_does_not_send_twice(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service, calendar, _, mail = _service(monkeypatch)
    review = _review(service, offer_times=True)

    first = _confirm(service, review)
    replay = _confirm(service, review)

    assert (
        first
        == replay
        == {
            "calendar": "declined",
            "email": "sent",
            "calendar_error": None,
            "email_error": None,
        }
    )
    mutations = [request for request in calendar.requests if request["method"] == "PATCH"]
    assert len(mutations) == 1
    assert mutations[0]["path"] == "/calendars/primary/events/event%2Fid"
    assert mutations[0]["headers"] == {"If-Match": '"reviewed"'}
    assert mutations[0]["payload"] == {
        "attendeesOmitted": True,
        "attendees": [{"email": "owner@example.com", "responseStatus": "declined"}],
    }
    assert calendar.event["attendees"][0]["responseStatus"] == "accepted"
    assert calendar.event["attendees"][2]["responseStatus"] == "tentative"
    assert len(mail.sends) == 1


def test_parallel_confirmations_claim_the_review_once(monkeypatch: pytest.MonkeyPatch) -> None:
    service, calendar, _, mail = _service(monkeypatch)
    review = _review(service, offer_times=True)

    async def confirm_twice() -> list[object]:
        return await asyncio.gather(
            service.confirm(
                user_id="owner", review_id=review["review_id"], review_token=review["review_token"]
            ),
            service.confirm(
                user_id="owner", review_id=review["review_id"], review_token=review["review_token"]
            ),
            return_exceptions=True,
        )

    results = asyncio.run(confirm_twice())

    assert any(isinstance(result, dict) and result["calendar"] == "declined" for result in results)
    for result in results:
        if isinstance(result, Exception):
            assert isinstance(result, GoogleConnectionError)
            assert result.status_code == 409
    assert len([request for request in calendar.requests if request["method"] == "PATCH"]) == 1
    assert len(mail.sends) == 1


@pytest.mark.parametrize("changed", ["etag", "grant"])
def test_changed_invitation_or_grant_requires_a_new_review(
    monkeypatch: pytest.MonkeyPatch, changed: str
) -> None:
    service, calendar, _, mail = _service(monkeypatch)
    review = _review(service, offer_times=True)
    if changed == "etag":
        calendar.event["etag"] = '"updated-by-organizer"'
    else:
        calendar.connections.binding = (
            "owner",
            "calendar",
            "other-provider",
            "connected-at",
            "new-grant",
        )

    result = _confirm(service, review)

    assert result["calendar"] == "failed"
    assert result["calendar_error"]
    assert result["email"] == "not_sent"
    assert not any(request["method"] == "PATCH" for request in calendar.requests)
    assert mail.sends == []


@pytest.mark.parametrize(
    ("status", "expected"), [(403, "failed"), (502, "unknown"), (503, "unknown"), (504, "unknown")]
)
def test_calendar_failure_never_sends_the_organizer_email(
    monkeypatch: pytest.MonkeyPatch, status: int, expected: str
) -> None:
    service, calendar, _, mail = _service(monkeypatch)
    review = _review(service, offer_times=True)
    calendar.fail_patch = GoogleConnectionError("Calendar provider failed", status_code=status)

    result = _confirm(service, review)

    assert result["calendar"] == expected
    assert result["calendar_error"] == "Calendar provider failed"
    assert result["email"] == "not_sent"
    assert mail.sends == []


def test_email_failure_preserves_confirmed_decline_and_safe_replay(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service, calendar, _, mail = _service(monkeypatch)
    review = _review(service, offer_times=True)
    mail.fail_send = TimeoutError("Gmail timed out after accepting request")

    result = _confirm(service, review)
    replay = _confirm(service, review)

    assert result == replay
    assert result["calendar"] == "declined"
    assert result["calendar_error"] is None
    assert result["email"] in {"failed", "unknown"}
    assert result["email_error"]
    assert len(mail.sends) == 1
    assert len([request for request in calendar.requests if request["method"] == "PATCH"]) == 1


def test_nullable_mail_error_code_cannot_erase_a_confirmed_decline(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from hushh_mcp.services.gmail_receipts_service import GmailApiError

    service, calendar, _, mail = _service(monkeypatch)
    review = _review(service, offer_times=True)
    mail.fail_send = GmailApiError("Mail provider unavailable", status_code=502, code=None)

    result = _confirm(service, review)
    replay = _confirm(service, review)

    assert result == replay
    assert result["calendar"] == "declined"
    assert result["email"] in {"failed", "unknown"}
    assert result["email_error"] == "Mail provider unavailable"
    assert len(mail.sends) == 1
    assert len([request for request in calendar.requests if request["method"] == "PATCH"]) == 1


def test_offered_times_are_requested_from_the_future_window_before_review(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service, _, _, _ = _service(monkeypatch)
    observed: list[dict[str, object]] = []

    async def availability(**kwargs: object) -> dict[str, object]:
        observed.append(kwargs)
        return {
            "openings": [{"start_at": "2030-10-15T10:00:00Z", "end_at": "2030-10-15T10:30:00Z"}],
            "calendars": [{"id": "primary"}],
        }

    monkeypatch.setattr(service, "availability", availability)
    _review(service, offer_times=True)

    assert observed[0]["future_only"] is True


def test_provider_must_confirm_self_declined_before_email_is_sent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service, calendar, _, mail = _service(monkeypatch)
    review = _review(service, offer_times=True)

    async def unconfirmed(**kwargs: object) -> dict[str, object]:
        calendar.requests.append(kwargs)
        # HTTP success without a verified self response is an unknown outcome.
        return copy.deepcopy(calendar.event)

    monkeypatch.setattr(calendar, "_request", unconfirmed)
    result = _confirm(service, review)

    assert result["calendar"] == "unknown"
    assert result["calendar_error"]
    assert result["email"] == "not_sent"
    assert mail.sends == []


def test_tampering_with_a_review_cannot_dispatch_a_calendar_mutation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service, calendar, _, mail = _service(monkeypatch)
    review = _review(service, offer_times=True)
    token = review["review_token"]
    review["review_token"] = ("A" if token[0] != "A" else "B") + token[1:]
    calendar.requests.clear()

    with pytest.raises(GoogleConnectionError) as caught:
        _confirm(service, review)

    assert caught.value.status_code == 410
    assert calendar.requests == []
    assert mail.sends == []


def test_organizer_gets_exact_edited_message_and_a_public_rechecked_link(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service, calendar, _, mail = _service(monkeypatch)
    review = _review(service, offer_times=True)

    assert review["recipient"] == "organizer@example.com"
    assert review["message"].startswith("Could we meet tomorrow instead?\n\n")
    assert review["rescheduling_link"].startswith("https://one.example.com/calendar/reschedule#")
    assert review["rescheduling_link"] in review["message"]
    assert "calendar.google.com/calendar" not in review["message"]
    assert mail.prepares[0]["draft_payload"]["to"] == review["recipient"]
    _, capability = urldefrag(review["rescheduling_link"])

    # The recipient needs the deliberately reviewed capability, no owner login.
    options = asyncio.run(service.public_options(token=capability))

    assert options["reply_to"] == "owner@example.com"
    assert options["openings"] == [
        {"start_at": "2030-10-15T10:00:00Z", "end_at": "2030-10-15T10:30:00Z"}
    ]
    check = next(request for request in calendar.requests if request["method"] == "FREEBUSY")
    assert check["calendar_ids"] == ["primary", "work"]


def test_public_link_expires_and_revoked_grant_cannot_reveal_options(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service, calendar, _, _ = _service(monkeypatch)
    review = _review(service, offer_times=True)
    _, capability = urldefrag(review["rescheduling_link"])
    plan = service._open(capability, "calendar-public-v1")
    plan["expires"] = (datetime.now(UTC) - timedelta(seconds=1)).timestamp()
    expired = service._seal(plan, "calendar-public-v1")

    with pytest.raises(GoogleConnectionError) as caught:
        asyncio.run(service.public_options(token=expired))
    assert caught.value.status_code == 410

    calendar.connections.binding = ("owner", "calendar", "revoked")
    with pytest.raises(GoogleConnectionError):
        asyncio.run(service.public_options(token=capability))
    assert not any(request["method"] == "FREEBUSY" for request in calendar.requests)


def test_new_busy_period_removes_previously_offered_public_option(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service, calendar, _, _ = _service(monkeypatch)
    review = _review(service, offer_times=True)
    _, capability = urldefrag(review["rescheduling_link"])

    async def busy(**_: object) -> dict[str, object]:
        return {
            "calendars": {
                "primary": {"busy": []},
                "work": {
                    "busy": [{"start": "2030-10-15T10:10:00Z", "end": "2030-10-15T10:20:00Z"}]
                },
            }
        }

    monkeypatch.setattr(calendar, "freebusy", busy)
    result = asyncio.run(service.public_options(token=capability))

    assert result["openings"] == []


def test_public_options_cannot_cross_a_reconnect_during_availability_read(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    service, calendar, _, _ = _service(monkeypatch)
    review = _review(service, offer_times=True)
    _, capability = urldefrag(review["rescheduling_link"])

    async def reconnect_during_read(**_: object) -> dict[str, object]:
        calendar.connections.binding = ("owner", "calendar", "replacement-provider", "new-grant")
        return {"calendars": {"primary": {"busy": []}, "work": {"busy": []}}}

    monkeypatch.setattr(calendar, "freebusy", reconnect_during_read)

    with pytest.raises(GoogleConnectionError):
        asyncio.run(service.public_options(token=capability))


def test_plain_decline_sends_exact_reason_once_after_confirmation(monkeypatch):
    service, calendar, _, mail = _service(monkeypatch)
    review = asyncio.run(
        service.review(
            user_id="owner",
            event_id="event/id",
            send_message=True,
            message="I have a family commitment.",
        )
    )
    assert review["recipient"] == "organizer@example.com"
    assert review["start"] == calendar.event["start"]
    assert review["end"] == calendar.event["end"]
    assert review["message"] == "I have a family commitment."
    assert not mail.sends
    result = _confirm(service, review)
    assert result["calendar"] == "declined" and result["email"] == "sent"
    assert _confirm(service, review) == result
    assert len(mail.sends) == 1
    assert mail.sends[0]["draft_payload"]["body"] == review["message"]


@pytest.mark.parametrize("changed", [False, True])
def test_exact_proposal_derives_duration_and_rechecks_acknowledged_busy_time(monkeypatch, changed):
    service, calendar, _, mail = _service(monkeypatch)

    async def inventory(*args, **kwargs):
        return [
            {"id": "primary", "primary": True},
            {"id": "en.indian#holiday@group.v.calendar.google.com"},
        ]

    monkeypatch.setattr(service, "_included_calendars", inventory)
    state = {"changed": False}

    async def freebusy(**kwargs):
        assert kwargs["calendar_ids"] == ["primary"]
        return {
            "calendars": {
                "primary": {
                    "busy": [
                        {
                            "start": "2030-10-15T04:30:00Z",
                            "end": "2030-10-15T05:15:00Z"
                            if state["changed"]
                            else "2030-10-15T05:00:00Z",
                        }
                    ]
                }
            }
        }

    monkeypatch.setattr(calendar, "freebusy", freebusy)
    monkeypatch.setattr(
        calendar,
        "_reject_new_conflicts",
        GoogleCalendarService._reject_new_conflicts,
        raising=False,
    )
    review = asyncio.run(
        service.review(
            user_id="owner",
            event_id="event/id",
            offer_times=True,
            exact_time=True,
            send_message=True,
            message="Please move our call.",
            date="2030-10-15",
            time_zone="Asia/Kolkata",
            start_time="10:00",
            end_time="11:00",
            duration_minutes=30,
        )
    )
    assert review["openings"][0]["duration_minutes"] == 60
    assert review["conflicts"] and review["rescheduling_link"] is None
    assert "10:00" in review["message"] and "11:00" in review["message"]
    assert "60 minutes" in review["message"]
    state["changed"] = changed
    result = _confirm(service, review)
    assert result["calendar"] == ("failed" if changed else "declined")
    assert len(mail.sends) == (0 if changed else 1)


def test_decline_requires_reason_and_mail_never_follows_failed_rsvp(monkeypatch):
    service, calendar, _, mail = _service(monkeypatch)
    with pytest.raises(GoogleConnectionError):
        asyncio.run(
            service.review(user_id="owner", event_id="event/id", send_message=True, message="  ")
        )
    review = asyncio.run(
        service.review(
            user_id="owner", event_id="event/id", send_message=True, message="Unavailable."
        )
    )
    calendar.fail_patch = GoogleConnectionError("Permission required", status_code=403)
    assert _confirm(service, review)["email"] == "not_sent"
    assert not mail.sends


def test_mail_only_retry_requires_current_decline_and_never_changes_attendance(monkeypatch):
    service, calendar, _, mail = _service(monkeypatch)
    calendar.event["attendees"][1]["responseStatus"] = "declined"
    review = asyncio.run(
        service.review(
            user_id="owner",
            event_id="event/id",
            send_message=True,
            mail_only_retry=True,
            message="I cannot attend.",
        )
    )
    assert _confirm(service, review) == {
        "calendar": "declined",
        "email": "sent",
        "calendar_error": None,
        "email_error": None,
    }
    assert not any(request["method"] == "PATCH" for request in calendar.requests)
    assert len(mail.sends) == 1

    calendar.event["attendees"][1]["responseStatus"] = "accepted"
    with pytest.raises(GoogleConnectionError) as failure:
        asyncio.run(
            service.review(
                user_id="owner",
                event_id="event/id",
                send_message=True,
                mail_only_retry=True,
                message="I cannot attend.",
            )
        )
    assert failure.value.status_code == 409

    calendar.event["attendees"][1]["responseStatus"] = "declined"
    stale = asyncio.run(
        service.review(
            user_id="owner",
            event_id="event/id",
            send_message=True,
            mail_only_retry=True,
            message="I cannot attend.",
        )
    )
    calendar.event["attendees"][1]["responseStatus"] = "tentative"
    assert _confirm(service, stale)["calendar"] == "failed"
    assert len(mail.sends) == 1
    assert not any(request["method"] == "PATCH" for request in calendar.requests)


def test_exact_proposal_preserves_midnight_and_fails_closed_on_unreadable_calendar(monkeypatch):
    service, calendar, _, mail = _service(monkeypatch)

    async def inventory(*args, **kwargs):
        return [{"id": "primary", "primary": True}]

    monkeypatch.setattr(service, "_included_calendars", inventory)
    review = asyncio.run(
        service.review(
            user_id="owner",
            event_id="event/id",
            offer_times=True,
            exact_time=True,
            send_message=True,
            message="Late call please.",
            date="2030-10-15",
            time_zone="Asia/Kolkata",
            start_time="23:30",
            end_time="24:00",
            duration_minutes=1,
        )
    )
    assert review["openings"][0] == {
        "start_at": "2030-10-15T18:00:00Z",
        "end_at": "2030-10-15T18:30:00Z",
        "duration_minutes": 30,
    }

    async def unreadable(**kwargs):
        return {"calendars": {"primary": {"errors": [{"reason": "notFound"}]}}}

    monkeypatch.setattr(calendar, "freebusy", unreadable)
    with pytest.raises(GoogleConnectionError) as failure:
        asyncio.run(
            service.review(
                user_id="owner",
                event_id="event/id",
                offer_times=True,
                exact_time=True,
                date="2030-10-15",
                time_zone="UTC",
                start_time="10:00",
                end_time="11:00",
            )
        )
    assert failure.value.reason_code == "calendar_unreadable"
    assert not mail.sends
