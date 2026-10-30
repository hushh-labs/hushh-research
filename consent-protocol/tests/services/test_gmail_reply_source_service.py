"""Contract proof for a reply derived from the email it answers.

Recipient, ``Re:`` subject and thread headers come only from the message's own
routing headers, re-read on every use. The browser carries an opaque,
owner-bound, expiring reference and the body, nothing else. Synthetic
provider-shaped messages only; no network, no real Gmail, no real secrets.
"""

from __future__ import annotations

import base64
import dataclasses
import re
import time
from copy import deepcopy
from types import SimpleNamespace

import pytest

from hushh_mcp.services import gmail_reply_source_service as reply_source
from hushh_mcp.services.gmail_delivery_service import (
    GmailDeliveryError,
    GmailReplyContext,
    _message_for,
    normalize_draft,
)
from hushh_mcp.services.gmail_metadata_reader import GmailMetadataError

OWNER = "owner-uid"
OWNER_EMAIL = "owner@example.com"
ACCOUNT = "google-sub-1"


@pytest.fixture(autouse=True)
def _signing_key(monkeypatch):
    monkeypatch.setattr(
        reply_source,
        "get_core_security_settings",
        lambda: SimpleNamespace(app_signing_key="reply-source-test-signing-key"),
    )


def _message(
    *,
    sender="Alice <alice@example.com>",
    reply_to=None,
    subject="Project plan",
    message_id="<plan-1@example.com>",
    references=None,
    labels=("INBOX", "UNREAD"),
    thread_id="thread-1",
):
    """A provider message as ``GmailMetadataReader.reply_source`` returns it."""
    headers = {
        "From": sender,
        "To": OWNER_EMAIL,
        "Subject": subject,
        "Reply-To": reply_to,
        "Message-ID": message_id,
        "References": references,
    }
    return {
        "id": "message-1",
        "threadId": thread_id,
        "internalDate": "1790000000000",
        "labelIds": list(labels),
        "payload": {
            "headers": [
                {"name": name, "value": value}
                for name, value in headers.items()
                if value is not None
            ]
        },
    }


def _derive(message, *, owner_email=OWNER_EMAIL):
    return reply_source.reply_source_from_message(message, account=ACCOUNT, owner_email=owner_email)


def _refusal(message, *, owner_email=OWNER_EMAIL) -> GmailDeliveryError:
    with pytest.raises(GmailDeliveryError) as failure:
        _derive(message, owner_email=owner_email)
    return failure.value


# --- Who a reply goes to ------------------------------------------------------


def test_reply_to_wins_over_from_and_from_answers_otherwise():
    # A quoted display name with a comma is one person, not two.
    source = _derive(_message(reply_to='"Doe, Jane" <Jane@Example.com>'))
    assert (source.recipient_email, source.recipient_display) == ("jane@example.com", "Doe, Jane")
    source = _derive(_message())
    assert (source.recipient_email, source.recipient_display) == ("alice@example.com", "Alice")


@pytest.mark.parametrize("reply_to", ["not-an-address", "<>", "Jane Doe"])
def test_an_unusable_reply_to_is_refused_and_never_falls_back_to_from(reply_to):
    # Falling through to From would send the reply somewhere its author did not ask for.
    error = _refusal(_message(reply_to=reply_to))
    assert (error.code, error.status_code) == ("REPLY_RECIPIENT_INVALID", 422)
    # Negative control: the same email without a Reply-To is answered at its From.
    assert _derive(_message()).recipient_email == "alice@example.com"


@pytest.mark.parametrize(
    "overrides,code",
    [
        ({"reply_to": "a@example.com, b@example.com"}, "REPLY_TARGET_AMBIGUOUS"),
        # The owner's address, in any case, as the sender or as the reply address.
        ({"sender": "Me <OWNER@Example.com>"}, "REPLY_TARGET_IS_OWNER"),
        ({"sender": "owner@example.com", "reply_to": "bob@example.com"}, "REPLY_TARGET_IS_OWNER"),
        ({"reply_to": "Owner@EXAMPLE.com"}, "REPLY_TARGET_IS_OWNER"),
    ],
    ids=["two_reply_addresses", "from_owner", "from_owner_with_reply_to", "reply_to_owner"],
)
def test_a_reply_never_goes_to_several_people_or_back_to_the_owner(overrides, code):
    error = _refusal(_message(**overrides), owner_email="Owner@Example.COM")
    assert (error.code, error.status_code) == (code, 422)
    # Negative control: someone else's email is answerable for the same owner.
    assert _derive(_message(), owner_email="Owner@Example.COM").recipient_email == (
        "alice@example.com"
    )


@pytest.mark.parametrize(
    "labels,code",
    [
        (["INBOX", "TRASH"], "REPLY_SOURCE_UNAVAILABLE"),
        (["SPAM"], "REPLY_SOURCE_UNAVAILABLE"),
        (["DRAFT"], "REPLY_SOURCE_UNAVAILABLE"),
        # The owner sent it, here from an alias no address comparison can know.
        (["SENT"], "REPLY_TARGET_IS_OWNER"),
        # Negative controls: archived or read mail is still answerable.
        ([], None),
        (["IMPORTANT", "CATEGORY_UPDATES"], None),
    ],
    ids=["trash", "spam", "draft", "sent_from_alias", "archived", "read"],
)
def test_only_received_mail_outside_trash_spam_and_drafts_is_replyable(labels, code):
    message = _message(sender="Alias <alias@other.example>", labels=labels)
    if code is None:
        assert _derive(message).recipient_email == "alias@other.example"
    else:
        assert _refusal(message).code == code


# --- The subject ----------------------------------------------------------------


@pytest.mark.parametrize(
    "original,expected",
    [
        ("Project plan", "Re: Project plan"),
        ("Re: Project plan", "Re: Project plan"),
        ("RE: Project plan", "RE: Project plan"),
        ("re:Project plan", "re:Project plan"),
        ("", "Re:"),
    ],
)
def test_a_reply_subject_gains_exactly_one_re_prefix(original, expected):
    assert _derive(_message(subject=original)).subject == expected


@pytest.mark.parametrize("original", ["x" * 400, "RE: " + "y" * 400], ids=["plain", "re"])
def test_a_long_subject_is_capped_to_what_delivery_accepts(original):
    subject = _derive(_message(subject=original)).subject
    assert len(subject) <= 256
    assert subject.lower().startswith("re: ") and subject[4:] in original
    draft = normalize_draft({"to": ["alice@example.com"], "subject": subject, "body": "Thanks"})
    assert draft.subject == subject
    # Negative control: delivery refuses the original subject as it stands.
    with pytest.raises(GmailDeliveryError):
        normalize_draft({"to": ["alice@example.com"], "subject": original, "body": "Thanks"})


def test_unicode_line_breaks_in_a_subject_are_folded_so_the_reply_can_be_sent():
    original = "Q3\u2028plan\u0085for\x0bthe team"
    source = _derive(_message(subject=original))
    assert source.subject == "Re: Q3 plan for the team"
    draft = normalize_draft(
        {"to": [source.recipient_email], "subject": source.subject, "body": "Thanks"}
    )
    assert _message_for(draft, reply_context=source.reply_context).as_bytes()
    # Negative control: the SMTP policy refuses the unfolded subject only at send,
    # after the person has already reviewed and confirmed the reply.
    unfolded = normalize_draft(
        {"to": [source.recipient_email], "subject": original, "body": "Thanks"}
    )
    with pytest.raises(ValueError):
        _message_for(unfolded).as_bytes()


# --- Header injection -------------------------------------------------------------


@pytest.mark.parametrize(
    "overrides",
    [
        {"sender": "Alice <alice@example.com>\r\nBcc: attacker@example.com"},
        {"reply_to": "alice@example.com\nBcc: attacker@example.com"},
        {"subject": "Plan\r\nBcc: attacker@example.com"},
        {"message_id": "<plan-1@example.com>\nBcc: attacker@example.com"},
        {"references": "<root@example.com>\rBcc: attacker@example.com"},
    ],
    ids=["from", "reply_to", "subject", "message_id", "references"],
)
def test_a_line_break_in_any_routing_header_is_refused(overrides):
    error = _refusal(_message(**overrides))
    assert (error.code, error.status_code) == ("REPLY_HEADERS_INVALID", 409)
    # Negative control: the same email without the line break is answerable.
    assert _derive(_message()).recipient_email == "alice@example.com"


# --- Thread binding ---------------------------------------------------------------


@pytest.mark.parametrize(
    "message_id,references,in_reply_to,chain",
    [
        ("<plan-1@example.com>", None, "<plan-1@example.com>", "<plan-1@example.com>"),
        (
            "<plan-1@example.com>",
            "<r1@example.com> <r2@example.com>",
            "<plan-1@example.com>",
            "<r1@example.com> <r2@example.com> <plan-1@example.com>",
        ),
        (
            "<plan-1@example.com>",
            "<r1@example.com> <plan-1@example.com>",
            "<plan-1@example.com>",
            "<r1@example.com> <plan-1@example.com>",
        ),
        # No usable Message-ID is dropped, not refused: Gmail threads by threadId.
        (None, None, None, None),
        ("plan-1@example.com", None, None, None),
        ("<plän-1@example.com>", None, None, None),
    ],
    ids=["message_id", "appended", "not_repeated", "missing", "no_brackets", "non_ascii"],
)
def test_thread_headers_answer_the_message_itself(message_id, references, in_reply_to, chain):
    context = _derive(_message(message_id=message_id, references=references)).reply_context
    assert context == GmailReplyContext(
        thread_id="thread-1", in_reply_to=in_reply_to, references=chain
    )


@pytest.mark.parametrize(
    "filler", [14, 49], ids=["chain_within_2000_chars", "gmail_length_message_ids"]
)
def test_a_deep_thread_references_chain_is_trimmed_never_refused(filler):
    # Gmail Message-IDs run to about seventy characters, so sixty of them is an
    # ordinary long thread (about 4,000 characters), not an attack.
    chain = [f"<r{index:02d}-{'x' * filler}@example.com>" for index in range(60)]
    context = _derive(
        _message(message_id="<newest@example.com>", references=" ".join(chain))
    ).reply_context
    kept = context.references.split()
    assert len(context.references) <= 1800
    assert kept[0] == chain[0]
    assert kept[-1] == context.in_reply_to == "<newest@example.com>"
    # Between the root and the message itself: the newest run of the original chain.
    assert kept[1:-1] == chain[len(chain) - len(kept[1:-1]) :]


@pytest.mark.parametrize(
    "change,binds",
    [
        ({"reply_to": "bob@example.com"}, True),
        ({"sender": "Mallory <mallory@example.com>"}, True),
        ({"subject": "Project plan v2"}, True),
        ({"message_id": "<plan-2@example.com>"}, True),
        ({"references": "<root@example.com>"}, True),
        # Archiving or reading the email must not void a reply to it.
        ({"labels": ("IMPORTANT",)}, False),
    ],
    ids=["reply_to", "from", "subject", "message_id", "references", "labels_only"],
)
def test_the_fingerprint_binds_routing_headers_and_not_labels(change, binds):
    reviewed = _derive(_message()).fingerprint
    assert (_derive(_message(**change)).fingerprint != reviewed) is binds


# --- The opaque source reference --------------------------------------------------


def _seal(*, owner=OWNER, now=1_000):
    return reply_source.seal_reply_source_ref(_derive(_message()), owner_user_id=owner, now=now)


def _open_refusal(token, *, owner=OWNER, now=1_000, allow_expired=False) -> GmailDeliveryError:
    with pytest.raises(GmailDeliveryError) as failure:
        reply_source.open_reply_source_ref(
            token, owner_user_id=owner, now=now, allow_expired=allow_expired
        )
    return failure.value


def test_a_source_ref_round_trips_for_its_owner_and_names_nothing_in_clear():
    # The longest ids the reader accepts and a long owner id still fit the
    # delivery routes' field, so a reviewed reply is never refused for its size.
    message = _message()
    message["id"] = ("msg" + "0123456789abcdef" * 13)[:200]
    message["threadId"] = ("thr" + "fedcba9876543210" * 13)[:200]
    owner = "owner-" + "u" * 122
    source = _derive(message)
    token = reply_source.seal_reply_source_ref(source, owner_user_id=owner, now=1_000)

    assert token.startswith("rs1.")
    assert len(token) <= reply_source.MAX_SOURCE_REF_CHARS
    assert re.fullmatch(reply_source.SOURCE_REF_PATTERN, token)
    assert reply_source.open_reply_source_ref(
        token, owner_user_id=owner, now=1_000
    ) == reply_source.ReplySourceRef(
        account=ACCOUNT,
        message_id=message["id"],
        thread_id=message["threadId"],
        fingerprint=source.fingerprint,
        expires_at=1_000 + reply_source.SOURCE_REF_TTL_SECONDS,
    )
    body = token.removeprefix("rs1.")
    sealed = base64.urlsafe_b64decode(body + "=" * (-len(body) % 4))
    for private in (
        message["id"],
        message["threadId"],
        ACCOUNT,
        owner,
        source.fingerprint,
        "alice@example.com",
    ):
        assert private not in token
        assert private.encode() not in sealed


def test_a_tampered_or_foreign_ref_fails_closed():
    token = _seal()
    start = len("rs1.")
    # Nonce, ciphertext and tag. The last character is skipped: it may carry
    # only padding bits, so changing it need not change the sealed bytes.
    for index in (start, (start + len(token)) // 2, len(token) - 2):
        flipped = token[:index] + ("A" if token[index] != "A" else "B") + token[index + 1 :]
        assert _open_refusal(flipped).code == "REPLY_SOURCE_REF_INVALID"
    assert _open_refusal(token, owner="another-owner").code == "REPLY_SOURCE_REF_INVALID"
    # Negative control: the untouched ref opens for its owner.
    opened = reply_source.open_reply_source_ref(token, owner_user_id=OWNER, now=1_000)
    assert (opened.account, opened.message_id) == (ACCOUNT, "message-1")


def test_an_expired_ref_is_refused_and_reading_it_back_still_binds_the_owner():
    token = _seal(now=1_000)
    expires_at = 1_000 + reply_source.SOURCE_REF_TTL_SECONDS
    opened = reply_source.open_reply_source_ref(token, owner_user_id=OWNER, now=expires_at)
    assert opened.expires_at == expires_at
    assert _open_refusal(token, now=expires_at + 1).code == "REPLY_SOURCE_REF_EXPIRED"
    # Reading back which thread a settled reply was bound to skips only the clock.
    late = expires_at + 86_400
    settled = reply_source.open_reply_source_ref(
        token, owner_user_id=OWNER, now=late, allow_expired=True
    )
    assert settled.thread_id == "thread-1"
    refused = _open_refusal(token, owner="another-owner", now=late, allow_expired=True)
    assert refused.code == "REPLY_SOURCE_REF_INVALID"


@pytest.mark.parametrize(
    "malform",
    [
        lambda token: None,
        lambda token: "",
        lambda token: "rs2." + token[4:],
        lambda token: token[4:],
        lambda token: token[:-8],
        lambda token: "rs1.%%%%" + token[8:],
        lambda token: token + "A" * (reply_source.MAX_SOURCE_REF_CHARS - len(token) + 1),
    ],
    ids=["none", "empty", "other_version", "no_prefix", "truncated", "off_alphabet", "oversized"],
)
def test_a_malformed_ref_is_refused(malform):
    assert _open_refusal(malform(_seal())).code == "REPLY_SOURCE_REF_INVALID"


# --- Re-reading the source --------------------------------------------------------


async def _allowed():
    return None


class _Connections:
    """The owner's Gmail connection row, as read_reply_source reads it."""

    def __init__(self, **changes):
        self.row = {
            "status": "connected",
            "revoked": False,
            "google_sub": ACCOUNT,
            "google_email": " Owner@Example.com ",
            **changes,
        }
        self.reads = 0

    def _fetch_connection_row(self, *, user_id):
        assert user_id == OWNER
        self.reads += 1
        return deepcopy(self.row)


class _Reader:
    """Stands in for GmailMetadataReader and its factory; records every use."""

    def __init__(self, outcome):
        self.outcome = outcome
        self.created: list[dict] = []
        self.requested: list[str] = []

    def __call__(self, **kwargs):
        self.created.append(kwargs)
        return self

    async def reply_source(self, message_id):
        self.requested.append(message_id)
        if isinstance(self.outcome, BaseException):
            raise self.outcome
        return deepcopy(self.outcome)


async def _read(reader, connections=None, *, expected_account=ACCOUNT):
    return await reply_source.read_reply_source(
        gmail=connections or _Connections(),
        user_id=OWNER,
        message_id="message-1",
        expected_account=expected_account,
        require_access=_allowed,
        reader_factory=reader,
    )


async def _read_refusal(reader, connections=None, **kwargs) -> GmailDeliveryError:
    with pytest.raises(GmailDeliveryError) as failure:
        await _read(reader, connections, **kwargs)
    return failure.value


@pytest.mark.parametrize(
    "expected_account,code",
    [
        ("google-sub-other", "REPLY_ACCOUNT_CHANGED"),
        ("", "REPLY_SOURCE_UNAVAILABLE"),
        (ACCOUNT, None),
    ],
    ids=["other_account", "no_account", "offering_account"],
)
async def test_an_offered_email_is_read_only_in_the_account_it_was_offered_in(
    expected_account, code
):
    connections, reader = _Connections(), _Reader(_message())
    if code is not None:
        error = await _read_refusal(reader, connections, expected_account=expected_account)
        assert error.code == code
        # Refused before any read: an id from one mailbox means nothing in another.
        assert reader.created == [] and reader.requested == []
        return
    # Negative control: the offering account reads exactly that message, and the
    # reader is pinned to the same account for its own fenced session.
    source = await _read(reader, connections)
    assert reader.created == [
        {
            "gmail": connections,
            "user_id": OWNER,
            "require_access": _allowed,
            "expect_account": ACCOUNT,
        }
    ]
    assert reader.requested == ["message-1"]
    assert (source.account, source.recipient_email) == (ACCOUNT, "alice@example.com")


@pytest.mark.parametrize(
    "changes,codes",
    [
        (None, {"GMAIL_NOT_CONNECTED"}),
        ({"status": "disconnected"}, {"GMAIL_NOT_CONNECTED"}),
        # A revoked grant is never used, whichever connection wording it gets.
        ({"revoked": True}, {"GMAIL_NOT_CONNECTED", "GMAIL_READ_PERMISSION_REQUIRED"}),
        # Without the owner's address the self-reply guard cannot run.
        ({"google_email": ""}, {"GMAIL_READ_PERMISSION_REQUIRED"}),
        ({"google_email": None}, {"GMAIL_READ_PERMISSION_REQUIRED"}),
    ],
    ids=["no_connection", "disconnected", "revoked", "empty_email", "missing_email"],
)
async def test_an_unusable_connection_refuses_before_any_read(changes, codes):
    connections = _Connections(**(changes or {}))
    if changes is None:
        connections.row = None
    reader = _Reader(_message())
    assert (await _read_refusal(reader, connections)).code in codes
    assert reader.created == [] and reader.requested == []


async def test_the_connected_address_arms_the_self_reply_guard():
    # Stored with stray case and spacing; the guard still recognises the owner.
    error = await _read_refusal(_Reader(_message(sender="Me <owner@EXAMPLE.com>")))
    assert error.code == "REPLY_TARGET_IS_OWNER"


@pytest.mark.parametrize(
    "failure,code,status",
    [
        (GmailMetadataError("source_changed"), "REPLY_SOURCE_UNAVAILABLE", 409),
        # A refresh or grant re-check racing the read; a different account is
        # refused before the read, by the expected-account check.
        (GmailMetadataError("connection_changed"), "REPLY_SOURCE_RETRYABLE", 503),
        (GmailMetadataError("connect_required"), "GMAIL_NOT_CONNECTED", 409),
        (GmailMetadataError("reconnect_required"), "GMAIL_READ_PERMISSION_REQUIRED", 409),
        (GmailMetadataError("permission_denied"), "GMAIL_READ_PERMISSION_REQUIRED", 409),
        (GmailMetadataError("retryable"), "REPLY_SOURCE_RETRYABLE", 503),
        # Anything unrecognised is retryable: never a success, never a guess.
        (GmailMetadataError("invalid_response"), "REPLY_SOURCE_RETRYABLE", 503),
        # The caller's admission check withdrew the reply mid-read.
        (PermissionError("mail_reply_disabled"), "MAIL_REPLY_UNAVAILABLE", 403),
    ],
    ids=[
        "deleted",
        "connection_changed",
        "connect_required",
        "reconnect_required",
        "permission_denied",
        "retryable",
        "unrecognised",
        "admission_withdrawn",
    ],
)
async def test_reader_failures_become_authored_reply_refusals(failure, code, status):
    error = await _read_refusal(_Reader(failure))
    assert (error.code, error.status_code) == (code, status)
    # Authored text only; nothing from the failure is reflected.
    assert str(failure) not in error.message


def _ref(source, **changes):
    token = reply_source.seal_reply_source_ref(source, owner_user_id=OWNER)
    return dataclasses.replace(
        reply_source.open_reply_source_ref(token, owner_user_id=OWNER), **changes
    )


async def _verify(ref, reader):
    return await reply_source.verified_reply_source(
        gmail=_Connections(),
        user_id=OWNER,
        ref=ref,
        require_access=_allowed,
        reader_factory=reader,
    )


async def test_a_reviewed_reply_still_verifies_after_the_email_is_read_or_archived():
    reviewed = _derive(_message())
    reader = _Reader(_message(labels=()))
    assert await _verify(_ref(reviewed), reader) == reviewed
    assert reader.requested == ["message-1"]


@pytest.mark.parametrize(
    "current,ref_changes",
    [
        ({"reply_to": "mallory@example.com"}, {}),
        ({"subject": "Updated plan"}, {}),
        ({"references": "<other@example.com>"}, {}),
        ({"thread_id": "thread-2"}, {}),
        # A ref naming another thread is refused even when its fingerprint matches.
        ({}, {"thread_id": "thread-2"}),
    ],
    ids=["retargeted", "subject", "references", "thread_moved", "ref_thread"],
)
async def test_an_email_whose_routing_changed_since_review_is_refused(current, ref_changes):
    ref = _ref(_derive(_message()), **ref_changes)
    with pytest.raises(GmailDeliveryError) as failure:
        await _verify(ref, _Reader(_message(**current)))
    assert (failure.value.code, failure.value.status_code) == ("REPLY_SOURCE_CHANGED", 409)


async def test_a_source_bound_reply_takes_only_the_body_from_the_caller():
    original = _message(reply_to='"Doe, Jane" <jane@example.com>', references="<root@example.com>")
    token = reply_source.seal_reply_source_ref(_derive(original), owner_user_id=OWNER)
    reader = _Reader(original)
    envelope, context = await reply_source.resolve_source_bound_reply(
        gmail=_Connections(),
        user_id=OWNER,
        source_mail_ref=token,
        body="Sounds good.",
        html_body="<p>Sounds good.</p>",
        require_access=_allowed,
        reader_factory=reader,
    )
    assert envelope == {
        "to": ["jane@example.com"],
        "cc": [],
        "bcc": [],
        "subject": "Re: Project plan",
        "body": "Sounds good.",
        "html_body": "<p>Sounds good.</p>",
    }
    assert context == GmailReplyContext(
        thread_id="thread-1",
        in_reply_to="<plan-1@example.com>",
        references="<root@example.com> <plan-1@example.com>",
    )
    assert reader.requested == ["message-1"]


@pytest.mark.parametrize(
    "sealed_for,age,code",
    [
        (OWNER, reply_source.SOURCE_REF_TTL_SECONDS + 60, "REPLY_SOURCE_REF_EXPIRED"),
        ("another-owner", 0, "REPLY_SOURCE_REF_INVALID"),
    ],
    ids=["expired", "another_owner"],
)
async def test_a_stale_or_foreign_ref_is_refused_before_any_read(sealed_for, age, code):
    token = reply_source.seal_reply_source_ref(
        _derive(_message()), owner_user_id=sealed_for, now=time.time() - age
    )
    connections, reader = _Connections(), _Reader(_message())
    with pytest.raises(GmailDeliveryError) as failure:
        await reply_source.resolve_source_bound_reply(
            gmail=connections,
            user_id=OWNER,
            source_mail_ref=token,
            body="Sounds good.",
            html_body=None,
            require_access=_allowed,
            reader_factory=reader,
        )
    assert failure.value.code == code
    assert connections.reads == 0
    assert reader.created == [] and reader.requested == []


@pytest.mark.parametrize(
    "sender", ["janedoe+news@gmail.com", "Jane.Doe@googlemail.com", "j.a.n.e.d.o.e@gmail.com"]
)
def test_a_gmail_address_that_reaches_the_owners_inbox_is_the_owner(sender):
    """Gmail ignores dots and a +tag, so each of these delivers to the owner."""
    failure = _refusal(_message(sender=f"Jane <{sender}>"), owner_email="jane.doe@gmail.com")
    assert failure.code == "REPLY_TARGET_IS_OWNER"


def test_dots_and_tags_merge_nothing_outside_gmail():
    """Negative control: elsewhere a dot is part of a different mailbox."""
    source = _derive(
        _message(sender="Jane <janedoe@company.com>"), owner_email="jane.doe@company.com"
    )
    assert source.recipient_email == "janedoe@company.com"
