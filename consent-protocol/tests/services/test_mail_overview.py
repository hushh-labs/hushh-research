"""Contract proof for the Mail Overview reads, over actual HTTPX requests.

Synthetic provider-shaped messages only: no network, no real Gmail, no real
secrets. The fake Gmail records every request, so "read-only" and "never
another message" are asserted on what actually went over the wire.
"""

from __future__ import annotations

import functools
import json
from types import SimpleNamespace

import httpx
import pytest

from hushh_mcp.services import gmail_reply_source_service as reply_source
from hushh_mcp.services import mail_overview
from hushh_mcp.services.gmail_metadata_reader import GmailMetadataReader
from hushh_mcp.services.mail_overview import (
    MailOverviewError,
    OverviewMailReader,
    open_source_id,
    seal_source_id,
)
from tests.services.test_gmail_metadata_reader import _full_message, _Gmail, _part, _response

OWNER = "owner"
ACCOUNT = "synthetic-account"  # the fake connection's google_sub
NOW_MS = 1_790_000_000_000


@pytest.fixture(autouse=True)
def _environment(monkeypatch):
    settings = SimpleNamespace(app_signing_key="mail-overview-test-signing-key")
    monkeypatch.setattr(mail_overview, "get_core_security_settings", lambda: settings)
    monkeypatch.setattr(reply_source, "get_core_security_settings", lambda: settings)
    monkeypatch.setattr(mail_overview, "reads_admitted", lambda _user: True)
    for name in ("ONE_VOICE_MAIL_REPLY_ENABLED", "ONE_VOICE_MAIL_READS_ENABLED"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("ONE_VOICE_MAIL_REPLY_ENABLED", "true")


def _meta(
    identity,
    *,
    subject="Project plan",
    sender="Alice <alice@example.com>",
    snippet="Let&#39;s meet   on\nFriday",
    when=NOW_MS,
    labels=("INBOX", "UNREAD"),
):
    headers = []
    if subject is not None:
        headers.append({"name": "Subject", "value": subject})
    if sender is not None:
        headers.append({"name": "From", "value": sender})
    return {
        "id": identity,
        "threadId": f"thread-{identity}",
        "internalDate": str(when),
        "labelIds": list(labels),
        "snippet": snippet,
        "payload": {"headers": headers},
    }


class FakeGmail:
    """Serves list and get calls and records every request it saw."""

    def __init__(self, *, listing=None, messages=None, missing=()):
        self.listing = listing if listing is not None else {"messages": []}
        self.messages = messages or {}
        self.missing = set(missing)
        self.requests: list[httpx.Request] = []

    def handler(self, request):
        self.requests.append(request)
        path = request.url.path
        if path.endswith("/messages"):
            return _response(self.listing)
        identity = path.rsplit("/", 1)[-1]
        if identity in self.missing:
            return _response({"error": {"code": 404}}, status=404)
        return _response(self.messages[identity])

    @property
    def methods(self):
        return {request.method for request in self.requests}

    @property
    def fetched_ids(self):
        return [
            request.url.path.rsplit("/", 1)[-1]
            for request in self.requests
            if not request.url.path.endswith("/messages")
        ]

    def factory(self):
        return functools.partial(OverviewMailReader, transport=httpx.MockTransport(self.handler))

    def plain_factory(self):
        return functools.partial(GmailMetadataReader, transport=httpx.MockTransport(self.handler))


def _kwargs(gmail, fake, **extra):
    return {
        "gmail": gmail,
        "user_id": OWNER,
        "expected_account": None,
        "reader_factory": fake.factory(),
        **extra,
    }


def _serialized(value):
    return json.dumps(value, sort_keys=True)


# --- Source identity ---------------------------------------------------------------


def test_a_source_id_is_stable_account_and_owner_bound_and_hides_the_gmail_id():
    one = seal_source_id(owner_user_id=OWNER, account=ACCOUNT, message_id="message-secret-1")
    assert one == seal_source_id(
        owner_user_id=OWNER, account=ACCOUNT, message_id="message-secret-1"
    )
    assert "message-secret-1" not in one and ACCOUNT not in one
    assert open_source_id(one, owner_user_id=OWNER) == mail_overview.SourceRef(
        account=ACCOUNT, message_id="message-secret-1"
    )
    # Negative controls: another message, another account and another owner differ,
    # and another owner cannot open it at all.
    assert one != seal_source_id(
        owner_user_id=OWNER, account=ACCOUNT, message_id="message-secret-2"
    )
    assert one != seal_source_id(
        owner_user_id=OWNER, account="other", message_id="message-secret-1"
    )
    assert one != seal_source_id(
        owner_user_id="mallory", account=ACCOUNT, message_id="message-secret-1"
    )
    with pytest.raises(MailOverviewError) as foreign:
        open_source_id(one, owner_user_id="mallory")
    assert foreign.value.code == "SOURCE_REF_INVALID"


def test_a_tampered_or_malformed_source_id_fails_closed():
    good = seal_source_id(owner_user_id=OWNER, account=ACCOUNT, message_id="m-1")
    flipped = good[:-2] + ("A" if good[-2] != "A" else "B") + good[-1]
    for bad in (flipped, "ms1.short", "rs1." + good[4:], "message-1", "", good[:-8]):
        with pytest.raises(MailOverviewError) as failure:
            open_source_id(bad, owner_user_id=OWNER)
        assert (failure.value.code, failure.value.status_code) == ("SOURCE_REF_INVALID", 422)


# --- Recent mail and search --------------------------------------------------------


async def test_recent_mail_is_the_newest_inbox_page_with_real_fields_and_no_provider_ids():
    fake = FakeGmail(
        listing={
            "messages": [{"id": "message-3"}, {"id": "message-2"}, {"id": "message-1"}],
            "nextPageToken": "private-next-token",
        },
        messages={
            "message-3": _meta("message-3", subject="Newest", when=NOW_MS),
            "message-2": _meta("message-2", subject="Middle", when=NOW_MS - 60_000),
            "message-1": _meta(
                "message-1",
                subject=None,
                sender=None,
                snippet="",
                labels=("INBOX",),
                when=NOW_MS - 120_000,
            ),
        },
    )
    result = await mail_overview.list_messages(**_kwargs(_Gmail(), fake), query="", limit=5)

    listing = fake.requests[0]
    assert listing.url.params["labelIds"] == "INBOX"
    assert listing.url.params["maxResults"] == "5"
    assert "q" not in listing.url.params and listing.url.params["includeSpamTrash"] == "false"
    assert fake.methods == {"GET"}  # read-only, always
    assert result["account"] == ACCOUNT
    assert result["scope"] == {"kind": "recent", "mailbox": "inbox", "label": "Inbox"}
    # Listing order is preserved: newest first, as the provider returned it.
    assert [row["subject"] for row in result["items"]] == ["Newest", "Middle", None]
    first, _middle, last = result["items"]
    assert first["sender"] == "Alice" and first["unread"] is True
    assert first["received_at"].startswith("2026-")
    # Entities are unescaped and whitespace collapsed; the preview is the source's text.
    assert first["preview"] == "Let's meet on Friday"
    # A missing subject, sender or preview is reported missing, never invented.
    assert (last["subject"], last["sender"], last["preview"], last["unread"]) == (
        None,
        None,
        None,
        False,
    )
    assert result["coverage"] == {"requested": 5, "returned": 3, "more_available": True, "cap": 25}
    # The browser gets opaque ids only.
    rendered = _serialized(result)
    for secret in ("message-3", "message-2", "message-1", "private-next-token", "thread-"):
        assert secret not in rendered


async def test_a_row_keeps_its_id_when_the_list_refreshes_or_reorders():
    messages = {i: _meta(i, subject=f"Mail {i}") for i in ("message-1", "message-2")}
    first = FakeGmail(
        listing={"messages": [{"id": "message-1"}, {"id": "message-2"}]}, messages=messages
    )
    second = FakeGmail(
        listing={"messages": [{"id": "message-2"}, {"id": "message-1"}]}, messages=messages
    )
    before = await mail_overview.list_messages(**_kwargs(_Gmail(), first), query="", limit=5)
    after = await mail_overview.list_messages(**_kwargs(_Gmail(), second), query="", limit=5)

    by_subject = {row["subject"]: row["source_id"] for row in before["items"]}
    assert {row["subject"]: row["source_id"] for row in after["items"]} == by_subject
    assert (
        open_source_id(by_subject["Mail message-2"], owner_user_id=OWNER).message_id == "message-2"
    )


async def test_search_is_an_explicit_provider_query_over_all_mail_with_an_honest_scope():
    fake = FakeGmail(
        listing={"messages": [{"id": "message-1"}]},
        messages={"message-1": _meta("message-1")},
    )
    result = await mail_overview.list_messages(
        **_kwargs(_Gmail(), fake), query="  from:alice invoice  ", limit=25
    )

    params = fake.requests[0].url.params
    assert params["q"] == "from:alice invoice" and params["maxResults"] == "25"
    assert "labelIds" not in params and params["includeSpamTrash"] == "false"
    assert result["scope"] == mail_overview.SEARCH_SCOPE
    assert "Spam and Trash excluded" in result["scope"]["label"]
    # No more pages were reported, so none is claimed; the cap is reported as it is.
    assert result["coverage"] == {
        "requested": 25,
        "returned": 1,
        "more_available": False,
        "cap": 25,
    }

    capped = FakeGmail(
        listing={"messages": [{"id": "message-1"}], "nextPageToken": "x"},
        messages={"message-1": _meta("message-1")},
    )
    limited = await mail_overview.list_messages(**_kwargs(_Gmail(), capped), query="plan", limit=25)
    assert limited["coverage"]["more_available"] is True


async def test_an_oversized_or_out_of_range_request_is_refused_before_any_provider_call():
    fake = FakeGmail()
    for query, limit in (("plan", 26), ("plan", 0), ("x" * 600, 5)):
        with pytest.raises(MailOverviewError) as failure:
            await mail_overview.list_messages(**_kwargs(_Gmail(), fake), query=query, limit=limit)
        assert failure.value.code == "INVALID_REQUEST"
    assert fake.requests == []


# --- Exact open --------------------------------------------------------------------


async def test_two_messages_with_the_same_subject_open_their_own_sources():
    fake = FakeGmail(
        listing={"messages": [{"id": "message-a"}, {"id": "message-b"}]},
        messages={
            "message-a": _meta("message-a", subject="Invoice"),
            "message-b": _meta("message-b", subject="Invoice"),
        },
    )
    rows = (await mail_overview.list_messages(**_kwargs(_Gmail(), fake), query="", limit=5))[
        "items"
    ]
    assert rows[0]["source_id"] != rows[1]["source_id"]

    opener = FakeGmail(
        messages={
            "message-a": _full_message(
                "message-a", [_part("text/plain", "Body of A")], subject="Invoice"
            ),
            "message-b": _full_message(
                "message-b", [_part("text/plain", "Body of B")], subject="Invoice"
            ),
        }
    )
    opened_b = await mail_overview.open_message(
        **_kwargs(_Gmail(), opener), source_id=rows[1]["source_id"]
    )
    assert opened_b["message"]["body"] == "Body of B"
    assert opener.fetched_ids == ["message-b"]  # never message-a, whatever the order was
    opened_a = await mail_overview.open_message(
        **_kwargs(_Gmail(), opener), source_id=rows[0]["source_id"]
    )
    assert opened_a["message"]["body"] == "Body of A"


async def test_opening_is_read_only_and_returns_safe_text_fields():
    message = _full_message("message-1", [_part("text/plain", "Hello there")], subject="Plan")
    fake = FakeGmail(messages={"message-1": message})
    source_id = seal_source_id(owner_user_id=OWNER, account=ACCOUNT, message_id="message-1")

    result = await mail_overview.open_message(**_kwargs(_Gmail(), fake), source_id=source_id)

    assert fake.methods == {"GET"}  # no mark-read, label, archive or delete
    assert len(fake.requests) == 1 and fake.requests[0].url.params["format"] == "full"
    assert result["account"] == ACCOUNT
    assert result["message"] == {
        "source_id": source_id,
        "subject": "Plan",
        "sender": "Alice",
        "received_at": result["message"]["received_at"],
        "unread": False,
        "body": "Hello there",
        "body_truncated": False,
    }
    assert "message-1" not in _serialized(result)

    # The reader's placeholders for an absent subject or sender are reported as missing.
    bare = _full_message("message-1", [_part("text/plain", "Hi")], subject="(no subject)")
    bare["payload"]["headers"] = [h for h in bare["payload"]["headers"] if h["name"] != "From"]
    missing = await mail_overview.open_message(
        **_kwargs(_Gmail(), FakeGmail(messages={"message-1": bare})), source_id=source_id
    )
    assert missing["message"]["subject"] is None and missing["message"]["sender"] is None


async def test_an_id_from_another_account_or_owner_or_a_deleted_message_opens_nothing_else():
    fake = FakeGmail(messages={"message-1": _meta("message-1")}, missing={"message-gone"})
    gmail = _Gmail()

    # Sealed in another Google account: refused before any provider request.
    stale = seal_source_id(owner_user_id=OWNER, account="old-account", message_id="message-1")
    with pytest.raises(MailOverviewError) as moved:
        await mail_overview.open_message(**_kwargs(gmail, fake), source_id=stale)
    assert (moved.value.code, moved.value.status_code) == ("ACCOUNT_CHANGED", 409)

    # The browser's own account differs from the id's: same refusal, no request.
    current = seal_source_id(owner_user_id=OWNER, account=ACCOUNT, message_id="message-1")
    with pytest.raises(MailOverviewError) as browser:
        await mail_overview.open_message(
            **{**_kwargs(gmail, fake), "expected_account": "another-account"}, source_id=current
        )
    assert browser.value.code == "ACCOUNT_CHANGED"

    # Another owner's id, and a tampered one: refused, no request.
    for bad in (
        seal_source_id(owner_user_id="mallory", account=ACCOUNT, message_id="message-1"),
        current[:-3] + "AAA",
    ):
        with pytest.raises(MailOverviewError) as invalid:
            await mail_overview.open_message(**_kwargs(gmail, fake), source_id=bad)
        assert invalid.value.code == "SOURCE_REF_INVALID"
    assert fake.requests == []

    # A message deleted since the list was shown: a typed refusal after exactly one fetch.
    gone = seal_source_id(owner_user_id=OWNER, account=ACCOUNT, message_id="message-gone")
    with pytest.raises(MailOverviewError) as deleted:
        await mail_overview.open_message(**_kwargs(gmail, fake), source_id=gone)
    assert (deleted.value.code, deleted.value.status_code) == ("SOURCE_CHANGED", 410)
    assert fake.fetched_ids == ["message-gone"]


# --- Connection state --------------------------------------------------------------


async def test_connection_states_are_distinct_and_checked_before_any_provider_call():
    fake = FakeGmail()
    cases = []
    gmail = _Gmail()
    gmail.row["status"] = "disconnected"
    cases.append((gmail, "CONNECT_REQUIRED"))
    gmail = _Gmail()
    gmail.row["revoked"] = True
    cases.append((gmail, "RECONNECT_REQUIRED"))
    gmail = _Gmail()
    gmail.row["status"] = "error"
    cases.append((gmail, "RECONNECT_REQUIRED"))
    for gmail, code in cases:
        with pytest.raises(MailOverviewError) as failure:
            await mail_overview.list_messages(**_kwargs(gmail, fake), query="", limit=5)
        assert failure.value.code == code
    # The browser still believes in an account that is no longer the connected one.
    with pytest.raises(MailOverviewError) as switched:
        await mail_overview.list_messages(
            **{**_kwargs(_Gmail(), fake), "expected_account": "previous-account"}, query="", limit=5
        )
    assert switched.value.code == "ACCOUNT_CHANGED"
    assert fake.requests == []


async def test_reads_withdrawn_for_the_owner_are_refused_everywhere(monkeypatch):
    fake = FakeGmail()
    monkeypatch.setattr(mail_overview, "reads_admitted", lambda _user: False)
    source_id = seal_source_id(owner_user_id=OWNER, account=ACCOUNT, message_id="message-1")
    for call in (
        mail_overview.list_messages(**_kwargs(_Gmail(), fake), query="", limit=5),
        mail_overview.open_message(**_kwargs(_Gmail(), fake), source_id=source_id),
        mail_overview.prepare_reply(
            gmail=_Gmail(), user_id=OWNER, source_id=source_id, expected_account=None
        ),
    ):
        with pytest.raises(MailOverviewError) as failure:
            await call
        assert (failure.value.code, failure.value.status_code) == ("MAIL_READS_UNAVAILABLE", 403)
    assert fake.requests == []


# --- Reply -------------------------------------------------------------------------


def _reply_message(identity="message-1", *, sender="Alice <alice@example.com>", labels=("INBOX",)):
    return {
        "id": identity,
        "threadId": "thread-1",
        "internalDate": str(NOW_MS),
        "labelIds": list(labels),
        "payload": {
            "headers": [
                {"name": "From", "value": sender},
                {"name": "Subject", "value": "Project plan"},
                {"name": "Message-ID", "value": "<plan-1@example.com>"},
            ]
        },
    }


async def test_reply_source_is_a_fresh_source_bound_reference_to_the_exact_message():
    fake = FakeGmail(messages={"message-1": _reply_message()})
    source_id = seal_source_id(owner_user_id=OWNER, account=ACCOUNT, message_id="message-1")

    result = await mail_overview.prepare_reply(
        gmail=_Gmail(),
        user_id=OWNER,
        source_id=source_id,
        expected_account=ACCOUNT,
        reader_factory=fake.plain_factory(),
    )

    reply = result["reply"]
    assert (reply["to"], reply["recipient_label"], reply["subject"]) == (
        "alice@example.com",
        "Alice",
        "Re: Project plan",
    )
    assert reply["expires_in_seconds"] == 15 * 60
    # The reference is the delivery routes' own: owner-bound, naming this message and account.
    opened = reply_source.open_reply_source_ref(reply["source_mail_ref"], owner_user_id=OWNER)
    assert (opened.account, opened.message_id, opened.thread_id) == (
        ACCOUNT,
        "message-1",
        "thread-1",
    )
    with pytest.raises(GmailDeliveryErrorType):
        reply_source.open_reply_source_ref(reply["source_mail_ref"], owner_user_id="mallory")
    assert fake.methods == {"GET"} and fake.fetched_ids == ["message-1"]
    assert "thread-1" not in _serialized(result) and "message-1" not in _serialized(result)


async def test_a_reply_is_refused_for_mail_the_owner_sent_and_when_replies_are_off(monkeypatch):
    source_id = seal_source_id(owner_user_id=OWNER, account=ACCOUNT, message_id="message-1")
    sent = FakeGmail(messages={"message-1": _reply_message(labels=("SENT",))})
    with pytest.raises(MailOverviewError) as own:
        await mail_overview.prepare_reply(
            gmail=_Gmail(),
            user_id=OWNER,
            source_id=source_id,
            expected_account=None,
            reader_factory=sent.plain_factory(),
        )
    assert (own.value.code, own.value.status_code) == ("REPLY_TARGET_IS_OWNER", 422)

    # Negative control: the same call for received mail succeeds.
    received = FakeGmail(messages={"message-1": _reply_message()})
    ok = await mail_overview.prepare_reply(
        gmail=_Gmail(),
        user_id=OWNER,
        source_id=source_id,
        expected_account=None,
        reader_factory=received.plain_factory(),
    )
    assert ok["reply"]["to"] == "alice@example.com"

    monkeypatch.setenv("ONE_VOICE_MAIL_REPLY_ENABLED", "false")
    off = FakeGmail()
    with pytest.raises(MailOverviewError) as disabled:
        await mail_overview.prepare_reply(
            gmail=_Gmail(),
            user_id=OWNER,
            source_id=source_id,
            expected_account=None,
            reader_factory=off.plain_factory(),
        )
    assert (disabled.value.code, disabled.value.status_code) == ("MAIL_REPLY_UNAVAILABLE", 403)
    assert off.requests == []


GmailDeliveryErrorType = reply_source.GmailDeliveryError
