"""Relevance regressions: security alerts and duplicates are never Calendar work.

The synthetic Google alert below reproduces the UAT defect: the extractor was
asked for "each distinct action requested of the owner" with no definition of a
Calendar-relevant request, so an account-protection imperative became a task.
The model doubles are synthetic. No live model or mailbox is called here.
"""

from __future__ import annotations

import hashlib
from datetime import UTC, datetime

import pytest

from hushh_mcp.services.calendar_email_followup_extraction import (
    ValidatedCandidate,
    assess_complete_message,
)
from hushh_mcp.services.calendar_email_followup_reader import (
    CompleteMailMessage,
    CompleteMailReadError,
    split_complete_body,
)
from hushh_mcp.services.calendar_email_followup_reconcile import reconcile_candidates
from hushh_mcp.services.calendar_email_followup_relevance import (
    sanitize_excerpt,
    sanitize_source_body,
)
from hushh_mcp.services.calendar_email_followup_store_types import Monitor

SECURITY_ALERT = "\n".join(
    [
        "[image: Google]",
        "You allowed Hushh access to some of your Google Account data",
        "",
        "owner@example.test",
        "",
        "If you didn't allow Hushh access to some of your Google Account data,",
        "someone else may be trying to access your Google Account data.",
        "",
        "Take a moment now to check your account activity and secure your account.",
        "Check activity",
        "<https://accounts.google.com/AccountChooser?Email=owner@example.test&continue="
        "https://myaccount.google.com/alert/nt/1793543531000?rfn%3D127%26eid%3D-20024070>",
        "To make changes at any time to the access that Hushh has to your data, go",
        "to your Google Account",
        "<https://accounts.google.com/AccountChooser?Email=owner@example.test&continue="
        "https://myaccount.google.com/connections/overview/AUKa-synthetic>",
    ]
)
SECURITY_SENTENCE = "Take a moment now to check your account activity and secure your account."


_SYNTHETIC_CONSENT = "synthetic-consent"


def _message(
    body: str, *, subject: str, sender: str, message_id: str = "msg-1"
) -> CompleteMailMessage:
    return CompleteMailMessage(
        message_id=message_id,
        thread_id="thread-" + message_id,
        internal_date_ms=int(datetime(2026, 11, 1, tzinfo=UTC).timestamp() * 1000),
        subject=subject,
        sender=sender,
        body=body,
        body_digest=hashlib.sha256(body.encode()).hexdigest(),
        sections=split_complete_body(body, max_section_bytes=4000, overlap_chars=120),
    )


async def _current() -> None:
    return None


async def _assess(message: CompleteMailMessage, gene):
    return await assess_complete_message(
        message=message,
        user_id="synthetic-owner",
        consent_token=_SYNTHETIC_CONSENT,
        owner_time_zone="Asia/Kolkata",
        prior_requests=[],
        evidence_key=b"synthetic-purpose-separated-key",
        require_current=_current,
        gene_runner=gene,
    )


def _candidate(index: int, section_text: str, quote: str, title: str, **extra):
    return {
        "local_index": index,
        "section_index": 0,
        "kind": "action",
        "quote_start": section_text.index(quote),
        "source_quote": quote,
        "title": title,
        "responsibility": "owner",
        "ambiguities": [],
        **extra,
    }


@pytest.fixture
def alert() -> CompleteMailMessage:
    return _message(
        SECURITY_ALERT, subject="Security alert", sender="Google <no-reply@accounts.google.com>"
    )


@pytest.mark.asyncio
async def test_security_alert_from_the_unfixed_contract_yields_no_followups(alert):
    """UAT repro: the two imperatives in the Google alert became two follow-ups.

    This double returns exactly what the shipped contract asked for (candidates
    with no relevance verdict). A candidate with no explicit actionable verdict
    must never become Calendar work.
    """
    section = alert.sections[0].text

    async def unfixed_contract_model(**_kwargs):
        return {
            "candidates": [
                _candidate(
                    0, section, SECURITY_SENTENCE, "Check account activity and secure your account"
                ),
                _candidate(1, section, "Check activity", "Check activity"),
            ],
            "updates": [],
        }

    result = await _assess(alert, unfixed_contract_model)
    assert result.candidates == ()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "verdict",
    [
        {"relevance": "informational", "category": "account_security"},
        # Even a model that wrongly says "actionable" cannot promote an
        # account-protection category into a Calendar obligation.
        {"relevance": "actionable", "category": "account_security"},
        {"relevance": "uncertain", "category": "response_needed"},
    ],
)
async def test_explicit_non_calendar_verdicts_are_dropped(alert, verdict):
    section = alert.sections[0].text

    async def model(**_kwargs):
        return {
            "candidates": [
                _candidate(
                    0,
                    section,
                    SECURITY_SENTENCE,
                    "Check account activity and secure your account",
                    evidence_reason="The sender asks the owner to review account activity.",
                    **verdict,
                )
            ],
            "updates": [],
            "message_relevance": "informational",
        }

    result = await _assess(alert, model)
    assert result.candidates == ()
    assert result.dropped_counts.get("not_calendar_relevant", 0) == 1


@pytest.mark.asyncio
async def test_actionable_request_with_calendar_category_is_kept():
    """Negative control: the same pipeline still admits a real owner obligation."""
    body = "Hi,\n\nPlease send the signed document before 26 October.\n\nThanks, Jhumma"
    message = _message(
        body, subject="Document", sender="Jhumma <j@example.test>", message_id="msg-2"
    )
    section = message.sections[0].text
    quote = "Please send the signed document before 26 October."

    async def model(**_kwargs):
        return {
            "candidates": [
                {
                    **_candidate(0, section, quote, "Send the signed document"),
                    "kind": "deadline",
                    "relevance": "actionable",
                    "category": "document_or_information",
                    "requested_by": "Jhumma",
                    "evidence_reason": "Jhumma asks the owner to send a document by a date.",
                    "original_due_wording": "before 26 October",
                    "due_date": "2026-10-26",
                    "due_relation": "before",
                }
            ],
            "updates": [],
        }

    result = await _assess(message, model)
    assert [item.title for item in result.candidates] == ["Send the signed document"]
    assert result.candidates[0].category == "document_or_information"
    assert result.candidates[0].due_relation == "before"


@pytest.mark.asyncio
async def test_two_phrasings_of_one_request_become_one_followup():
    body = (
        "Please send the signed document before 26 October.\n\n"
        "Reminder: do not forget to send the signed document by 26 October."
    )
    message = _message(
        body, subject="Document", sender="Jhumma <j@example.test>", message_id="msg-3"
    )
    section = message.sections[0].text
    first = "Please send the signed document before 26 October."
    second = "do not forget to send the signed document by 26 October."

    def candidate(index: int, quote: str, title: str):
        return {
            **_candidate(index, section, quote, title),
            "kind": "deadline",
            "relevance": "actionable",
            "category": "document_or_information",
            "evidence_reason": "A document is expected from the owner by a date.",
            "original_due_wording": "26 October",
            "due_date": "2026-10-26",
            "due_relation": "before",
        }

    async def model(**_kwargs):
        return {
            "candidates": [
                candidate(0, first, "Send the signed document"),
                candidate(1, second, "Send the signed document by 26 October"),
            ],
            "updates": [],
        }

    result = await _assess(message, model)
    assert len(result.candidates) == 1
    assert result.candidates[0].quote == first
    assert result.dropped_counts.get("duplicate", 0) == 1


@pytest.mark.asyncio
async def test_distinct_requests_in_one_email_are_not_merged():
    """The document and the call are separate obligations with their own state."""
    body = "Please send the signed document before 26 October. Could we have a call on 27 October?"
    message = _message(
        body, subject="Document and call", sender="Jhumma <j@example.test>", message_id="msg-4"
    )
    section = message.sections[0].text
    document = "Please send the signed document before 26 October."
    call = "Could we have a call on 27 October?"

    async def model(**_kwargs):
        return {
            "candidates": [
                {
                    **_candidate(0, section, document, "Send the signed document"),
                    "kind": "deadline",
                    "relevance": "actionable",
                    "category": "document_or_information",
                    "evidence_reason": "A document is requested by a date.",
                    "due_date": "2026-10-26",
                    "due_relation": "before",
                },
                {
                    **_candidate(1, section, call, "Review a call with Jhumma"),
                    "kind": "meeting",
                    "relevance": "actionable",
                    "category": "meeting_request",
                    "meeting_state": "proposed",
                    "evidence_reason": "A call is proposed for a date.",
                    "proposed_date": "2026-10-27",
                    "ambiguities": ["time", "duration"],
                },
            ],
            "updates": [],
        }

    result = await _assess(message, model)
    assert {item.kind for item in result.candidates} == {"deadline", "meeting"}


@pytest.mark.asyncio
async def test_request_quoted_from_an_earlier_message_is_not_counted_twice():
    body = (
        "Thanks, noted.\n\n"
        "On Mon, 12 Oct 2026, Jhumma <j@example.test> wrote:\n"
        "> Please send the signed document before 26 October.\n"
    )
    message = _message(
        body, subject="Re: Document", sender="Owner <owner@example.test>", message_id="msg-5"
    )
    section = message.sections[0].text
    quote = "Please send the signed document before 26 October."

    async def model(**_kwargs):
        return {
            "candidates": [
                {
                    **_candidate(0, section, quote, "Send the signed document"),
                    "kind": "deadline",
                    "relevance": "actionable",
                    "category": "document_or_information",
                    "evidence_reason": "A document is requested by a date.",
                    "due_date": "2026-10-26",
                    "due_relation": "before",
                }
            ],
            "updates": [],
        }

    result = await _assess(message, model)
    assert result.candidates == ()
    assert result.dropped_counts.get("quoted_or_signature", 0) == 1


# --- Calendar reconciliation -------------------------------------------------


def _monitor() -> Monitor:
    return Monitor(
        user_id="synthetic-owner",
        account_id="acct-a",
        generation="g",
        grant_epoch_digest="d",
        provider_subject_sha256="p",
        mail_generation="m",
        calendar_connected_at=datetime(2026, 10, 1, tzinfo=UTC),
        calendar_grant_revision=None,
        historical_start_at=datetime(2026, 8, 1, tzinfo=UTC),
        time_zone="Asia/Kolkata",
        reminder_lead_days=1,
        reminder_hour=9,
        notifications_enabled=True,
        checkpoint=None,
        scan_state="complete",
        lease_id=None,
    )


def _proposal(**extra) -> ValidatedCandidate:
    base = {
        "evidence_key": "k-call",
        "message_id": "m1",
        "thread_id": "t1",
        "body_digest": "d",
        "source_internal_date_ms": 0,
        "kind": "meeting",
        "global_quote_start": 0,
        "quote": "Could we sync on 27 October at 11 pm?",
        "title": "Review proposed call with the professor",
        "original_due_wording": None,
        "due_date": None,
        "due_relation": None,
        "proposed_date": "2026-10-27",
        "proposed_at": "2026-10-27T23:00:00+05:30",
        "time_zone": "Asia/Kolkata",
        "responsibility": "owner",
        "ambiguities": (),
        "category": "meeting_request",
        "meeting_state": "proposed",
    }
    return ValidatedCandidate(**{**base, **extra})


def _calendar(events, *, truncated=False):
    async def list_events(**_kwargs):
        return {"events": events, "truncated": truncated}

    return list_events


SYNC = {
    "id": "evt-sync",
    "title": "Hushh Growth Sync",
    "status": "confirmed",
    "start": {"dateTime": "2026-10-27T23:00:00+05:30"},
}


@pytest.mark.asyncio
async def test_proposal_for_an_existing_event_is_dropped_but_unknown_or_unverifiable_is_kept():
    kept = {}
    for name, events, truncated in [
        ("existing", [SYNC], False),
        ("absent", [], False),
        # A cancelled event is not a meeting; the proposal still needs the owner.
        ("cancelled", [{**SYNC, "status": "cancelled"}], False),
        # A truncated page proves nothing about absence, so the proposal stays.
        ("truncated", [], True),
    ]:
        drops: dict[str, int] = {}
        out = await reconcile_candidates(
            monitor=_monitor(),
            subject="Hushh Growth Sync",
            candidates=[_proposal()],
            drops=drops,
            list_events=_calendar(events, truncated=truncated),
        )
        kept[name] = (len(out), drops.get("existing_meeting", 0))
    assert kept == {
        "existing": (0, 1),
        "absent": (1, 0),
        "cancelled": (1, 0),
        "truncated": (1, 0),
    }


@pytest.mark.asyncio
async def test_action_about_an_existing_meeting_links_to_that_occurrence():
    action = _proposal(
        evidence_key="k-doc",
        kind="action",
        title="Send the agenda for the sync",
        proposed_date=None,
        proposed_at=None,
        meeting_state="none",
        category="document_or_information",
        related_meeting_hint="Hushh Growth Sync",
    )
    out = await reconcile_candidates(
        monitor=_monitor(),
        subject="Agenda",
        candidates=[action],
        drops={},
        list_events=_calendar([SYNC]),
        now=datetime(2026, 10, 25, tzinfo=UTC),
    )
    assert out[0].linked_event == ("evt-sync", "Hushh Growth Sync", "2026-10-27T23:00:00+05:30")


@pytest.mark.asyncio
async def test_calendar_failure_is_retryable_not_a_silent_pass():
    async def broken(**_kwargs):
        raise RuntimeError("synthetic provider outage")

    with pytest.raises(CompleteMailReadError) as raised:
        await reconcile_candidates(
            monitor=_monitor(),
            subject="Sync",
            candidates=[_proposal()],
            drops={},
            list_events=broken,
        )
    assert raised.value.code == "calendar_unavailable"
    assert raised.value.retryable is True


def test_source_text_hides_tracking_links_and_image_markers_but_keeps_the_words():
    """The raw Google alert in the UAT modal showed `[image: Google]` and long tracking URLs."""
    shown = sanitize_source_body(SECURITY_ALERT)
    assert "https://" not in shown and "[image:" not in shown
    assert "myaccount.google.com" not in shown and "AccountChooser" not in shown
    assert SECURITY_SENTENCE in shown
    excerpt = sanitize_excerpt(SECURITY_ALERT + " " + "x" * 600)
    assert len(excerpt) <= 241 and "https://" not in excerpt
