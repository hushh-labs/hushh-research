"""reply_mail: a reply is addressed by the email it answers, never by the model.

The model names a position (or nothing, for the email on screen) and the
owner's words. The server resolves that against the offer it minted, re-reads
the message with the owner's read grant fenced to the account it was offered
in, and derives the recipient, ``Re:`` subject and thread itself. The card and
the model see a position; only the review card sees the envelope, and only the
owner's Send tap delivers it.

The provider boundary (``GmailMetadataReader``) and the Gmail connection are
doubles injected through ``ToolContext.services``: nothing here touches Gmail.
"""

from __future__ import annotations

import json
import logging
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Any

import pytest

from hushh_mcp.one_voice import private_pending
from hushh_mcp.one_voice.config import (
    ONE_VOICE_MAIL_READS_ENABLED_ENV,
    ONE_VOICE_MAIL_REPLY_ENABLED_ENV,
    OneVoiceMailAdmission,
)
from hushh_mcp.one_voice.tools import mail
from hushh_mcp.one_voice.tools.base import OFFER_TTL_SECONDS, ScreenContext
from hushh_mcp.one_voice.tools.executor import PREPARED_KEY, TARGET_KEY, ToolExecutor
from hushh_mcp.services import gmail_reply_source_service as reply_source
from hushh_mcp.services.gmail_delivery_service import GmailDeliveryError, GmailDeliveryService
from hushh_mcp.services.gmail_metadata_reader import GmailMetadataError
from hushh_mcp.services.gmail_receipts_service import GmailApiError
from tests.one_voice.fakes import MemoryPendingStore
from tests.one_voice.test_tools_people import OWNER, make_ctx

ACCOUNT = "google-sub-owner"
OWNER_EMAIL = "owner@example.com"
# Distinctive on purpose: each may reach the review card and nothing else.
SENDER_NAME = "Quillon Featherstonehaugh"
SENDER_ADDRESS = "quillon@lighthouse-partners.com"
SUBJECT = "Zebra lighthouse merger terms"
OFFERED = ["msgAlphaOne", "msgBravoTwo", "msgCharlieThree"]
NEWER = ["msgDeltaFour", "msgEchoFive", "msgFoxtrotSix"]
# The owner's dictation, with a line break the review card must keep verbatim.
MESSAGE = "Thanks, Thursday at 10 works for me.\n\nSee you then."
MESSAGE_FRAGMENT = "Thursday at 10 works"


def provider_message(
    message_id: str,
    *,
    subject: str = SUBJECT,
    sender: str = f"{SENDER_NAME} <{SENDER_ADDRESS}>",
) -> dict[str, Any]:
    """A Gmail ``format=metadata`` message, as ``GmailMetadataReader.reply_source`` returns it."""
    return {
        "id": message_id,
        "threadId": f"thread{message_id}",
        "labelIds": ["INBOX", "UNREAD"],
        "payload": {
            "headers": [
                {"name": "From", "value": sender},
                {"name": "To", "value": OWNER_EMAIL},
                {"name": "Subject", "value": subject},
                {"name": "Message-ID", "value": f"<{message_id}@mail.lighthouse-partners.com>"},
            ]
        },
    }


class GmailDouble:
    """The owner's Gmail connection: send readiness and the connection row."""

    def __init__(self) -> None:
        self.row: dict[str, Any] = {
            "status": "connected",
            "revoked": False,
            "google_sub": ACCOUNT,
            "google_email": OWNER_EMAIL,
        }
        self.send_error: GmailApiError | None = None

    async def assert_send_ready(self, *, user_id: str) -> None:
        assert user_id == OWNER
        if self.send_error is not None:
            raise self.send_error

    def _fetch_connection_row(self, *, user_id: str) -> dict[str, Any]:
        assert user_id == OWNER
        return dict(self.row)


class ReplyReaderFactory:
    """Stands in for ``GmailMetadataReader`` at the provider boundary.

    Records every reader built and every message asked for. Like the real
    reader, it re-checks the caller's access before it reads.
    """

    def __init__(self) -> None:
        self.messages: dict[str, dict[str, Any]] = {mid: provider_message(mid) for mid in OFFERED}
        self.error: Exception | None = None
        self.before_read: Any = None
        self.built: list[dict[str, Any]] = []
        self.reads: list[str] = []

    def __call__(self, **kwargs: Any) -> _ReaderDouble:
        self.built.append(kwargs)
        return _ReaderDouble(self, kwargs["require_access"])


class _ReaderDouble:
    def __init__(self, factory: ReplyReaderFactory, require_access: Any) -> None:
        self._factory = factory
        self._require_access = require_access

    async def reply_source(self, message_id: str) -> dict[str, Any]:
        if self._factory.before_read is not None:
            self._factory.before_read()
        await self._require_access()
        self._factory.reads.append(message_id)
        if self._factory.error is not None:
            raise self._factory.error
        return deepcopy(self._factory.messages[message_id])


class ReplyAdmission(OneVoiceMailAdmission):
    """Both switches, settable mid-test: a kill switch can flip under a waiting card."""

    def __init__(self) -> None:
        self.reply = True
        self.reads = True

    def mail_reads_enabled(self) -> bool:
        return self.reads

    def mail_reply_enabled(self) -> bool:
        return self.reply


def install_reply_doubles(monkeypatch: pytest.MonkeyPatch, ctx: Any) -> SimpleNamespace:
    """Signing keys, admission and provider doubles for one reply-capable context."""
    settings = SimpleNamespace(app_signing_key="voice-mail-reply-test-signing-key")
    for module in (mail, private_pending, reply_source):
        monkeypatch.setattr(module, "get_core_security_settings", lambda: settings)
    monkeypatch.setattr(mail, "connector_feature_enabled", lambda *_a, **_k: True)
    doubles = SimpleNamespace(
        gmail=GmailDouble(), reader=ReplyReaderFactory(), admission=ReplyAdmission()
    )
    ctx.services.update(
        {
            "gmail": doubles.gmail,
            mail.MAIL_REPLY_READER_SERVICE: doubles.reader,
            mail.MAIL_ADMISSION_SERVICE: doubles.admission,
        }
    )
    return doubles


@pytest.fixture
def reply_harness(monkeypatch):
    async def no_delivery(*_args, **_kwargs):
        raise AssertionError("a voice tool must not call the Gmail delivery pipeline")

    monkeypatch.setattr(GmailDeliveryService, "prepare", no_delivery)
    monkeypatch.setattr(GmailDeliveryService, "execute", no_delivery)
    ctx, _connections, _location = make_ctx()
    doubles = install_reply_doubles(monkeypatch, ctx)
    revision = ctx.entities.offer_mail(OFFERED, account=ACCOUNT, mailbox="inbox")
    return SimpleNamespace(
        ctx=ctx,
        executor=ToolExecutor(pending_store=MemoryPendingStore()),
        revision=revision,
        **vars(doubles),
    )


async def _propose(h, *, ordinal: int | None = 2, message: str = MESSAGE):
    args: dict[str, Any] = {"message": message}
    if ordinal is not None:
        args["ordinal"] = ordinal
    return await h.executor.call(h.ctx, "reply_mail", args)


async def _confirm(h, pending_id: str):
    await h.executor.pending.mark_shown(user_id=OWNER, pending_action_id=pending_id)
    return await h.executor.call(h.ctx, "confirm_pending_action", {"pending_action_id": pending_id})


async def _open_rows(h) -> list[Any]:
    return await h.executor.pending.list_open(user_id=OWNER, conversation_id=h.ctx.conversation_id)


def _assert_scrubbed(row) -> None:
    """A terminal row keeps neither the sealed dictation nor a usable source ref."""
    assert "_sealed_args" not in row.args
    assert "source_mail_ref" not in row.args.get(PREPARED_KEY, {})


# -- the card ------------------------------------------------------------------------------


async def test_reply_card_names_a_position_and_keeps_the_email_server_side(reply_harness):
    h = reply_harness

    outcome = await _propose(h, ordinal=2)

    assert outcome.result.status == "confirmation_required"
    assert outcome.result.tier == "voice"
    assert outcome.result.summary == "prepare a reply to email 2 in your list"
    # The second offered message, re-read for the owner in the account it was offered in.
    assert h.reader.reads == [OFFERED[1]]
    assert [(b["user_id"], b["expect_account"]) for b in h.reader.built] == [(OWNER, ACCOUNT)]
    row = outcome.pending
    assert row is not None and row.summary == outcome.result.summary
    # Negative control: the email's own words reach neither the model, the
    # card, nor the ledger; the dictation is stored only sealed.
    seen = json.dumps(
        [outcome.result.public(), outcome.result.model_public(), row.public(), row.summary]
    )
    stored = json.dumps(row.args)
    for value in (SENDER_NAME, SENDER_ADDRESS, SUBJECT):
        assert value not in seen
        assert value not in stored
    assert MESSAGE_FRAGMENT not in seen and MESSAGE_FRAGMENT not in stored
    assert {key: value for key, value in row.args.items() if not key.startswith("_")} == {
        "ordinal": 2
    }
    assert row.args["_sealed_args"].startswith("v1:")
    prepared = row.args[PREPARED_KEY]
    assert prepared["source_mail_ref"].startswith("rs1.")
    assert isinstance(prepared[TARGET_KEY], str) and prepared[TARGET_KEY]
    # The sealed ref names the second offered message and opens only for its owner.
    sealed = reply_source.open_reply_source_ref(prepared["source_mail_ref"], owner_user_id=OWNER)
    assert (sealed.account, sealed.message_id) == (ACCOUNT, OFFERED[1])
    with pytest.raises(GmailDeliveryError) as foreign:
        reply_source.open_reply_source_ref(prepared["source_mail_ref"], owner_user_id="owner-2")
    assert foreign.value.code == reply_source.REF_INVALID


# -- which email ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("case", "ordinal", "expected", "summary"),
    [
        # The row open on screen, drawn from the current list.
        ("screen_row", None, OFFERED[2], "prepare a reply to the email you opened"),
        # The single email just shown.
        ("single_offer", None, OFFERED[1], "prepare a reply to the email I just showed you"),
        # A spoken position wins over the row on screen.
        ("position_over_screen", 1, OFFERED[0], "prepare a reply to email 1 in your list"),
    ],
)
async def test_reply_targets_the_email_the_person_means(
    reply_harness, case, ordinal, expected, summary
):
    h = reply_harness
    if case == "single_offer":
        h.ctx.entities.offer_mail([OFFERED[1]], account=ACCOUNT, mailbox="inbox")
    else:
        h.ctx.screen = ScreenContext(active_mail_ordinal=3, active_mail_offer_revision=h.revision)

    outcome = await _propose(h, ordinal=ordinal)

    assert outcome.result.status == "confirmation_required"
    assert outcome.result.summary == summary
    assert h.reader.reads == [expected]
    prepared = outcome.pending.args[PREPARED_KEY]
    sealed = reply_source.open_reply_source_ref(prepared["source_mail_ref"], owner_user_id=OWNER)
    assert sealed.message_id == expected


@pytest.mark.parametrize(
    ("case", "ordinal", "reason"),
    [
        # The screen still shows a row from a list that has since been replaced.
        ("stale_screen_row", None, "reply_target_required"),
        ("nothing_offered", None, "reply_target_required"),
        # A position with no list ever shown is not an old list: say so.
        ("never_shown_position", 2, "mail_not_shown"),
        ("expired_offer", 2, "mail_offer_expired"),
        ("position_not_shown", 5, "mail_ordinal_not_offered"),
    ],
)
async def test_reply_refuses_to_guess_which_email(reply_harness, case, ordinal, reason):
    h = reply_harness
    if case == "stale_screen_row":
        h.ctx.screen = ScreenContext(active_mail_ordinal=2, active_mail_offer_revision=h.revision)
        h.ctx.entities.offer_mail(NEWER, account=ACCOUNT, mailbox="inbox")
    elif case in {"nothing_offered", "never_shown_position"}:
        h.ctx.entities.offered_mail = None
    elif case == "expired_offer":
        stale = datetime.now(timezone.utc) - timedelta(seconds=OFFER_TTL_SECONDS + 60)
        h.ctx.entities.offered_mail.offered_at = stale.isoformat()

    outcome = await _propose(h, ordinal=ordinal)

    assert (outcome.result.status, outcome.result.reason_code) == ("rejected", reason)
    assert outcome.pending is None and await _open_rows(h) == []
    assert h.reader.built == [] and h.reader.reads == []


# -- gates ---------------------------------------------------------------------------------


async def test_reply_is_off_until_its_switch_is_set(reply_harness, monkeypatch):
    """Unset means off: the real switch, read from the environment at call time."""
    h = reply_harness
    del h.ctx.services[mail.MAIL_ADMISSION_SERVICE]
    monkeypatch.delenv(ONE_VOICE_MAIL_REPLY_ENABLED_ENV, raising=False)
    monkeypatch.delenv(ONE_VOICE_MAIL_READS_ENABLED_ENV, raising=False)

    refused = await _propose(h)

    assert (refused.result.status, refused.result.reason_code) == (
        "rejected",
        "voice_mail_reply_disabled",
    )
    assert refused.pending is None and await _open_rows(h) == []
    assert h.reader.built == []
    # Negative control: the same request reaches a card once the switch is set.
    monkeypatch.setenv(ONE_VOICE_MAIL_REPLY_ENABLED_ENV, "true")
    allowed = await _propose(h)
    assert allowed.result.status == "confirmation_required"


async def test_a_reply_that_could_never_be_sent_gets_no_card(reply_harness):
    h = reply_harness
    h.gmail.send_error = GmailApiError(
        "Turn on Gmail sending before One can deliver an email.",
        status_code=409,
        code="GMAIL_SEND_DISABLED",
    )

    outcome = await _propose(h)

    assert (outcome.result.status, outcome.result.reason_code) == (
        "rejected",
        "send_permission_required",
    )
    assert outcome.pending is None and await _open_rows(h) == []
    assert h.reader.built == []


@pytest.mark.parametrize(
    ("change", "reason"),
    [
        # Reconnected to another Google account since the list was shown.
        ("account", "mail_account_changed"),
        # The owner's own message: a reply would come back to them.
        ("from_owner", "reply_target_is_owner"),
        # Gmail 404s the message; the reader reports it as source_changed.
        ("gone", "reply_source_unavailable"),
        # The switch is turned off while the source is being read.
        ("withdrawn_mid_read", "voice_mail_reply_disabled"),
    ],
)
async def test_a_source_that_cannot_be_answered_prepares_no_card(reply_harness, change, reason):
    h = reply_harness
    if change == "account":
        h.gmail.row["google_sub"] = "google-sub-another-account"
    elif change == "from_owner":
        h.reader.messages[OFFERED[1]] = provider_message(
            OFFERED[1], sender=f"Owner <{OWNER_EMAIL}>"
        )
    elif change == "gone":
        h.reader.error = GmailMetadataError("source_changed")
    else:
        h.reader.before_read = lambda: setattr(h.admission, "reply", False)

    outcome = await _propose(h)

    assert (outcome.result.status, outcome.result.reason_code) == ("rejected", reason)
    assert outcome.pending is None and await _open_rows(h) == []
    if change == "account":
        # Fenced before any fetch: an id offered in one mailbox is never read in another.
        assert h.reader.built == []


# -- the yes -------------------------------------------------------------------------------


async def test_confirming_re_reads_the_email_and_opens_only_a_review_card(reply_harness):
    h = reply_harness
    card = await _propose(h, ordinal=2)
    prepared_ref = card.pending.args[PREPARED_KEY]["source_mail_ref"]

    opened = await _confirm(h, card.pending.id)

    assert opened.result.status == "draft_open_requested"
    assert opened.result.needs == "client_step"
    # Read again after the yes: the card opens on what the email says now.
    assert h.reader.reads == [OFFERED[1], OFFERED[1]]
    step = opened.result.client_step
    draft = dict(step["draft"])
    fresh_ref = draft.pop("source_mail_ref")
    assert step["kind"] == "open_mail_draft"
    assert draft == {
        "to": SENDER_ADDRESS,
        "to_name": SENDER_NAME,
        "subject": f"Re: {SUBJECT}",
        "body": MESSAGE,
        "mode": "reply",
    }
    # Minted after the re-read, for the same message as the card that was confirmed.
    assert fresh_ref.startswith("rs1.") and fresh_ref != prepared_ref
    fresh = reply_source.open_reply_source_ref(fresh_ref, owner_user_id=OWNER)
    reviewed = reply_source.open_reply_source_ref(prepared_ref, owner_user_id=OWNER)
    assert (fresh.account, fresh.message_id, fresh.thread_id, fresh.fingerprint) == (
        reviewed.account,
        reviewed.message_id,
        reviewed.thread_id,
        reviewed.fingerprint,
    )
    # The model gets a receipt: no recipient, subject, or reference.
    receipt = opened.result.model_public()
    assert set(receipt) == {"status", "needs", "spoken_facts"}
    for value in (SENDER_NAME, SENDER_ADDRESS, SUBJECT, "rs1."):
        assert value not in json.dumps(receipt)
    # The ledger keeps the outcome, never the draft or a usable reference.
    row = opened.pending
    assert row.status == "executed"
    assert row.result == {"status": "draft_open_requested", "needs": "client_step"}
    _assert_scrubbed(row)


@pytest.mark.parametrize(
    ("change", "reason"),
    [
        ("subject", "reply_source_changed"),
        ("account", "mail_account_changed"),
        ("switch_off", "voice_mail_reply_disabled"),
    ],
)
async def test_a_change_after_the_card_opens_no_reply(reply_harness, change, reason):
    h = reply_harness
    card = await _propose(h, ordinal=2)
    if change == "subject":
        h.reader.messages[OFFERED[1]] = provider_message(OFFERED[1], subject=f"{SUBJECT} (revised)")
    elif change == "account":
        h.gmail.row["google_sub"] = "google-sub-another-account"
    else:
        h.admission.reply = False

    outcome = await _confirm(h, card.pending.id)

    assert (outcome.result.status, outcome.result.reason_code) == ("rejected", reason)
    assert "client_step" not in outcome.result.public()
    assert outcome.pending.status == "failed"
    _assert_scrubbed(outcome.pending)
    if change != "subject":
        # Refused before a second read of the mailbox.
        assert h.reader.reads == [OFFERED[1]]


# -- the waiting card ----------------------------------------------------------------------


async def test_a_waiting_reply_is_reused_only_for_the_same_email(reply_harness):
    """Equal arguments about a newer list name a different email. Reusing the
    old card there would open a reply to the email the person no longer means."""
    h = reply_harness
    first = await _propose(h, ordinal=2)
    await h.executor.pending.mark_shown(user_id=OWNER, pending_action_id=first.pending.id)

    again = await _propose(h, ordinal=2)

    assert again.result.status == "confirmation_waiting"
    assert again.result.pending_action_id == first.pending.id
    assert [row.id for row in await _open_rows(h)] == [first.pending.id]
    # Recognised without reading the mailbox again.
    assert h.reader.reads == [OFFERED[1]]

    # Negative control: the same words about a newer list are a new proposal ...
    h.ctx.entities.offer_mail(NEWER, account=ACCOUNT, mailbox="inbox")
    h.reader.messages.update({mid: provider_message(mid) for mid in NEWER})
    newer = await _propose(h, ordinal=2)
    assert newer.result.status == "confirmation_required"
    assert newer.pending.id != first.pending.id
    assert [row.id for row in newer.superseded] == [first.pending.id]
    assert h.executor.pending.rows[first.pending.id].status == "cancelled"
    assert h.reader.reads[-1] == NEWER[1]

    # ... and so are different words about the same email.
    reworded = await _propose(h, ordinal=2, message="Sorry, Thursday no longer works.")
    assert reworded.result.status == "confirmation_required"
    assert reworded.pending.id != newer.pending.id
    assert [row.id for row in reworded.superseded] == [newer.pending.id]


async def test_an_unrelated_person_lookup_keeps_the_reply_card_answerable(reply_harness):
    """A reply names no person, so a lookup made for something else is not a
    correction of it. The default for a tool without person or circle
    arguments would cancel the card on every lookup."""
    h = reply_harness
    card = await _propose(h, ordinal=2)
    await h.executor.pending.mark_shown(user_id=OWNER, pending_action_id=card.pending.id)

    lookup = await h.executor.call(
        h.ctx, "resolve_person", {"spoken_name": "Ayesha Sharma", "pool": "connections"}
    )

    assert lookup.result.status in {"single_likely", "multiple"}
    assert lookup.superseded == []
    assert [row.id for row in await _open_rows(h)] == [card.pending.id]
    late_yes = await h.executor.call(
        h.ctx, "confirm_pending_action", {"pending_action_id": card.pending.id}
    )
    assert late_yes.result.status == "draft_open_requested"


# -- logs ----------------------------------------------------------------------------------


@pytest.fixture
def unredacted_records(monkeypatch, caplog):
    """Records exactly as the code wrote them, whatever ran earlier in this worker.

    Once any test in the worker calls ``install_sensitive_log_filter``, its
    redacting record factory stays process-wide and its filter stays on every
    root handler present then -- including pytest's capture handlers, which live
    for the whole session. Either one masks a whole address argument, the very
    leak this test looks for. The loggers this path writes to are re-enabled for
    the same reason: the assertion must not depend on test order.
    """
    for name in (mail.__name__, "hushh_mcp.one_voice.tools.executor", reply_source.__name__):
        monkeypatch.setattr(logging.getLogger(name), "disabled", False)
    root = logging.getLogger()
    for target in {root, caplog.handler, *root.handlers}:
        monkeypatch.setattr(target, "filters", [])
    previous = logging.getLogRecordFactory()
    logging.setLogRecordFactory(logging.LogRecord)
    yield
    logging.setLogRecordFactory(previous)


async def test_reply_logs_never_carry_the_email_or_its_reference(
    reply_harness, caplog, unredacted_records
):
    h = reply_harness
    caplog.set_level(logging.INFO, logger="hushh_mcp")

    card = await _propose(h, ordinal=2)
    await _propose(h, ordinal=2)  # the waiting card, reused
    opened = await _confirm(h, card.pending.id)
    assert opened.result.status == "draft_open_requested"
    changed = await _propose(h, ordinal=3)
    h.reader.messages[OFFERED[2]] = provider_message(OFFERED[2], subject=f"{SUBJECT} (revised)")
    refused = await _confirm(h, changed.pending.id)
    assert refused.result.reason_code == "reply_source_changed"

    # Capture is live: the refusal and the reuse were both logged.
    assert "one_voice.mail_reply reason=" in caplog.text
    assert "one_voice.pending.reused tool=reply_mail" in caplog.text
    private_values = (
        SUBJECT,
        SENDER_NAME,
        SENDER_ADDRESS,
        MESSAGE_FRAGMENT,
        *OFFERED,
        "rs1.",
        opened.result.client_step["draft"]["source_mail_ref"],
    )
    for value in private_values:
        assert value not in caplog.text


async def test_the_position_an_email_was_read_by_keeps_naming_it(reply_harness):
    """After "read me the second one" the list is that one email, read from position 2.

    Measured on the real Live head: one run in three then asked for
    `reply_mail(ordinal=2)` and was refused "I only showed you 1 message". The
    position it was read by is the one the person still uses, so it names that
    message for a reply and a spoken open alike -- and only that position.
    """
    h = reply_harness
    # The ordinal read's own offer: just the second message, read from position 2.
    h.ctx.entities.offer_mail([OFFERED[1]], account=ACCOUNT, mailbox="inbox", selected_ordinal=2)

    proposal = await _propose(h, ordinal=2)

    assert proposal.result.status == "confirmation_required"
    assert proposal.result.summary == "prepare a reply to email 2 in your list"
    assert h.reader.reads == [OFFERED[1]]
    opened = await h.executor.call(h.ctx, "open_mail", {"ordinal": 2})
    # The surface draws that one email as its first row, so that is what it opens.
    assert (opened.result.status, opened.result.ordinal) == ("mail_open_dispatched", 1)

    # Negative controls: another position from the old list is not on screen,
    # and a fresh list forgets the old position entirely.
    other = await h.executor.call(h.ctx, "open_mail", {"ordinal": 3})
    assert other.result.reason_code == "mail_ordinal_not_offered"
    h.ctx.entities.offer_mail([OFFERED[0]], account=ACCOUNT, mailbox="inbox")
    stale = await h.executor.call(h.ctx, "open_mail", {"ordinal": 2})
    assert stale.result.reason_code == "mail_ordinal_not_offered"


async def test_a_yes_after_a_newer_list_opens_no_reply(reply_harness):
    """The card said "email 2 in your list"; after a new list that names another email.

    The yes is refused rather than read as approving whatever the sentence now
    points at. The confirming test above is the negative control: the same yes
    with the list unchanged opens the review card.
    """
    h = reply_harness
    proposal = await _propose(h, ordinal=2)
    h.ctx.entities.offer_mail(NEWER, account=ACCOUNT, mailbox="inbox")

    confirmed = await _confirm(h, proposal.pending.id)

    assert confirmed.result.reason_code == "reply_list_changed"
    assert "client_step" not in confirmed.result.public()
    # Refused before any provider read: only the proposal's read happened.
    assert h.reader.reads == [OFFERED[1]]
    _assert_scrubbed(confirmed.pending)
