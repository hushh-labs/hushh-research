"""Contract proof for the Mail Overview brief.

Synthetic mail and a stubbed model only: no network, no real Gmail, no secrets.
Two things are proven. First, nothing the model proposes reaches the screen
unless the mail it cites really says it (a quote, a date, a number, a thread,
a direction). Second, "completed" means a recorded successful send that is
found in the connected mailbox, and nothing a draft, an edit or a cancel can do.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from hushh_mcp.services import gmail_metadata_reader, mail_overview, mail_overview_brief
from hushh_mcp.services import gmail_reply_source_service as reply_source
from hushh_mcp.services.mail_overview import MailOverviewError, open_source_id
from hushh_mcp.services.mail_overview_brief import (
    build_brief,
    build_packet,
    completed_items,
    model_prompt,
    parse_stated_date,
    reset_brief_state,
    verify_brief,
)
from tests.services.test_gmail_metadata_reader import _Gmail, _part, _response
from tests.services.test_mail_overview import FakeGmail

OWNER = "owner"
ACCOUNT = "synthetic-account"
NOW = datetime(2026, 11, 26, 9, 0, tzinfo=timezone.utc)


@pytest.fixture(autouse=True)
def _environment(monkeypatch):
    settings = SimpleNamespace(app_signing_key="mail-overview-brief-test-signing-key")
    monkeypatch.setattr(mail_overview, "get_core_security_settings", lambda: settings)
    monkeypatch.setattr(reply_source, "get_core_security_settings", lambda: settings)
    monkeypatch.setattr(mail_overview, "reads_admitted", lambda _user: True)
    monkeypatch.delenv("KAI_MAIL_OVERVIEW_BRIEF_ENABLED", raising=False)
    reset_brief_state()
    yield
    reset_brief_state()


def _ms(year, month, day, hour=10):
    return int(datetime(year, month, day, hour, tzinfo=timezone.utc).timestamp() * 1000)


def _row(
    identity,
    *,
    thread="thread-1",
    direction="received",
    name="Maya Rao",
    address="maya@example.com",
    to="You",
    subject="Brand assets",
    text="Hello",
    day=21,
    attachments=(),
):
    return {
        "message_id": identity,
        "thread_id": thread,
        "direction": direction,
        "from_name": name,
        "from_address": address,
        "to": to,
        "subject": subject,
        "received_at": datetime(2026, 11, day, 10, tzinfo=timezone.utc).isoformat(),
        "unread": False,
        "text": text,
        "attachments": list(attachments),
    }


def _gmail_message(
    identity,
    *,
    thread="thread-1",
    labels=("INBOX",),
    sender="Maya Rao <maya@example.com>",
    to="Owner <owner@example.com>",
    subject="Brand assets",
    text="Hello",
    when=None,
    attachments=(),
):
    parts = [_part("text/plain", text)]
    for index, name in enumerate(attachments):
        parts.append(
            {
                "mimeType": "application/pdf",
                "filename": name,
                "body": {"attachmentId": f"att-{index}", "size": 1200},
            }
        )
    return {
        "id": identity,
        "threadId": thread,
        "internalDate": str(when or _ms(2026, 11, 21)),
        "labelIds": list(labels),
        "payload": {
            "mimeType": "multipart/mixed",
            "headers": [
                {"name": "Subject", "value": subject},
                {"name": "From", "value": sender},
                {"name": "To", "value": to},
            ],
            "parts": parts,
        },
    }


def _verify(raw, rows):
    packet = build_packet(rows, now=NOW)
    return packet, verify_brief(raw, packet, owner_user_id=OWNER, account=ACCOUNT)


def _promise_rows():
    return [
        _row(
            "g-promise",
            thread="th-a",
            subject="Brand assets",
            text="Hi, I will send the final brand assets by 21 Nov. Thanks, Maya",
            day=19,
        )
    ]


def _follow_up(**over):
    item = {
        "kind": "follow_up",
        "thread": "t1",
        "title": "Get the final brand assets",
        "reason": "Maya said she would send them by 21 Nov and nothing has arrived.",
        "context": None,
        "evidence": [{"ref": "m1", "quote": "I will send the final brand assets by 21 Nov"}],
        "due": {"date": "2026-11-21", "date_text": "21 Nov", "role": "promised"},
        "term": None,
        "draft": None,
    }
    item.update(over)
    return item


def _raw(attention=(), updates=()):
    return {"attention": list(attention), "updates": list(updates), "none_reason": ""}


# --- stated dates ------------------------------------------------------------------


def test_only_explicit_day_and_month_phrases_become_dates():
    anchor = datetime(2026, 11, 19).date()
    assert parse_stated_date("by 21 Nov", anchor).isoformat() == "2026-11-21"
    assert parse_stated_date("November 21st", anchor).isoformat() == "2026-11-21"
    assert parse_stated_date("21 November 2027", anchor).isoformat() == "2027-11-21"
    assert parse_stated_date("2026-11-21", anchor).isoformat() == "2026-11-21"
    # A day long before the message means next year, not a date in the past.
    assert parse_stated_date("5 Jan", datetime(2026, 12, 20).date()).isoformat() == "2027-01-05"
    # Never guessed.
    for vague in ("Friday", "next week", "the 3rd", "31 Feb", "soon", "", "12/11"):
        assert parse_stated_date(vague, anchor) is None


# --- attention: what the mail must really say ---------------------------------------


def test_a_supported_follow_up_keeps_the_mails_own_person_date_and_source():
    packet, result = _verify(_raw([_follow_up()]), _promise_rows())

    [item] = result["attention"]
    assert item["kind"] == "follow_up"
    assert item["person"] == "Maya Rao"  # from the message header, not from the model
    assert item["due"] == {
        "date": "2026-11-21",
        "role": "promised",
        "label": "Promised 21 November",
    }
    assert item["action"]["kind"] == "draft_followup"
    # Opaque, owner-bound ids that open the exact message, never a Gmail id.
    source = open_source_id(item["action"]["source_id"], owner_user_id=OWNER)
    assert (source.account, source.message_id) == (ACCOUNT, "g-promise")
    assert item["evidence"][0]["source_id"] == item["action"]["source_id"]
    assert "g-promise" not in json.dumps(item) and "th-a" not in json.dumps(item)


def test_a_quote_the_message_does_not_contain_is_refused():
    rows = _promise_rows()
    for bad in (
        "I promise to send the brand assets on the 21st",  # a paraphrase
        "Hi",  # too short to prove anything
        "I will send the final brand assets by 21 Nov. " + "x" * 400,  # padded past the message
    ):
        _packet, result = _verify(_raw([_follow_up(evidence=[{"ref": "m1", "quote": bad}])]), rows)
        assert result["attention"] == []
        assert result["rejected"]


def test_evidence_from_another_thread_or_an_unknown_ref_is_refused():
    rows = _promise_rows() + [
        _row("g-other", thread="th-b", text="Unrelated note about the offsite agenda", day=20)
    ]
    other = _follow_up(evidence=[{"ref": "m2", "quote": "Unrelated note about the offsite"}])
    unknown = _follow_up(evidence=[{"ref": "m9", "quote": "I will send the final brand assets"}])
    for item in (other, unknown):
        _packet, result = _verify(_raw([item]), rows)
        assert result["attention"] == []


def test_the_first_evidence_message_must_be_one_the_owner_received():
    rows = [
        _row(
            "g-mine",
            thread="th-a",
            direction="sent",
            text="Could you send the final brand assets by 21 Nov please",
            day=19,
        )
    ]
    _packet, result = _verify(
        _raw(
            [_follow_up(evidence=[{"ref": "m1", "quote": "send the final brand assets by 21 Nov"}])]
        ),
        rows,
    )
    assert result["attention"] == []
    assert result["rejected"] == {"primary_not_received": 1}


def test_a_reply_the_owner_already_sent_is_not_still_needed():
    rows = [
        _row(
            "g-ask",
            thread="th-a",
            name="Morgan Lee",
            address="morgan@example.com",
            text="Should the payment term be 30 or 45 days? Please choose.",
            day=20,
        ),
        _row("g-answer", thread="th-a", direction="sent", text="45 days works for us.", day=21),
    ]
    item = {
        "kind": "reply",
        "thread": "t1",
        "title": "Choose the payment term",
        "reason": "Morgan asked which term you prefer.",
        "context": None,
        "evidence": [{"ref": "m2", "quote": "Should the payment term be 30 or 45 days?"}],
        "due": None,
        "term": None,
        "draft": None,
    }
    packet = build_packet(rows, now=NOW)
    ref = next(m.ref for m in packet.messages if m.message_id == "g-ask")
    item["evidence"][0]["ref"] = ref
    result = verify_brief(_raw([item]), packet, owner_user_id=OWNER, account=ACCOUNT)
    assert result["attention"] == []
    assert result["rejected"] == {"already_answered": 1}


def test_a_follow_up_is_dropped_once_the_counterpart_has_written_again():
    rows = _promise_rows() + [
        _row(
            "g-later",
            thread="th-a",
            text="Here are the files, attached.",
            day=22,
            attachments=["assets.zip"],
        )
    ]
    packet = build_packet(rows, now=NOW)
    ref = next(m.ref for m in packet.messages if m.message_id == "g-promise")
    item = _follow_up(
        evidence=[{"ref": ref, "quote": "I will send the final brand assets by 21 Nov"}]
    )
    result = verify_brief(_raw([item]), packet, owner_user_id=OWNER, account=ACCOUNT)
    assert result["attention"] == []
    assert result["rejected"] == {"counterpart_has_written_since": 1}


def test_a_date_the_mail_does_not_state_is_dropped_but_the_item_stays():
    cases = (
        {"date": "2026-11-23", "date_text": "21 Nov", "role": "promised"},  # text names another day
        {"date": "2026-11-21", "date_text": "21 December", "role": "promised"},  # not in the mail
        {"date": "2026-11-21", "date_text": "tomorrow", "role": "promised"},  # not a date
    )
    for due in cases:
        _packet, result = _verify(_raw([_follow_up(due=due)]), _promise_rows())
        [item] = result["attention"]
        assert item["due"] is None


def test_a_term_is_shown_only_when_the_message_states_it_exactly():
    rows = [
        _row(
            "g-ask",
            thread="th-a",
            name="Morgan Lee",
            text="Could you choose a payment term of 30 to 45 days for the contract?",
            day=20,
        )
    ]
    base = {
        "kind": "reply",
        "thread": "t1",
        "title": "Choose the payment term",
        "reason": "Morgan needs a payment term from you.",
        "context": None,
        "evidence": [{"ref": "m1", "quote": "choose a payment term of 30 to 45 days"}],
        "due": None,
        "draft": None,
    }
    _packet, supported = _verify(_raw([{**base, "term": "30 to 45 days"}]), rows)
    _packet, invented = _verify(_raw([{**base, "term": "60 days net"}]), rows)
    assert supported["attention"][0]["term"] == "30 to 45 days"
    assert invented["attention"][0]["term"] is None


def test_a_suggested_draft_cannot_introduce_a_link_or_a_new_number():
    safe = "Could you send the final brand assets when you can? Thank you."
    for text, kept in (
        (safe, True),
        ("Please send them by 30 Nov via https://example.com/upload", False),
        ("We can pay 9,000 on delivery.", False),
        ("Write to me at me@example.com", False),
    ):
        _packet, result = _verify(_raw([_follow_up(draft=text)]), _promise_rows())
        assert (result["attention"][0]["action"]["draft"] == text) is kept


def test_copy_carrying_a_link_or_an_address_is_refused():
    for field in ("title", "reason"):
        for bad in (
            "Open https://evil.example/now",
            "Mail billing@evil.example today",
            "<b>Urgent</b>",
        ):
            _packet, result = _verify(_raw([_follow_up(**{field: bad})]), _promise_rows())
            assert result["attention"] == []


def test_one_item_per_thread_and_the_nearest_due_date_comes_first():
    rows = _promise_rows() + [
        _row(
            "g-b",
            thread="th-b",
            name="Sam",
            address="sam@example.com",
            text="I will send the signed document by 24 Nov, promise.",
            day=20,
        )
    ]
    packet = build_packet(rows, now=NOW)
    refs = {m.message_id: (m.ref, m.thread) for m in packet.messages}
    later = _follow_up(
        thread=refs["g-b"][1],
        title="Get the signed document",
        evidence=[{"ref": refs["g-b"][0], "quote": "I will send the signed document by 24 Nov"}],
        due={"date": "2026-11-24", "date_text": "24 Nov", "role": "promised"},
    )
    earlier = _follow_up(
        thread=refs["g-promise"][1],
        evidence=[
            {"ref": refs["g-promise"][0], "quote": "I will send the final brand assets by 21 Nov"}
        ],
    )
    duplicate = _follow_up(
        thread=refs["g-promise"][1],
        title="Get the assets again",
        evidence=[
            {"ref": refs["g-promise"][0], "quote": "I will send the final brand assets by 21 Nov"}
        ],
    )
    result = verify_brief(
        _raw([later, earlier, duplicate]), packet, owner_user_id=OWNER, account=ACCOUNT
    )
    assert [item["title"] for item in result["attention"]] == [
        "Get the final brand assets",
        "Get the signed document",
    ]
    assert result["rejected"] == {"duplicate_thread": 1}


# --- updates -----------------------------------------------------------------------


def _approval_rows():
    return [
        _row(
            "g-sent",
            thread="th-p",
            direction="sent",
            name="You",
            address="owner@example.com",
            subject="Proposal",
            text="Attached is our proposal for the project scope.",
            day=20,
        ),
        _row(
            "g-yes",
            thread="th-p",
            name="Priya Nair",
            address="priya@example.com",
            subject="Re: Proposal",
            text="Approved. Scope and Rs 2.4 lakh budget confirmed. Thanks, Priya",
            day=22,
        ),
    ]


def _approval(packet, **over):
    ref = {m.message_id: m.ref for m in packet.messages}
    item = {
        "kind": "approval",
        "thread": next(m.thread for m in packet.messages if m.message_id == "g-yes"),
        "title": "Proposal approved",
        "line": "Scope and Rs 2.4 lakh budget confirmed.",
        "before": {"ref": ref["g-sent"], "quote": "Attached is our proposal for the project scope"},
        "after": {"ref": ref["g-yes"], "quote": "Approved. Scope and Rs 2.4 lakh budget confirmed"},
        "action": "thank",
        "draft": "Thank you, Priya.",
    }
    item.update(over)
    return item


def test_an_approval_needs_the_owners_message_and_the_replys_own_words():
    packet = build_packet(_approval_rows(), now=NOW)
    result = verify_brief(
        _raw(updates=[_approval(packet)]), packet, owner_user_id=OWNER, account=ACCOUNT
    )

    [update] = result["updates"]
    assert (update["kind"], update["person"], update["on"]) == (
        "approval",
        "Priya Nair",
        "2026-11-22",
    )
    assert [row["direction"] for row in update["evidence"]] == ["sent", "received"]
    # "Thank Priya" prepares a draft on the approving message itself.
    assert update["action"]["kind"] == "thank"
    assert open_source_id(update["action"]["source_id"], owner_user_id=OWNER).message_id == "g-yes"
    assert update["action"]["draft"] == "Thank you, Priya."


def test_an_approval_without_evidence_of_approval_is_refused():
    packet = build_packet(_approval_rows(), now=NOW)
    ref = {m.message_id: m.ref for m in packet.messages}
    # The model asserts approval, but quotes a message that does not say it.
    paraphrased = _approval(
        packet,
        line="The client accepted the proposal.",  # no number, so only the quote can stop it
        after={"ref": ref["g-yes"], "quote": "The client has accepted the proposal"},
    )
    # Nothing of the owner's was put forward, so there is nothing to approve.
    no_owner_message = _approval(packet, before=None)
    # The "approval" comes from the owner's own message.
    from_owner = _approval(
        packet,
        after={"ref": ref["g-sent"], "quote": "Attached is our proposal for the project"},
        before={"ref": ref["g-sent"], "quote": "Attached is our proposal"},
    )
    for item in (paraphrased, no_owner_message, from_owner):
        result = verify_brief(_raw(updates=[item]), packet, owner_user_id=OWNER, account=ACCOUNT)
        assert result["updates"] == []


def test_a_number_in_an_update_must_come_from_its_quotes():
    packet = build_packet(_approval_rows(), now=NOW)
    inflated = _approval(packet, line="Scope and Rs 3.4 lakh budget confirmed.")
    result = verify_brief(_raw(updates=[inflated]), packet, owner_user_id=OWNER, account=ACCOUNT)
    assert result["updates"] == []
    assert result["rejected"] == {"number_not_in_quote": 1}


def test_a_thank_you_is_offered_only_for_an_approval_or_confirmation():
    rows = [
        _row(
            "g-a",
            thread="th-c",
            direction="sent",
            name="You",
            text="Please confirm the venue date.",
            day=20,
        ),
        _row("g-b", thread="th-c", text="The venue moved the event from 12 Dec to 14 Dec.", day=22),
    ]
    packet = build_packet(rows, now=NOW)
    ref = {m.message_id: (m.ref, m.thread) for m in packet.messages}
    change = {
        "kind": "change",
        "thread": ref["g-b"][1],
        "title": "Event date moved",
        "line": "The event moved from 12 Dec to 14 Dec.",
        "before": {"ref": ref["g-a"][0], "quote": "Please confirm the venue date"},
        "after": {"ref": ref["g-b"][0], "quote": "moved the event from 12 Dec to 14 Dec"},
        "action": "thank",
        "draft": "Thanks!",
    }
    result = verify_brief(_raw(updates=[change]), packet, owner_user_id=OWNER, account=ACCOUNT)
    assert result["updates"][0]["action"] == {"kind": "none", "source_id": None, "draft": None}


def test_an_update_never_repeats_a_thread_already_needing_attention():
    packet = build_packet(
        _promise_rows()
        + [
            _row(
                "g-sent",
                thread="th-a",
                direction="sent",
                name="You",
                text="Thanks for the update.",
                day=18,
            ),
        ],
        now=NOW,
    )
    ref = {m.message_id: (m.ref, m.thread) for m in packet.messages}
    attention = _follow_up(
        thread=ref["g-promise"][1],
        evidence=[
            {"ref": ref["g-promise"][0], "quote": "I will send the final brand assets by 21 Nov"}
        ],
    )
    update = {
        "kind": "received",
        "thread": ref["g-promise"][1],
        "title": "Maya replied",
        "line": "Maya replied about assets.",
        "before": None,
        "after": {"ref": ref["g-promise"][0], "quote": "I will send the final brand assets"},
        "action": "none",
        "draft": None,
    }
    result = verify_brief(_raw([attention], [update]), packet, owner_user_id=OWNER, account=ACCOUNT)
    assert len(result["attention"]) == 1 and result["updates"] == []


def test_a_malformed_model_answer_yields_nothing_rather_than_an_error():
    packet = build_packet(_promise_rows(), now=NOW)
    for raw in (
        {},
        {"attention": "x", "updates": 5},
        {"attention": [None, 3, "s", {}], "updates": [[], {}]},
    ):
        result = verify_brief(raw, packet, owner_user_id=OWNER, account=ACCOUNT)
        assert result["attention"] == [] and result["updates"] == []


# --- the model's packet --------------------------------------------------------------


def test_the_model_sees_aliases_and_text_but_never_a_gmail_or_thread_id():
    packet = build_packet(_promise_rows(), now=NOW)
    prompt = model_prompt(packet)
    assert "g-promise" not in prompt and "th-a" not in prompt
    body = json.loads(prompt)
    assert body["messages"][0]["ref"] == "m1" and body["messages"][0]["thread"] == "t1"
    assert body["messages"][0]["from"] == "Maya Rao"
    assert "final brand assets" in body["messages"][0]["text"]


# --- through the real reader and a mocked Gmail ---------------------------------------


def _mailbox():
    return FakeGmail(
        listing={
            "messages": [{"id": "g-sent"}, {"id": "g-yes"}, {"id": "g-promise"}, {"id": "g-draft"}]
        },
        messages={
            "g-promise": _gmail_message(
                "g-promise",
                thread="th-a",
                subject="Brand assets",
                when=_ms(2026, 11, 19),
                text="Hi, I will send the final brand assets by 21 Nov. Thanks, Maya",
            ),
            "g-sent": _gmail_message(
                "g-sent",
                thread="th-p",
                labels=("SENT",),
                sender="Owner <owner@example.com>",
                to="Priya Nair <priya@example.com>",
                subject="Proposal",
                when=_ms(2026, 11, 20),
                text="Attached is our proposal for the project scope.",
            ),
            "g-yes": _gmail_message(
                "g-yes",
                thread="th-p",
                sender="Priya Nair <priya@example.com>",
                subject="Re: Proposal",
                when=_ms(2026, 11, 22),
                text="Approved. Scope and Rs 2.4 lakh budget confirmed. Thanks, Priya",
            ),
            "g-draft": _gmail_message(
                "g-draft",
                thread="th-d",
                labels=("DRAFT",),
                text="A half written draft nobody has sent",
            ),
        },
    )


async def _brief(fake, runner, **extra):
    prompts = []

    async def run(prompt, user, token):
        prompts.append((prompt, user, token))
        return await runner(prompt)

    result = await build_brief(
        gmail=_Gmail(),
        user_id=OWNER,
        consent_token="vault-token",  # noqa: S106 - synthetic authority fixture
        expected_account=None,
        reader_factory=fake.factory(),
        runner=run,
        clock=lambda: NOW,
        **extra,
    )
    return result, prompts


async def test_the_brief_reads_only_and_returns_verified_items_for_the_connected_mailbox():
    fake = _mailbox()

    async def answer(prompt):
        packet = json.loads(prompt)
        ref = {m["subject"]: m for m in packet["messages"]}
        promise, sent, yes = ref["Brand assets"], ref["Proposal"], ref["Re: Proposal"]
        return _raw(
            [
                _follow_up(
                    thread=promise["thread"],
                    evidence=[
                        {
                            "ref": promise["ref"],
                            "quote": "I will send the final brand assets by 21 Nov",
                        }
                    ],
                )
            ],
            [
                {
                    "kind": "approval",
                    "thread": yes["thread"],
                    "title": "Proposal approved",
                    "line": "Scope and Rs 2.4 lakh budget confirmed.",
                    "before": {
                        "ref": sent["ref"],
                        "quote": "Attached is our proposal for the project scope",
                    },
                    "after": {
                        "ref": yes["ref"],
                        "quote": "Approved. Scope and Rs 2.4 lakh budget confirmed",
                    },
                    "action": "thank",
                    "draft": None,
                }
            ],
        )

    result, prompts = await _brief(fake, answer)

    assert result["account"] == ACCOUNT
    assert [item["title"] for item in result["attention"]] == ["Get the final brand assets"]
    assert [item["title"] for item in result["updates"]] == ["Proposal approved"]
    assert result["coverage"]["messages"] == 3  # the draft is not mail the owner received or sent
    assert fake.methods == {"GET"}
    # The model call got the owner's authority and only the aliased packet.
    [(prompt, user, token)] = prompts
    assert (user, token) == (OWNER, "vault-token")
    for private in (
        "g-promise",
        "g-yes",
        "g-sent",
        "g-draft",
        "thread-",
        "th-a",
        "A half written draft",
    ):
        assert private not in prompt


async def test_the_same_mail_is_not_sent_to_the_model_twice_in_a_row():
    fake = _mailbox()
    calls = []

    async def answer(prompt):
        calls.append(prompt)
        return _raw()

    await _brief(fake, answer)
    await _brief(fake, answer)
    assert len(calls) == 1


async def test_an_empty_window_asks_the_model_nothing():
    fake = FakeGmail(listing={"messages": []})
    calls = []

    async def answer(prompt):
        calls.append(prompt)
        return _raw()

    result, _ = await _brief(fake, answer)
    assert result["attention"] == [] and result["updates"] == [] and calls == []


async def test_the_brief_refuses_a_different_account_and_never_reads_for_it():
    fake = _mailbox()
    with pytest.raises(MailOverviewError) as failure:
        await build_brief(
            gmail=_Gmail(),
            user_id=OWNER,
            consent_token="t",  # noqa: S106 - synthetic authority fixture
            expected_account="another-account",
            reader_factory=fake.factory(),
            runner=lambda *_: None,
            clock=lambda: NOW,
        )
    assert failure.value.code == "ACCOUNT_CHANGED"
    assert fake.requests == []


async def test_a_model_failure_is_a_typed_retryable_error_and_leaves_no_busy_lock():
    fake = _mailbox()

    async def broken(_prompt):
        raise MailOverviewError(
            "BRIEF_UNAVAILABLE", "One can't check your mail right now. Try again.", 503
        )

    with pytest.raises(MailOverviewError) as failure:
        await _brief(fake, broken)
    assert (failure.value.code, failure.value.status_code) == ("BRIEF_UNAVAILABLE", 503)

    async def fine(_prompt):
        return _raw()

    await _brief(_mailbox(), fine)  # the failed attempt did not strand the owner


async def test_the_kill_switch_turns_the_brief_off_without_touching_gmail(monkeypatch):
    monkeypatch.setenv("KAI_MAIL_OVERVIEW_BRIEF_ENABLED", "false")
    fake = _mailbox()
    with pytest.raises(MailOverviewError) as failure:
        await _brief(fake, lambda _p: None)
    assert failure.value.code == "BRIEF_UNAVAILABLE"
    assert fake.requests == []


# --- recently completed --------------------------------------------------------------


def _sent_mailbox():
    return FakeGmail(
        messages={
            "g-real": _gmail_message(
                "g-real",
                labels=("SENT",),
                sender="Owner <owner@example.com>",
                to="Priya Nair <priya@example.com>",
                subject="Re: Pricing sheet",
                when=_ms(2026, 11, 22, 9),
                attachments=("pricing.pdf",),
            ),
            "g-plain": _gmail_message(
                "g-plain",
                labels=("SENT",),
                sender="Owner <owner@example.com>",
                to="Sam Lee <sam@example.com>",
                subject="Quick note",
                when=_ms(2026, 11, 21, 9),
            ),
            "g-draft": _gmail_message(
                "g-draft",
                labels=("DRAFT",),
                sender="Owner <owner@example.com>",
                to="Priya <priya@example.com>",
                subject="Not sent",
                attachments=("secret.pdf",),
            ),
            "g-received": _gmail_message(
                "g-received", labels=("INBOX",), subject="Something that arrived"
            ),
        },
        missing=("g-other-account",),
    )


async def _completed(fake, ids):
    async def recorded(user_id, since, limit):
        assert user_id == OWNER and limit == 10
        return ids

    return await completed_items(
        gmail=_Gmail(),
        user_id=OWNER,
        expected_account=None,
        reader_factory=fake.factory(),
        recorded=recorded,
        clock=lambda: NOW,
    )


async def test_completed_needs_a_recorded_send_found_in_this_mailbox_with_the_sent_label():
    fake = _sent_mailbox()
    result = await _completed(
        fake, ["g-real", "g-draft", "g-received", "g-other-account", "g-plain"]
    )

    assert [item["title"] for item in result["items"]] == [
        "Pricing sheet sent to Priya",
        "Quick note sent to Sam",
    ]
    # A draft, a received message and another account's message are never "completed".
    rendered = json.dumps(result)
    for absent in ("Not sent", "secret.pdf", "Something that arrived"):
        assert absent not in rendered
    # Each item opens the exact sent message, and only reads were made.
    ids = [
        open_source_id(item["source_id"], owner_user_id=OWNER).message_id
        for item in result["items"]
    ]
    assert ids == ["g-real", "g-plain"]
    assert fake.methods == {"GET"}


async def test_an_attachment_is_mentioned_only_when_the_sent_message_has_it():
    result = await _completed(_sent_mailbox(), ["g-real", "g-plain"])
    with_file, without = result["items"]
    assert with_file["line"] == "Attached: pricing.pdf"
    assert without["line"] is None


async def test_no_recorded_send_means_nothing_completed_and_no_mailbox_read():
    fake = _sent_mailbox()
    result = await _completed(fake, [])
    assert result == {"account": ACCOUNT, "items": []}
    assert fake.requests == []


async def test_completed_refuses_a_different_account_before_any_read():
    fake = _sent_mailbox()

    async def recorded(*_args):
        return ["g-real"]

    with pytest.raises(MailOverviewError) as failure:
        await completed_items(
            gmail=_Gmail(),
            user_id=OWNER,
            expected_account="another-account",
            reader_factory=fake.factory(),
            recorded=recorded,
            clock=lambda: NOW,
        )
    assert failure.value.code == "ACCOUNT_CHANGED"
    assert fake.requests == []


def test_only_a_successful_send_record_can_be_listed():
    sql = " ".join(mail_overview_brief._SENT_SQL.split())
    assert "state = 'sent'" in sql
    assert "gmail_message_id IS NOT NULL" in sql
    assert "sent_at IS NOT NULL" in sql
    for other in (
        "prepared",
        "sending",
        "failed",
        "outcome_unknown",
        "expired",
        "cancelled",
        "scheduled",
    ):
        assert other not in sql


async def test_the_send_ledger_query_is_scoped_to_the_owner_and_a_window(monkeypatch):
    seen = {}

    class Conn:
        async def fetch(self, sql, *args):
            seen["args"] = args
            return [
                {"gmail_message_id": "g-real", "sent_at": NOW},
                {"gmail_message_id": "g-real", "sent_at": NOW},
            ]

    class Acquire:
        async def __aenter__(self):
            return Conn()

        async def __aexit__(self, *_):
            return False

    class Pool:
        def acquire(self):
            return Acquire()

    async def pool():
        return Pool()

    monkeypatch.setattr(mail_overview_brief, "get_pool", pool)
    ids = await mail_overview_brief._recorded_sends(OWNER, NOW, 10)
    assert ids == ["g-real"]  # a repeat of one message is one item
    assert seen["args"] == (OWNER, NOW, 10)


# --- a window too large to read in one pass -------------------------------------------


class _HonestListing(FakeGmail):
    """Gmail honors maxResults; the shared fake returns whatever it was given."""

    def handler(self, request):
        if request.url.path.endswith("/messages"):
            self.requests.append(request)
            limit = int(request.url.params.get("maxResults", "100"))
            return _response({"messages": self.listing["messages"][:limit]})
        return super().handler(request)


def _big_mailbox(count=14, size=2600):
    ids = [f"g-{n}" for n in range(count)]
    return _HonestListing(
        listing={"messages": [{"id": identity} for identity in ids]},
        messages={
            identity: _gmail_message(
                identity,
                thread=f"th-{n}",
                subject=f"Note {n}",
                text=("word " * (size // 5)),
                when=_ms(2026, 11, 20, 8 + n % 10),
            )
            for n, identity in enumerate(ids)
        },
    )


async def test_a_window_too_large_to_read_is_read_again_smaller_not_failed(monkeypatch):
    fake = _big_mailbox()
    monkeypatch.setattr(gmail_metadata_reader, "_BODY_BUDGET", 44_000)
    seen = []

    async def answer(prompt):
        seen.append(json.loads(prompt))
        return _raw()

    result, _ = await _brief(fake, answer)

    # The full pass did not fit; the smaller one did, and the answer says how much was really checked.
    assert len(seen) == 1 and len(seen[0]["messages"]) == 10
    assert result["coverage"]["messages"] == 10
    assert result["coverage"]["may_be_partial"] is True
    assert fake.methods == {"GET"}


async def test_a_window_too_large_even_when_small_fails_honestly(monkeypatch):
    fake = _big_mailbox()
    monkeypatch.setattr(gmail_metadata_reader, "_BODY_BUDGET", 6_000)

    async def answer(_prompt):
        raise AssertionError("the model must not run on an unread window")

    with pytest.raises(MailOverviewError) as failure:
        await _brief(fake, answer)
    assert (failure.value.code, failure.value.status_code) == ("BRIEF_UNAVAILABLE", 503)
