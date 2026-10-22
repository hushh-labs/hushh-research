"""Scheduled mail by voice: the yes stores a sealed send; the model hears times.

The owner names a future time; the model resolves it against the owner-local
clock and passes an absolute timestamp. The server validates that time at the
card and again on the yes, re-checks the recipient exactly like ``send_mail``,
and stores the send through the real ``GmailDeliveryService`` against an
in-memory ledger. Nothing here sends anything: delivery is the drain's job.

The frozen clock is Monday 2026-10-05 14:06:55 UTC, 19:36:55 in Kolkata.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Any

import pytest

from hushh_mcp.one_voice import private_pending
from hushh_mcp.one_voice.actor_proof import ProofOutcome
from hushh_mcp.one_voice.config import OneVoiceMailAdmission
from hushh_mcp.one_voice.tools import mail, registry
from hushh_mcp.one_voice.tools.base import OFFER_TTL_SECONDS, ToolPolicy
from hushh_mcp.one_voice.tools.executor import PREPARED_KEY, TARGET_KEY, ToolExecutor
from hushh_mcp.services import gmail_delivery_service as delivery_module
from hushh_mcp.services.gmail_delivery_service import GmailDeliveryService
from hushh_mcp.services.gmail_receipts_service import GmailApiError
from tests.one_voice.fakes import MemoryPendingStore
from tests.one_voice.test_tools_people import AYESHA, OWNER, ConnectionsDouble, make_ctx
from tests.services.test_gmail_delivery_service import ScheduleLedgerConn, _Pool

NOW = datetime(2026, 10, 5, 14, 6, 55, tzinfo=timezone.utc)
SEND_AT = "2026-10-06T09:00:00+05:30"
SEND_AT_UTC = datetime(2026, 10, 6, 3, 30, tzinfo=timezone.utc)
# Distinctive on purpose: each may reach the ledger only sealed or as a display
# column, and the model never.
SUBJECT = "Quarterly zebra budget"
MESSAGE = "Please bring the signed lighthouse contract on Tuesday."
ADDRESS = "ayesha@example.com"


class Clock:
    def __init__(self) -> None:
        self.now = NOW

    def __call__(self) -> datetime:
        return self.now


class ScheduleAdmission(OneVoiceMailAdmission):
    """Every switch, settable mid-test: a kill switch can flip under a waiting card."""

    def __init__(self) -> None:
        self.schedule = True
        self.reads = True
        self.drain = True

    def mail_reads_enabled(self) -> bool:
        return self.reads

    def mail_schedule_send_enabled(self) -> bool:
        return self.schedule

    def mail_scheduled_drain_enabled(self) -> bool:
        return self.drain


SENDER_SUB = "google-sub-owner"


class GmailDouble:
    def __init__(self) -> None:
        self.send_error: GmailApiError | None = None
        self.sender_sub = SENDER_SUB

    async def assert_send_ready(self, *, user_id: str) -> None:
        assert user_id == OWNER
        if self.send_error is not None:
            raise self.send_error

    def _fetch_connection_row(self, *, user_id: str) -> dict[str, Any] | None:
        assert user_id == OWNER
        return {"status": "connected", "revoked": False, "google_sub": self.sender_sub}


@pytest.fixture
def h(monkeypatch):
    settings = SimpleNamespace(app_signing_key="voice-mail-schedule-test-signing-key")
    for module in (mail, private_pending, delivery_module):
        monkeypatch.setattr(module, "get_core_security_settings", lambda: settings)

    async def no_send(*_args, **_kwargs):
        raise AssertionError("scheduling must never prepare or execute an immediate send")

    monkeypatch.setattr(GmailDeliveryService, "prepare", no_send)
    monkeypatch.setattr(GmailDeliveryService, "execute", no_send)
    ledger = ScheduleLedgerConn()
    monkeypatch.setattr(
        delivery_module, "get_pool", lambda: __import__("asyncio").sleep(0, result=_Pool(ledger))
    )
    connections = ConnectionsDouble()
    ctx, _, _ = make_ctx(connections=connections)
    ctx.timezone = "Asia/Kolkata"
    ctx.firebase_id_token = "verified-schedule-owner"  # noqa: S105

    async def prove_owner(token: str | None, user_id: str) -> ProofOutcome:
        if not token:
            return "missing"
        if user_id != OWNER or token == "another-owner":
            return "mismatch"
        return "ok" if token == "verified-schedule-owner" else "invalid"

    doubles = SimpleNamespace(
        clock=Clock(), admission=ScheduleAdmission(), gmail=GmailDouble(), ledger=ledger
    )
    # The ledger checks the time against its own clock; it reads the same one.
    monkeypatch.setattr(delivery_module, "_utcnow", doubles.clock)
    ctx.services.update(
        {
            mail.MAIL_CLOCK_SERVICE: doubles.clock,
            mail.MAIL_ADMISSION_SERVICE: doubles.admission,
            mail.MAIL_DELIVERY_SERVICE: GmailDeliveryService(gmail_service=doubles.gmail),
            "gmail": doubles.gmail,
        }
    )
    return SimpleNamespace(
        ctx=ctx,
        connections=connections,
        executor=ToolExecutor(pending_store=MemoryPendingStore(), actor_proof=prove_owner),
        **vars(doubles),
    )


async def _confirm_ayesha(h) -> None:
    await h.executor.call(
        h.ctx, "resolve_person", {"spoken_name": "Ayesha Sharma", "pool": "connections"}
    )
    confirmed = await h.executor.call(h.ctx, "confirm_person", {"user_id": AYESHA})
    assert confirmed.result.status == "confirmed"


async def _propose(h, *, send_at: str | None = SEND_AT, message: str = MESSAGE, **when: Any):
    args: dict[str, Any] = {
        "recipient": {"user_id": AYESHA},
        "subject": SUBJECT,
        "message": message,
        **when,
    }
    if send_at is not None:
        args["send_at"] = send_at
    return await h.executor.call(h.ctx, "schedule_mail", args)


async def _confirm(h, pending_id: str):
    await h.executor.pending.mark_shown(user_id=OWNER, pending_action_id=pending_id)
    return await h.executor.call(h.ctx, "confirm_pending_action", {"pending_action_id": pending_id})


async def _scheduled(h, **kwargs):
    proposed = await _propose(h, **kwargs)
    assert proposed.result.status == "confirmation_required", proposed.result
    return await _confirm(h, proposed.pending.id)


def _private(*values: Any) -> list[str]:
    return [json.dumps(value) for value in values]


# -- schedule_mail -------------------------------------------------------------------------


@pytest.mark.parametrize(
    "proof, reason",
    [(None, "missing"), ("expired", "invalid"), ("another-owner", "mismatch")],
)
async def test_scheduling_requires_current_owner_proof_before_arming_delivery(h, proof, reason):
    await _confirm_ayesha(h)
    proposed = await _propose(h)
    h.ctx.firebase_id_token = proof

    refused = await _confirm(h, proposed.pending.id)

    assert refused.result.status == "firebase_proof_required"
    assert refused.result.reason_code == f"firebase_proof_{reason}"
    assert h.ledger.rows == {}
    assert proposed.pending.status == "pending"
    # A fresh proof confirms the same card, without requiring a new dictation.
    h.ctx.firebase_id_token = "verified-schedule-owner"  # noqa: S105
    done = await _confirm(h, proposed.pending.id)
    assert done.result.status == "scheduled"
    assert len(h.ledger.rows) == 1


async def test_a_confirmed_schedule_stores_one_sealed_row_and_says_the_owner_local_time(h):
    await _confirm_ayesha(h)

    proposed = await _propose(h)

    assert proposed.result.status == "confirmation_required"
    assert proposed.result.summary == "send this to Ayesha Sharma tomorrow at 9:00 AM IST"
    assert proposed.result.spoken_facts == [
        "I can send this to Ayesha Sharma tomorrow at 9:00 AM IST. Should I go ahead?"
    ]
    row = proposed.pending
    snapshot = row.args[PREPARED_KEY]
    assert snapshot["send_at_iso"] == SEND_AT_UTC.isoformat()
    assert snapshot["send_at_label"] == "Tomorrow, 9:00 AM IST"
    # Nothing is stored before the yes, and the card row holds no plaintext,
    # not even the sending account's id (only an HMAC of it).
    assert h.ledger.rows == {}
    for blob in _private(row.args, row.public(), proposed.result.model_public()):
        for secret in (SUBJECT, MESSAGE, ADDRESS, SENDER_SUB):
            assert secret not in blob

    confirmed = await _confirm(h, row.id)

    result = confirmed.result
    assert result.status == "scheduled"
    assert result.spoken_facts == ["Scheduled to send to Ayesha Sharma tomorrow at 9:00 AM IST."]
    assert result.send_at == SEND_AT_UTC.isoformat()
    assert result.send_at_label == "Tomorrow, 9:00 AM IST"
    assert result.ui_refresh == ["mail"]
    [stored] = h.ledger.rows.values()
    assert (stored["action_id"], stored["state"]) == (result.action_id, "scheduled")
    assert stored["send_at"] == SEND_AT_UTC
    assert stored["expires_at"] == SEND_AT_UTC + timedelta(hours=24)
    assert (stored["recipient_display"], stored["subject"]) == ("Ayesha Sharma", SUBJECT)
    opened = GmailDeliveryService().open_schedule_payload(
        user_id=OWNER, action_id=result.action_id, sealed=stored["payload_sealed"]
    )
    assert opened == {
        "to": ADDRESS,
        "subject": SUBJECT,
        "body": MESSAGE,
        "recipient_user_id": AYESHA,
        "sender_sub": SENDER_SUB,
    }
    # The model, the narration and the retained ledger row never carry the mail.
    for blob in _private(
        result.model_public(),
        result.narratable_digest(),
        confirmed.pending.result,
        confirmed.pending.args,
    ):
        for secret in (SUBJECT, MESSAGE, ADDRESS):
            assert secret not in blob
    assert "_sealed_args" not in confirmed.pending.args


@pytest.mark.parametrize(
    ("send_at", "code"),
    [
        ("2026-10-05T09:00:00+05:30", "schedule_time_in_past"),
        ("2026-12-01T09:00:00+05:30", "schedule_time_too_far"),
        ("tomorrow at 9", "schedule_time_unparseable"),
    ],
)
async def test_an_unschedulable_time_gets_no_card_and_never_reaches_the_ledger(h, send_at, code):
    await _confirm_ayesha(h)

    outcome = await _propose(h, send_at=send_at)

    assert (outcome.result.status, outcome.result.reason_code) == ("rejected", code)
    assert outcome.pending is None
    assert h.ledger.calls == []


async def test_a_naive_time_is_the_owner_wall_clock_not_utc(h):
    await _confirm_ayesha(h)

    outcome = await _propose(h, send_at="2026-10-06T09:00:00")

    assert outcome.result.summary == "send this to Ayesha Sharma tomorrow at 9:00 AM IST"
    assert outcome.pending.args[PREPARED_KEY]["send_at_iso"] == SEND_AT_UTC.isoformat()
    # A yes from a surface that carries no zone (the HTTP card tap builds a UTC
    # context) approves the time the card showed, not 09:00 UTC.
    h.ctx.timezone = "UTC"
    confirmed = await _confirm(h, outcome.pending.id)
    assert confirmed.result.status == "scheduled"
    assert confirmed.result.spoken_facts == [
        "Scheduled to send to Ayesha Sharma tomorrow at 9:00 AM IST."
    ]
    [stored] = h.ledger.rows.values()
    assert stored["send_at"] == SEND_AT_UTC


async def test_a_duration_is_counted_from_the_server_clock_and_pinned_at_the_card(h):
    """ "In 30 minutes", said 25 minutes into a session whose instruction clock
    was built at its start: a send_at computed from that clock would fire 25
    minutes early. send_in_minutes is counted from the server clock at the card,
    and the yes re-checks that pinned instant instead of counting again."""
    await _confirm_ayesha(h)
    h.clock.now = NOW + timedelta(minutes=25)

    proposed = await _propose(h, send_at=None, send_in_minutes=30)

    pinned = NOW + timedelta(minutes=55)
    assert proposed.result.summary == "send this to Ayesha Sharma today at 8:31 PM IST"
    assert proposed.pending.args[PREPARED_KEY]["send_at_iso"] == pinned.isoformat()
    h.clock.now = NOW + timedelta(minutes=35)  # the card waited ten minutes
    confirmed = await _confirm(h, proposed.pending.id)
    assert confirmed.result.status == "scheduled"
    assert confirmed.result.send_at == pinned.isoformat()
    [stored] = h.ledger.rows.values()
    assert stored["send_at"] == pinned

    # A card answered after its pinned instant came within the lead is refused.
    soon = await _propose(h, send_at=None, send_in_minutes=2, message="A second note.")
    h.clock.now += timedelta(seconds=90)
    late = await _confirm(h, soon.pending.id)
    assert late.result.reason_code == "schedule_time_passed"
    assert len(h.ledger.rows) == 1


@pytest.mark.parametrize(
    ("send_at", "when", "code"),
    [
        (None, {}, "schedule_time_missing"),
        (SEND_AT, {"send_in_minutes": 30}, "schedule_time_ambiguous"),
    ],
)
async def test_a_send_needs_exactly_one_of_a_time_or_a_duration(h, send_at, when, code):
    await _confirm_ayesha(h)

    outcome = await _propose(h, send_at=send_at, **when)

    assert (outcome.result.status, outcome.result.reason_code) == ("rejected", code)
    assert outcome.result.spoken_facts[0].endswith("?")
    assert outcome.pending is None
    assert h.ledger.calls == []


async def test_reapproving_after_reconnecting_another_gmail_account_stores_a_new_send(h):
    """The sending account is part of what makes a send the same send: the old
    row would fail closed at the drain, so "already scheduled" would be false."""
    await _confirm_ayesha(h)
    first = await _scheduled(h)
    h.gmail.sender_sub = "google-sub-reconnected"

    again = await _scheduled(h)

    assert again.result.spoken_facts == [
        "Scheduled to send to Ayesha Sharma tomorrow at 9:00 AM IST."
    ]
    assert again.result.action_id != first.result.action_id
    assert len(h.ledger.rows) == 2


@pytest.mark.parametrize("change", ["address", "removed"])
async def test_recipient_drift_between_card_and_yes_schedules_nothing(h, change):
    await _confirm_ayesha(h)
    proposed = await _propose(h)
    if change == "address":
        h.connections.connections[0]["email"] = "someone-else@example.com"
    else:
        h.connections.connections = [c for c in h.connections.connections if c["userId"] != AYESHA]

    confirmed = await _confirm(h, proposed.pending.id)

    assert confirmed.result.reason_code == "recipient_changed"
    assert "I didn't schedule anything" in confirmed.result.spoken_facts[0]
    assert confirmed.pending.status == "failed"
    assert h.ledger.rows == {}


async def test_a_reconnect_to_another_gmail_account_before_the_yes_schedules_nothing(h):
    """The yes approves the account the card was shown for. A send that fires
    weeks later from a different Google account is a different sender."""
    await _confirm_ayesha(h)
    proposed = await _propose(h)
    h.gmail.sender_sub = "google-sub-someone-else"

    confirmed = await _confirm(h, proposed.pending.id)

    assert confirmed.result.reason_code == "sender_account_changed"
    assert confirmed.result.spoken_facts == ["Your Gmail account changed, so I didn't schedule it."]
    assert h.ledger.rows == {}


async def test_a_time_that_passes_while_the_card_waits_is_not_scheduled(h):
    await _confirm_ayesha(h)
    proposed = await _propose(h, send_at="2026-10-05T19:40:00+05:30")
    assert proposed.result.status == "confirmation_required"
    h.clock.now = NOW + timedelta(minutes=3)

    confirmed = await _confirm(h, proposed.pending.id)

    assert confirmed.result.reason_code == "schedule_time_passed"
    assert confirmed.result.spoken_facts == [
        "That time passed while we were talking. Tell me a new time and I'll schedule it."
    ]
    assert h.ledger.rows == {}


async def test_the_same_schedule_confirmed_again_stores_one_row(h):
    await _confirm_ayesha(h)
    first = await _scheduled(h)
    # Asked again in a later conversation: still the same send, not a second one.
    h.ctx.conversation_id = "conv-later"

    again = await _scheduled(h)

    assert again.result.status == "scheduled"
    assert again.result.action_id == first.result.action_id
    assert again.result.spoken_facts == ["That's already scheduled for tomorrow at 9:00 AM IST."]
    assert len(h.ledger.rows) == 1


@pytest.mark.parametrize(
    ("failure", "reason", "fact"),
    [
        (
            "storage",
            "schedule_unavailable",
            "I couldn't schedule that just now. Nothing was scheduled. Please try again.",
        ),
        (
            "seal",
            "schedule_seal_failed",
            "I couldn't prepare that securely. Nothing was scheduled.",
        ),
    ],
)
async def test_scheduled_is_said_only_after_the_row_commits(h, monkeypatch, failure, reason, fact):
    await _confirm_ayesha(h)
    proposed = await _propose(h)
    if failure == "storage":
        h.ledger.fail_with = ConnectionError("database went away")
    else:

        def broken_seal(*_args, **_kwargs):
            raise RuntimeError("kms unavailable")

        monkeypatch.setattr(GmailDeliveryService, "seal_schedule_payload", broken_seal)

    confirmed = await _confirm(h, proposed.pending.id)

    assert (confirmed.result.status, confirmed.result.reason_code) == ("rejected", reason)
    assert confirmed.result.spoken_facts == [fact]
    assert h.ledger.rows == {}


async def test_a_send_that_could_never_fire_is_not_offered(h):
    await _confirm_ayesha(h)
    h.gmail.send_error = GmailApiError("no send", status_code=403, code="GMAIL_SEND_DISABLED")

    outcome = await _propose(h)

    assert outcome.result.reason_code == "send_permission_required"
    assert outcome.pending is None


async def test_the_kill_switch_refuses_honestly_at_the_card_and_on_the_yes(h):
    await _confirm_ayesha(h)
    h.admission.schedule = False
    refused = await _propose(h)
    assert refused.result.reason_code == "voice_mail_schedule_disabled"
    assert refused.result.spoken_facts == ["Scheduling email is switched off for me right now."]
    assert refused.pending is None

    h.admission.schedule = True
    proposed = await _propose(h)
    h.admission.schedule = False
    confirmed = await _confirm(h, proposed.pending.id)
    assert confirmed.result.reason_code == "voice_mail_schedule_disabled"
    assert h.ledger.rows == {}


async def test_turning_mail_reads_off_never_strands_a_scheduled_send(h):
    """Listing and cancelling touch only the ledger, never the mailbox."""
    first, _second = await _listed(h)
    h.admission.reads = False

    listed = await h.executor.call(h.ctx, "list_scheduled_mail", {})
    proposed = await _cancel(h, 1)

    assert listed.result.status == "ok"
    confirmed = await _confirm(h, proposed.pending.id)
    assert confirmed.result.status == "cancelled"
    assert h.ledger.rows[first]["state"] == "cancelled"
    # A new scheduled send still needs mail reads.
    refused = await _propose(h)
    assert (refused.result.reason_code, refused.pending) == ("voice_mail_reads_disabled", None)


async def test_with_the_drain_off_nothing_new_is_scheduled_at_the_card_or_on_the_yes(h):
    """Nothing would ever send it, so it is not accepted."""
    await _confirm_ayesha(h)
    h.admission.drain = False
    refused = await _propose(h)
    assert (refused.result.reason_code, refused.pending) == ("voice_mail_drain_disabled", None)
    assert refused.result.spoken_facts == ["Scheduling isn't available right now."]

    h.admission.drain = True
    proposed = await _propose(h)
    h.admission.drain = False
    confirmed = await _confirm(h, proposed.pending.id)
    assert confirmed.result.reason_code == "voice_mail_drain_disabled"
    assert h.ledger.rows == {}


@pytest.mark.parametrize(
    ("schedule", "drain", "open_"),
    [(False, True, True), (True, False, True), (False, False, False)],
)
async def test_waiting_mail_stays_visible_and_cancellable_while_it_could_still_fire(
    h, schedule, drain, open_
):
    """Scheduling switched off must not hide a send the drain may still fire."""
    first, _second = await _listed(h)
    h.admission.schedule, h.admission.drain = schedule, drain

    listed = await h.executor.call(h.ctx, "list_scheduled_mail", {})
    proposed = await _cancel(h, 1)

    if not open_:
        assert listed.result.reason_code == "voice_mail_schedule_disabled"
        assert (proposed.result.reason_code, proposed.pending) == (
            "voice_mail_schedule_disabled",
            None,
        )
        return
    assert listed.result.status == "ok"
    confirmed = await _confirm(h, proposed.pending.id)
    assert confirmed.result.status == "cancelled"
    assert h.ledger.rows[first]["state"] == "cancelled"


def test_schedule_tools_bind_to_the_gateway_with_spoken_confirmation():
    assert registry.validate_gateway_binding() == []
    schedule = registry.get_tool("schedule_mail")
    assert schedule.policy is ToolPolicy.confirm_voice
    assert schedule.gateway_action_id == "email.chat.turn"
    assert schedule.person_args == ("recipient",)
    assert schedule.private_args == ("subject", "message")
    assert schedule.device_step is False
    assert schedule.prepare is not None
    properties = schedule.declaration()["parameters_json_schema"]["properties"]
    assert set(properties) == {"recipient", "subject", "message", "send_at", "send_in_minutes"}
    # Routing lives in the descriptions the model selects on.
    assert "never send_mail" in schedule.description
    assert "It never sends a Gmail draft." in schedule.description
    # A clock time is the owner's wall clock with no offset (an offset for a
    # date across a daylight-saving change can only be today's); a duration is
    # minutes the server counts.
    assert "without a UTC offset" in schedule.description
    assert "pass send_in_minutes instead" in schedule.description
    assert "e.g. 2026-10-06T09:00:00." in properties["send_at"]["description"]
    assert "+05:30" not in properties["send_at"]["description"]
    assert "Leave send_at out" in properties["send_in_minutes"]["description"]
    assert "a bare 'tomorrow' or 'kal' means 9:00 AM tomorrow" in schedule.description
    # Live eval: "send her the notes tomorrow at nine" chose send_mail with a
    # send_at it does not have in 2 of 6 samples; send_mail now says it has no time.
    assert (
        "It has no time: when they name any later time (tomorrow, at nine, tonight, on Friday), "
        "use schedule_mail instead, even when they say send."
        in registry.get_tool("send_mail").description
    )
    listing = registry.get_tool("list_scheduled_mail")
    assert listing.policy is ToolPolicy.read
    cancel = registry.get_tool("cancel_scheduled_mail")
    assert cancel.policy is ToolPolicy.confirm_voice
    assert cancel.person_args == () and cancel.private_args == ()
    assert cancel.lookup_targets == () and cancel.target_key is not None
    assert set(cancel.declaration()["parameters_json_schema"]["properties"]) == {"ordinal"}


# -- list_scheduled_mail -------------------------------------------------------------------


async def _two_scheduled(h) -> list[str]:
    await _confirm_ayesha(h)
    first = await _scheduled(h)
    second = await _scheduled(h, send_at="2026-10-09T18:30:00+05:30", message="A second note.")
    return [first.result.action_id, second.result.action_id]


async def test_the_list_shows_rows_on_screen_and_gives_the_model_a_count(h):
    action_ids = await _two_scheduled(h)

    listed = await h.executor.call(h.ctx, "list_scheduled_mail", {})

    result = listed.result
    assert result.status == "ok"
    assert result.spoken_facts == [
        "You have 2 scheduled emails. The next one goes out tomorrow at 9:00 AM IST."
    ]
    assert result.model_public() == {
        "status": "ok",
        "coverage": {"returned": 2},
        "spoken_facts": result.spoken_facts,
    }
    for secret in (SUBJECT, "Ayesha", ADDRESS, MESSAGE):
        assert secret not in json.dumps(result.model_public())
    public = result.public()
    assert public["items"] == [
        {
            "source_ref": "scheduled:1",
            "to": "Ayesha Sharma",
            "subject": SUBJECT,
            "send_at": SEND_AT_UTC.isoformat(),
            "send_at_label": "Tomorrow, 9:00 AM IST",
        },
        {
            "source_ref": "scheduled:2",
            "to": "Ayesha Sharma",
            "subject": SUBJECT,
            "send_at": "2026-10-09T13:00:00+00:00",
            "send_at_label": "Friday, 6:30 PM IST",
        },
    ]
    assert public["coverage"] == {"returned": 2, "next_send_at": SEND_AT_UTC.isoformat()}
    assert public["conversation_id"] == h.ctx.conversation_id
    offer = h.ctx.entities.offered_scheduled_mail
    assert offer.action_ids == action_ids
    assert public["offer_revision"] == offer.revision


async def test_an_empty_list_says_so_and_offers_nothing(h):
    listed = await h.executor.call(h.ctx, "list_scheduled_mail", {})

    assert listed.result.status == "empty"
    assert listed.result.spoken_facts == ["You have no scheduled emails."]
    assert listed.result.public()["offer_revision"] is None
    assert h.ctx.entities.offered_scheduled_mail is None


@pytest.mark.parametrize("limit", [1, 25])
async def test_a_short_page_never_speaks_its_length_as_the_total(h, limit):
    """Three waiting, one shown: "you have 1" would be false. The largest page
    is checked too, where the old lookahead was clamped away."""
    await _confirm_ayesha(h)
    for day in range(6, 6 + max(3, limit + 1)):
        await _scheduled(h, send_at=f"2026-10-{day:02d}T09:00:00+05:30")

    listed = await h.executor.call(h.ctx, "list_scheduled_mail", {"limit": limit})

    assert listed.result.coverage["returned"] == limit
    assert len(h.ctx.entities.offered_scheduled_mail.action_ids) == limit
    if limit == 1:
        assert listed.result.spoken_facts == [
            "Here's your next scheduled email; there are more. It goes out tomorrow at 9:00 AM IST."
        ]
    else:
        assert listed.result.spoken_facts == [
            "Here are your next 25 scheduled emails; there are more. "
            "The next one goes out tomorrow at 9:00 AM IST."
        ]


async def test_a_send_already_due_is_said_to_be_late_not_upcoming(h):
    """The drain is paused or behind: "goes out" a time already past is false."""
    _first, second = await _two_scheduled(h)
    h.clock.now = SEND_AT_UTC + timedelta(minutes=5)

    listed = await h.executor.call(h.ctx, "list_scheduled_mail", {})

    assert listed.result.spoken_facts == [
        "You have 2 scheduled emails. The next one was due today at 9:00 AM IST "
        "and hasn't gone out yet."
    ]
    h.ledger.rows[second]["state"] = "cancelled"
    alone = await h.executor.call(h.ctx, "list_scheduled_mail", {})
    assert alone.result.spoken_facts == [
        "You have 1 scheduled email. It was due today at 9:00 AM IST and hasn't gone out yet."
    ]


# -- cancel_scheduled_mail -----------------------------------------------------------------


async def _listed(h) -> list[str]:
    action_ids = await _two_scheduled(h)
    await h.executor.call(h.ctx, "list_scheduled_mail", {})
    return action_ids


async def _cancel(h, ordinal: int):
    return await h.executor.call(h.ctx, "cancel_scheduled_mail", {"ordinal": ordinal})


async def test_cancel_names_the_send_and_flips_only_that_row(h):
    first, second = await _listed(h)

    proposed = await _cancel(h, 2)

    assert (
        proposed.result.summary
        == "cancel the scheduled email to Ayesha Sharma on Friday at 6:30 PM IST"
    )
    assert proposed.pending.args[PREPARED_KEY]["action_id"] == second
    confirmed = await _confirm(h, proposed.pending.id)
    assert confirmed.result.status == "cancelled"
    assert confirmed.result.spoken_facts == ["Cancelled — the email to Ayesha Sharma won't go out."]
    assert h.ledger.rows[second]["state"] == "cancelled"
    assert h.ledger.rows[second]["payload_sealed"] is None
    assert h.ledger.rows[first]["state"] == "scheduled"

    # Asked again: the ledger, not the request, answers -- and no card is shown.
    again = await _cancel(h, 2)
    assert (again.result.status, again.pending) == ("already_cancelled", None)
    assert again.result.spoken_facts == ["That's already cancelled."]


async def test_cancel_then_schedule_the_same_email_for_the_same_time_again(h):
    """Cancel it, then "actually, schedule it again": a new send, said as one."""
    first, _second = await _listed(h)
    proposed = await _cancel(h, 1)
    assert (await _confirm(h, proposed.pending.id)).result.status == "cancelled"

    again = await _scheduled(h)

    assert again.result.status == "scheduled"
    assert again.result.spoken_facts == [
        "Scheduled to send to Ayesha Sharma tomorrow at 9:00 AM IST."
    ]
    assert again.result.action_id != first
    assert h.ledger.rows[again.result.action_id]["state"] == "scheduled"
    assert h.ledger.rows[first]["state"] == "cancelled"


@pytest.mark.parametrize(
    ("state", "status", "fact"),
    [
        ("prepared", "already_sending", "That one is already being sent — I can't stop it now."),
        ("sent", "already_sent", "That one just went out — I couldn't cancel it in time."),
    ],
)
async def test_a_send_that_fires_between_card_and_yes_is_reported_not_cancelled(
    h, state, status, fact
):
    first, _second = await _listed(h)
    proposed = await _cancel(h, 1)
    assert proposed.result.status == "confirmation_required"
    h.ledger.rows[first]["state"] = state  # the drain claimed it first

    confirmed = await _confirm(h, proposed.pending.id)

    assert (confirmed.result.status, confirmed.result.spoken_facts) == (status, [fact])
    assert h.ledger.rows[first]["state"] == state


async def test_cancel_refuses_a_position_it_never_showed_and_a_stale_list(h):
    await _listed(h)

    invented = await _cancel(h, 3)
    assert invented.result.reason_code == "scheduled_mail_ordinal_not_offered"
    assert invented.result.spoken_facts == [
        "I only showed you 2 scheduled emails. Which one did you mean?"
    ]
    assert invented.pending is None

    offer = h.ctx.entities.offered_scheduled_mail
    offer.offered_at = (
        datetime.now(timezone.utc) - timedelta(seconds=OFFER_TTL_SECONDS + 1)
    ).isoformat()
    stale = await _cancel(h, 1)
    assert stale.result.reason_code == "scheduled_mail_offer_expired"
    assert stale.pending is None
    assert all(row["state"] == "scheduled" for row in h.ledger.rows.values())


async def test_an_inbox_list_is_never_a_scheduled_list(h):
    """Separate offers: "cancel the first one" after a mail read names no send."""
    await _two_scheduled(h)
    h.ctx.entities.offer_mail(["msgAlpha", "msgBravo"], account="google-sub", mailbox="inbox")

    outcome = await _cancel(h, 1)

    assert outcome.result.reason_code == "scheduled_mail_offer_expired"
    assert outcome.pending is None


async def test_a_newer_list_retires_a_waiting_cancel_and_targets_by_action(h):
    first, second = await _listed(h)
    proposed = await _cancel(h, 1)
    key = proposed.pending.args[PREPARED_KEY][TARGET_KEY]
    # The first send is cancelled elsewhere; the new list shifts positions.
    h.ledger.rows[first]["state"] = "cancelled"
    await h.executor.call(h.ctx, "list_scheduled_mail", {})

    late_yes = await _confirm(h, proposed.pending.id)

    assert late_yes.result.reason_code == "scheduled_list_changed"
    assert h.ledger.rows[second]["state"] == "scheduled"
    # Position 1 now names a different send, so it is a different target.
    fresh = await _cancel(h, 1)
    assert fresh.pending.args[PREPARED_KEY][TARGET_KEY] != key
    assert fresh.pending.args[PREPARED_KEY]["action_id"] == second


# -- crash recovery ------------------------------------------------------------------------


@pytest.mark.parametrize("tool_name", ["schedule_mail", "cancel_scheduled_mail"])
async def test_a_confirmed_schedule_left_by_a_crash_is_recovered_without_claiming_nothing_happened(
    tool_name,
):
    pending = MemoryPendingStore()
    row, _ = await pending.create(
        user_id=OWNER,
        conversation_id="conv-1",
        tool_name=tool_name,
        gateway_action_id="email.chat.turn",
        tier="voice",
        args={"recipient": {"user_id": AYESHA}, "_sealed_args": "v1:fixture-ciphertext"},
        summary="send this",
    )
    await pending.mark_shown(user_id=OWNER, pending_action_id=row.id)
    await pending.confirm(user_id=OWNER, pending_action_id=row.id, source="voice")
    # Inside the grace window the handler may still be writing its ledger row.
    row.expires_at = (datetime.now(timezone.utc) - timedelta(seconds=30)).isoformat()
    await pending.expire_stale(user_id=OWNER)
    assert row.status == "confirmed"

    row.expires_at = (datetime.now(timezone.utc) - timedelta(seconds=61)).isoformat()
    await pending.expire_stale(user_id="other-owner")
    assert row.status == "confirmed"
    await pending.expire_stale(user_id=OWNER)
    assert row.status == "failed"
    # The insert may have committed: "unconfirmed", never "not scheduled".
    assert row.result == {"status": "schedule_unconfirmed", "needs": None}
    assert row.args == {"recipient": {"user_id": AYESHA}}
