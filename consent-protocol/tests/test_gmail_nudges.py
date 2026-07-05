"""Unit tests for the pure Gmail nudge derivation (no I/O).

Covers the "Needs a reply" intent logic: inbound-vs-outbound last message,
automated-sender filtering, staleness cutoff, ordering, and limit.
"""

from datetime import datetime, timedelta, timezone

from hushh_mcp.services.gmail_nudges import (
    NUDGE_NEEDS_REPLY,
    NUDGE_UPCOMING_MEETING,
    MeetingEvent,
    NudgeMessage,
    NudgeThread,
    derive_needs_reply_nudges,
    derive_upcoming_meeting_nudges,
    extract_meeting_datetime,
    extract_meeting_url,
    is_automated_sender,
    looks_like_meeting,
    parse_from_header,
    parse_ics_datetime,
    parse_ics_event,
)

_NOW = datetime(2026, 7, 4, 12, 0, 0, tzinfo=timezone.utc)
_USER = "me@example.com"


def _msg(
    from_email: str,
    *,
    minutes_ago: int = 0,
    subject: str = "Hello",
    message_id: str = "m1",
    from_name: str = "",
) -> NudgeMessage:
    return NudgeMessage(
        message_id=message_id,
        from_email=from_email,
        from_name=from_name,
        subject=subject,
        received_at=_NOW - timedelta(minutes=minutes_ago),
    )


def test_inbound_last_message_produces_needs_reply():
    thread = NudgeThread(
        thread_id="t1",
        messages=(
            _msg(_USER, minutes_ago=120, message_id="a"),
            _msg("ravi@acme.com", minutes_ago=60, message_id="b", subject="Q3 plan"),
        ),
    )
    nudges = derive_needs_reply_nudges([thread], user_email=_USER, now=_NOW)
    assert len(nudges) == 1
    assert nudges[0].type == NUDGE_NEEDS_REPLY
    assert nudges[0].thread_id == "t1"
    assert nudges[0].message_id == "b"
    assert nudges[0].title == "Q3 plan"
    assert nudges[0].sender_email == "ravi@acme.com"


def test_our_last_message_is_skipped():
    # We sent the last message -> waiting on them, not a needs-reply.
    thread = NudgeThread(
        thread_id="t2",
        messages=(
            _msg("ravi@acme.com", minutes_ago=120),
            _msg(_USER, minutes_ago=30),
        ),
    )
    assert derive_needs_reply_nudges([thread], user_email=_USER, now=_NOW) == []


def test_automated_sender_is_filtered():
    thread = NudgeThread(
        thread_id="t3",
        messages=(_msg("no-reply@newsletter.com", minutes_ago=10),),
    )
    assert derive_needs_reply_nudges([thread], user_email=_USER, now=_NOW) == []


def test_stale_thread_beyond_cutoff_is_dropped():
    thread = NudgeThread(
        thread_id="t4",
        messages=(_msg("ravi@acme.com", minutes_ago=60 * 24 * 45),),  # 45 days
    )
    assert derive_needs_reply_nudges([thread], user_email=_USER, now=_NOW, max_age_days=30) == []


def test_results_sorted_newest_first_and_limited():
    threads = [
        NudgeThread("t_old", (_msg("a@x.com", minutes_ago=300, message_id="o"),)),
        NudgeThread("t_new", (_msg("b@x.com", minutes_ago=10, message_id="n"),)),
        NudgeThread("t_mid", (_msg("c@x.com", minutes_ago=100, message_id="m"),)),
    ]
    nudges = derive_needs_reply_nudges(threads, user_email=_USER, now=_NOW, limit=2)
    assert [n.thread_id for n in nudges] == ["t_new", "t_mid"]


def test_empty_subject_falls_back():
    thread = NudgeThread("t5", (_msg("ravi@acme.com", subject="   "),))
    nudges = derive_needs_reply_nudges([thread], user_email=_USER, now=_NOW)
    assert nudges[0].title == "(no subject)"


def test_to_dict_serializes_received_at_iso():
    thread = NudgeThread("t6", (_msg("ravi@acme.com", minutes_ago=5),))
    payload = derive_needs_reply_nudges([thread], user_email=_USER, now=_NOW)[0].to_dict()
    assert payload["type"] == NUDGE_NEEDS_REPLY
    assert isinstance(payload["received_at"], str)
    assert payload["received_at"].startswith("2026-07-04")


def test_is_automated_sender():
    assert is_automated_sender("noreply@x.com") is True
    assert is_automated_sender("notifications@github.com") is True
    assert is_automated_sender("garbled") is True  # unparseable -> treat as automated
    assert is_automated_sender("ravi@acme.com") is False


def test_parse_from_header():
    assert parse_from_header("Ravi Kumar <ravi@acme.com>") == ("Ravi Kumar", "ravi@acme.com")
    # No display name -> falls back to local part.
    assert parse_from_header("sam@acme.com") == ("sam", "sam@acme.com")


# --- upcoming meeting -------------------------------------------------------


def test_parse_ics_datetime_forms():
    assert parse_ics_datetime("20260710T150000Z") == datetime(
        2026, 7, 10, 15, 0, 0, tzinfo=timezone.utc
    )
    assert parse_ics_datetime("20260710T150000") == datetime(
        2026, 7, 10, 15, 0, 0, tzinfo=timezone.utc
    )
    assert parse_ics_datetime("20260710") == datetime(2026, 7, 10, 0, 0, 0, tzinfo=timezone.utc)
    assert parse_ics_datetime("not-a-date") is None


_ICS = "\r\n".join(
    [
        "BEGIN:VCALENDAR",
        "BEGIN:VEVENT",
        "SUMMARY:Q3 planning sync",
        "DTSTART:20260706T160000Z",
        "ORGANIZER;CN=Ravi Kumar:mailto:ravi@acme.com",
        "END:VEVENT",
        "END:VCALENDAR",
    ]
)


def test_parse_ics_event_extracts_fields():
    event = parse_ics_event(_ICS, message_id="m1", thread_id="t1")
    assert event is not None
    assert event.summary == "Q3 planning sync"
    assert event.starts_at == datetime(2026, 7, 6, 16, 0, 0, tzinfo=timezone.utc)
    assert event.organizer_email == "ravi@acme.com"
    assert event.organizer_name == "Ravi Kumar"


def test_parse_ics_event_without_dtstart_is_none():
    assert parse_ics_event("SUMMARY:No time here", message_id="m", thread_id="t") is None


def _event(
    summary: str,
    hours_from_now: int | None,
    *,
    message_id: str = "m",
    thread_id: str | None = None,
    received_hours_ago: int | None = None,
    source: str = "invite",
    meeting_url: str | None = None,
) -> MeetingEvent:
    return MeetingEvent(
        message_id=message_id,
        thread_id=thread_id or message_id,
        summary=summary,
        organizer_name="Org",
        organizer_email="org@x.com",
        starts_at=None if hours_from_now is None else _NOW + timedelta(hours=hours_from_now),
        received_at=None
        if received_hours_ago is None
        else _NOW - timedelta(hours=received_hours_ago),
        source=source,
        meeting_url=meeting_url,
    )


def test_upcoming_meetings_future_only_sorted_and_limited():
    events = [
        _event("later", 48, message_id="a"),
        _event("past", -5, message_id="b"),
        _event("soon", 2, message_id="c"),
        _event("too far", 24 * 40, message_id="d"),  # beyond 30-day horizon
    ]
    nudges = derive_upcoming_meeting_nudges(events, now=_NOW, limit=5)
    assert [n.title for n in nudges] == ["soon", "later"]
    assert nudges[0].type == NUDGE_UPCOMING_MEETING
    assert nudges[0].starts_at == _NOW + timedelta(hours=2)


def test_upcoming_meetings_dedupe_by_thread():
    events = [
        _event("standup", 3, message_id="a", thread_id="shared"),
        _event("standup", 3, message_id="b", thread_id="shared"),
    ]
    nudges = derive_upcoming_meeting_nudges(events, now=_NOW)
    assert len(nudges) == 1


def test_undated_events_are_dropped_even_when_recent():
    # Undated meeting-language emails cannot be shown as upcoming (no time to
    # verify or count down to), so they are NOT surfaced — only the scheduled one.
    events = [
        _event("Coffee?", None, message_id="mention", received_hours_ago=3, source="email"),
        _event("Sprint review", 5, message_id="sched"),
    ]
    nudges = derive_upcoming_meeting_nudges(events, now=_NOW)
    assert [n.title for n in nudges] == ["Sprint review"]


def test_old_body_mention_is_dropped():
    events = [_event("stale", None, received_hours_ago=24 * 40, source="email")]
    assert derive_upcoming_meeting_nudges(events, now=_NOW) == []


def test_meeting_nudge_serializes_starts_at_and_meeting_url():
    payload = derive_upcoming_meeting_nudges(
        [_event("sync", 6, meeting_url="https://meet.google.com/abc-defg-hij")], now=_NOW
    )[0].to_dict()
    assert payload["type"] == NUDGE_UPCOMING_MEETING
    assert isinstance(payload["starts_at"], str)
    assert payload["meeting_url"] == "https://meet.google.com/abc-defg-hij"


_ICS_WITH_MEET = "\r\n".join(
    [
        "BEGIN:VCALENDAR",
        "BEGIN:VEVENT",
        "SUMMARY:Design review",
        "DTSTART:20260706T160000Z",
        "LOCATION:https://meet.google.com/xyz-abcd-efg",
        "ORGANIZER;CN=Ravi Kumar:mailto:ravi@acme.com",
        "END:VEVENT",
        "END:VCALENDAR",
    ]
)


def test_parse_ics_event_extracts_meeting_url():
    event = parse_ics_event(_ICS_WITH_MEET, message_id="m1", thread_id="t1")
    assert event is not None
    assert event.meeting_url == "https://meet.google.com/xyz-abcd-efg"


def test_parse_ics_event_without_conference_link_has_none_url():
    event = parse_ics_event(_ICS, message_id="m1", thread_id="t1")
    assert event is not None
    assert event.meeting_url is None


def test_extract_meeting_url():
    assert (
        extract_meeting_url("Join here: https://us02web.zoom.us/j/8412345678?pwd=abc trailing")
        == "https://us02web.zoom.us/j/8412345678?pwd=abc"
    )
    assert (
        extract_meeting_url("meet at https://meet.google.com/abc-defg-hij.")
        == "https://meet.google.com/abc-defg-hij"
    )
    assert extract_meeting_url("no link here, just text") is None
    assert extract_meeting_url(None) is None


def test_looks_like_meeting():
    assert looks_like_meeting("Can we schedule a meeting next week?") is True
    assert looks_like_meeting("let's meet Tuesday") is True
    assert looks_like_meeting("Your invoice is ready") is False


def test_extract_meeting_datetime():
    now = datetime(2026, 7, 4, 9, 0, 0, tzinfo=timezone.utc)  # Saturday
    # Explicit time today, still ahead -> today.
    got = extract_meeting_datetime("let's sync at 3pm", now=now)
    assert got == datetime(2026, 7, 4, 15, 0, 0, tzinfo=timezone.utc)
    # Tomorrow.
    got = extract_meeting_datetime("call tomorrow at 10am", now=now)
    assert got == datetime(2026, 7, 5, 10, 0, 0, tzinfo=timezone.utc)
    # No time -> None (treated as an undated mention).
    assert extract_meeting_datetime("we are meeting soon", now=now) is None
