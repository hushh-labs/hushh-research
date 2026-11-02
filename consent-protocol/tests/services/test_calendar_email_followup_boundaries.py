"""Boundaries a heuristic must not cross: a divider is not a reply, a shared word is not a meeting.

Both rules only ever remove candidates, so a wrong match loses a real follow-up
silently. These cases pin where each rule stops.
"""

from __future__ import annotations

import pytest

from hushh_mcp.services.calendar_email_followup_reconcile import reconcile_candidates
from hushh_mcp.services.calendar_email_followup_relevance import (
    inside_region,
    quoted_or_signature_regions,
)
from tests.services.test_calendar_email_followup_relevance import (
    SYNC,
    _calendar,
    _monitor,
    _proposal,
)

REQUEST = "Please send the signed document before 26 November."


def _swallowed(body: str) -> bool:
    start = body.index(REQUEST)
    return inside_region(start, start + len(REQUEST), quoted_or_signature_regions(body))


@pytest.mark.parametrize(
    "body",
    [
        f"Hi team,\n_____\nAction item: {REQUEST}",
        f"Hi team,\n--\nAction item: {REQUEST}\n"
        + "\n".join(f"Detail line {n}" for n in range(14)),
        f"Hi team,\n_____\n\nAgenda\n{REQUEST}\nThanks",
    ],
)
def test_a_divider_line_does_not_hide_the_request_below_it(body):
    assert not _swallowed(body)


@pytest.mark.parametrize(
    "body",
    [
        # An Outlook rule is followed by the quoted header block.
        f"Thanks!\n________________________________\nFrom: Jhumma\nSent: Monday\n{REQUEST}",
        f"Thanks!\n-----Original Message-----\nFrom: Jhumma\n{REQUEST}",
        f"Thanks!\nOn Mon, 12 Oct 2026, Jhumma <j@example.test> wrote:\n{REQUEST}",
        # A short closing block after "--" is a signature.
        f"Thanks!\n--\nJane Doe\nVP Sales\n{REQUEST}",
        f"Thanks!\n> {REQUEST}",
    ],
)
def test_real_quoted_replies_and_signatures_still_hide_repeated_text(body):
    assert _swallowed(body)


async def _kept(events, *, subject="Hushh Growth Sync", **proposal):
    out = await reconcile_candidates(
        monitor=_monitor(),
        subject=subject,
        candidates=[_proposal(**proposal)],
        drops={},
        list_events=_calendar(events),
    )
    return len(out)


@pytest.mark.asyncio
async def test_a_request_to_move_an_existing_meeting_is_not_dropped_as_a_duplicate():
    # The sync is at 11 pm; the sender proposes 3 pm the same day.
    moved = "2026-10-27T15:00:00+05:30"
    assert await _kept([SYNC], proposed_at=moved) == 1
    # The same time is still the meeting that already exists.
    assert await _kept([SYNC]) == 0


@pytest.mark.asyncio
async def test_one_shared_word_does_not_make_a_proposal_a_duplicate():
    generic = {**SYNC, "id": "evt-call", "title": "Call"}
    date_only = {"proposed_at": None, "title": "Quick call", "subject": "Call"}
    assert await _kept([generic], **date_only) == 1
    # Two shared words on the same day name the meeting.
    assert await _kept([SYNC], proposed_at=None, title="Growth Sync agenda") == 0


@pytest.mark.asyncio
async def test_event_instants_compare_across_time_zones():
    # 23:00 IST is 17:30 UTC; an event written in UTC is the same moment.
    assert await _kept([{**SYNC, "start": {"dateTime": "2026-10-27T17:30:00Z"}}]) == 0
