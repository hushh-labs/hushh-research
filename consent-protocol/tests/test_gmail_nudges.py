"""Unit tests for the pure Gmail nudge derivation (no I/O).

Covers the "Needs a reply" intent logic: inbound-vs-outbound last message,
automated-sender filtering, staleness cutoff, ordering, and limit.
"""

from datetime import datetime, timedelta, timezone

from hushh_mcp.services.gmail_nudges import (
    NUDGE_NEEDS_REPLY,
    NudgeMessage,
    NudgeThread,
    derive_needs_reply_nudges,
    is_automated_sender,
    parse_from_header,
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
