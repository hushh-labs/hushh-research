"""Contract proof with actual HTTPX requests and synthetic Gmail metadata."""

from __future__ import annotations

import base64
import json
import logging
from copy import deepcopy
from datetime import datetime, timezone

import httpx
import pytest

from hushh_mcp.services.gmail_metadata_reader import GmailMetadataError, GmailMetadataReader
from hushh_mcp.services.gmail_receipts_service import GmailApiError, GmailReceiptsService
from mcp_modules.log_redaction import SensitiveLogFilter, redact_log_value


class _Gmail(GmailReceiptsService):
    def __init__(self):
        self.row = {
            "status": "connected",
            "revoked": False,
            "google_sub": "synthetic-account",
            "google_email": "owner@example.com",
            "scope_csv": "https://www.googleapis.com/auth/gmail.readonly",
            "token_updated_at": "synthetic-version-1",
            "refresh_token_ciphertext": "synthetic-ciphertext",
            "refresh_token_iv": "synthetic-iv",
            "refresh_token_tag": "synthetic-tag",
        }
        self.marked = []

    def _fetch_connection_row(self, *, user_id):
        assert user_id == "owner"
        return deepcopy(self.row)

    async def _ensure_access_token(self, *, user_id):
        return "synthetic-access", deepcopy(self.row)

    def _mark_connection_needs_reauth(self, *, user_id, message, observed):
        if self._refresh_observation(self.row) != observed:
            raise GmailApiError("changed", status_code=409)
        self.marked.append(message)
        self.row["status"] = "error"
        self.row["revoked"] = True


class _Bytes(httpx.AsyncByteStream):
    def __init__(self, data):
        self.data = data

    async def __aiter__(self):
        yield self.data


def _response(payload, status=200, headers=None):
    return httpx.Response(
        status, stream=_Bytes(json.dumps(payload).encode()), headers=headers or {}
    )


def _message(identity="message-1", subject="Project plan", labels=None, to=None):
    headers = [
        {"name": "Subject", "value": subject},
        {"name": "From", "value": "Alice <alice@example.com>"},
    ]
    if to is not None:
        headers.append({"name": "To", "value": to})
    return {
        "id": identity,
        "threadId": "thread-1",
        "internalDate": str(int(datetime.now(timezone.utc).timestamp() * 1000)),
        "labelIds": ["INBOX"] if labels is None else labels,
        "payload": {
            "headers": headers,
            "body": {"data": "UNEXPECTED_BODY_MUST_NOT_LEAVE"},
        },
        "snippet": "UNEXPECTED_SNIPPET_MUST_NOT_LEAVE",
    }


async def _allowed():
    return None


def _reader(gmail, handler, require_access=_allowed):
    return GmailMetadataReader(
        gmail=gmail,
        user_id="owner",
        require_access=require_access,
        transport=httpx.MockTransport(handler),
    )


async def test_search_is_one_page_metadata_only_and_drops_provider_ids_and_bodies():
    calls = []

    def respond(request):
        calls.append(request)
        assert request.url.host == "gmail.googleapis.com"
        assert request.method == "GET"
        if request.url.path.endswith("/messages"):
            assert request.url.params["labelIds"] == "INBOX"
            assert request.url.params["maxResults"] == "2"
            return _response({"messages": [{"id": "message-1"}], "nextPageToken": "private-next"})
        assert request.url.params["format"] == "metadata"
        assert request.url.params.get_list("metadataHeaders") == ["From", "Subject", "Date"]
        assert "body" not in request.url.params["fields"]
        return _response(_message())

    reader = _reader(_Gmail(), respond)
    result = await reader.read("search_inbox", {"query": "subject:plan", "limit": 2})
    assert len(calls) == 2
    assert result["truncated"] and result["metadata_only"] and result["one_page_only"]
    assert result["untrusted_external_content"][0]["subject"] == "Project plan"
    # Counted here, where the reader knows what it fetched and what survived.
    # Anything downstream would be counting a model's citations instead.
    assert result["coverage"] == {
        "operation": "search_inbox",
        "mailbox": "inbox",
        "scope": "search",
        "unit": "messages",
        "assessed": 1,
        "returned": 1,
        "matches_beyond_page": True,
        "items_omitted": False,
        "content_shortened": False,
        "content_depth": "metadata",
        "one_page_only": True,
    }
    serialized = json.dumps(result)
    assert all(
        secret not in serialized
        for secret in [
            "message-1",
            "thread-1",
            "private-next",
            "UNEXPECTED",
            "synthetic-access",
            "synthetic-account",
        ]
    )
    with pytest.raises(GmailMetadataError, match="read_already_used"):
        await reader.read("search_inbox", {"query": "other"})


async def test_needs_reply_does_not_fetch_invites_or_full_messages():
    calls = []

    def respond(request):
        calls.append(request)
        if request.url.path.endswith("/messages"):
            return _response({"messages": [{"id": "message-1", "threadId": "thread-1"}]})
        assert request.url.path.endswith("/threads/thread-1")
        assert request.url.params["format"] == "metadata"
        return _response({"id": "thread-1", "messages": [_message()]})

    result = await _reader(_Gmail(), respond).read("list_needs_reply", {})
    assert len(calls) == 2
    assert result["untrusted_external_content"][0]["sender"] == "Alice"
    # One row is one conversation here, not one message, so a spoken count built
    # on this must not say "messages". `assessed` is the number of threads the
    # nudge rule evaluated -- a floor, since the listing itself is capped at 25.
    assert result["coverage"]["unit"] == "threads"
    assert result["coverage"]["returned"] == 1
    assert result["coverage"]["assessed"] == 1


async def test_list_recent_reads_newest_inbox_page_without_a_search_expression():
    calls = []

    def respond(request):
        calls.append(request)
        if request.url.path.endswith("/messages"):
            params = request.url.params
            assert "q" not in params
            assert params["labelIds"] == "INBOX"
            assert params["maxResults"] == "2"
            assert params["includeSpamTrash"] == "false"
            return _response(
                {"messages": [{"id": "message-1"}, {"id": "message-2"}], "nextPageToken": "n"}
            )
        assert request.url.params["format"] == "metadata"
        assert "body" not in request.url.params["fields"]
        identity = request.url.path.rsplit("/", 1)[-1]
        return _response(_message(identity))

    result = await _reader(_Gmail(), respond).read("list_recent", {"limit": 2})
    assert len(calls) == 3
    assert result["operation"] == "list_recent"
    assert [item["source_ref"] for item in result["untrusted_external_content"]] == [
        "mail:1",
        "mail:2",
    ]
    # The person asked for exactly the newest two; older mail is not an omission.
    assert result["truncated"] is False
    serialized = json.dumps(result)
    assert "UNEXPECTED_BODY_MUST_NOT_LEAVE" not in serialized
    assert "message-1" not in serialized


async def test_analysis_reads_twelve_bodies_with_bounded_coverage_and_local_thread_refs():
    identities = [f"m-{index}" for index in range(1, 13)]
    calls = []

    def respond(request):
        calls.append(request)
        if request.url.path.endswith("/messages"):
            assert request.url.params["maxResults"] == "12"
            assert request.url.params["q"] == "after:1790395200"
            assert request.url.params["includeSpamTrash"] == "false"
            return _response(
                {
                    "messages": [{"id": identity} for identity in identities],
                    "nextPageToken": "PRIVATE-NEXT-PAGE",
                }
            )
        assert request.url.params["format"] == "full"
        identity = request.url.path.rsplit("/", 1)[-1]
        item = _message(identity)
        item["threadId"] = (
            "private-same-thread" if identity in {"m-1", "m-2"} else f"private-thread-{identity}"
        )
        item["payload"] = {
            "headers": item["payload"]["headers"],
            "mimeType": "text/plain",
            "body": {"data": base64.urlsafe_b64encode(f"Body of {identity}".encode()).decode()},
        }
        return _response(item)

    reader = _reader(_Gmail(), respond)
    result = await reader.read("analyze_mail", {"query": "after:1790395200", "limit": 12})
    rows = result["untrusted_external_content"]
    assert len(calls) == 13
    assert len(rows) == 12
    assert [row["source_ref"] for row in rows] == [f"mail:{n}" for n in range(1, 13)]
    assert rows[0]["body"] == "Body of m-1"
    assert rows[0]["thread_ref"] == rows[1]["thread_ref"] == "thread:1"
    assert rows[2]["thread_ref"] == "thread:2"
    assert reader.offered_message_ids() == tuple(identities)
    assert result["coverage"]["assessed"] == 12
    assert result["coverage"]["returned"] == 12
    assert result["coverage"]["matches_beyond_page"] is True
    assert result["coverage"]["content_depth"] == "message"
    assert result["metadata_only"] is False
    assert result["one_page_only"] is True
    assert "private-same-thread" not in json.dumps(result)
    assert "PRIVATE-NEXT-PAGE" not in json.dumps(result)
    with pytest.raises(GmailMetadataError, match="invalid_argument"):
        await _reader(_Gmail(), respond).read("analyze_mail", {"limit": 13})


async def test_unread_flag_comes_from_labels_without_widening_metadata():
    def respond(request):
        if request.url.path.endswith("/messages"):
            return _response({"messages": [{"id": "m-1"}, {"id": "m-2"}]})
        assert "labelIds" in request.url.params["fields"]
        assert request.url.params.get_list("metadataHeaders") == ["From", "Subject", "Date"]
        identity = request.url.path.rsplit("/", 1)[-1]
        labels = ["INBOX", "UNREAD"] if identity == "m-1" else ["INBOX"]
        return _response(_message(identity, labels=labels))

    result = await _reader(_Gmail(), respond).read("list_recent", {"limit": 2})
    assert [item["unread"] for item in result["untrusted_external_content"]] == [True, False]
    assert result["mailbox"] == "inbox"
    assert all("recipient" not in item for item in result["untrusted_external_content"])
    # Label names other than the unread bit never leave the reader.
    assert "INBOX" not in json.dumps(result["untrusted_external_content"])


@pytest.mark.parametrize("mailbox,label", [("sent", "SENT"), ("anywhere", None)])
async def test_mailbox_scope_sets_the_label_and_sent_mail_names_its_recipient(mailbox, label):
    def respond(request):
        if request.url.path.endswith("/messages"):
            assert request.url.params.get("labelIds") == label
            assert request.url.params["includeSpamTrash"] == "false"
            return _response({"messages": [{"id": "m-1"}]})
        headers = request.url.params.get_list("metadataHeaders")
        assert ("To" in headers) == (mailbox == "sent")
        return _response(
            _message("m-1", labels=[label or "INBOX"], to='"Bo" <bo@example.com>, cy@example.com')
        )

    result = await _reader(_Gmail(), respond).read(
        "search_inbox", {"query": "subject:plan", "mailbox": mailbox}
    )
    item = result["untrusted_external_content"][0]
    assert result["mailbox"] == mailbox
    if mailbox == "sent":
        assert item["recipient"] == "Bo (+1 more)"
    else:
        assert "recipient" not in item
    assert "bo@example.com" not in json.dumps(result)


@pytest.mark.parametrize("labels", ["UNREAD", [1], ["x"] * 101])
async def test_malformed_labels_are_not_read_as_state(labels):
    def respond(request):
        if request.url.path.endswith("/messages"):
            return _response({"messages": [{"id": "m-1"}]})
        return _response(_message("m-1", labels=labels))

    with pytest.raises(GmailMetadataError, match="invalid_response"):
        await _reader(_Gmail(), respond).read("list_recent", {})


async def test_list_recent_is_still_one_bounded_read_per_instance():
    reader = _reader(_Gmail(), lambda _: _response({"messages": []}))
    await reader.read("list_recent", {})
    with pytest.raises(GmailMetadataError, match="read_already_used"):
        await reader.read("list_recent", {})


@pytest.mark.parametrize("mutation", ["disconnect", "account", "reconnect", "refresh"])
async def test_late_result_suppressed_on_any_observation_change(mutation):
    gmail = _Gmail()

    def respond(_request):
        if mutation == "disconnect":
            gmail.row["status"] = "disconnected"
        elif mutation == "account":
            gmail.row["google_sub"] = "other-account"
        else:
            gmail.row["token_updated_at"] = "synthetic-version-2"
        return _response({"messages": []})

    with pytest.raises(GmailMetadataError, match="connection_changed"):
        await _reader(gmail, respond).read("search_inbox", {"query": "invoice"})


async def test_read_can_be_revalidated_after_interpretation():
    gmail = _Gmail()
    reader = _reader(gmail, lambda _: _response({"messages": []}))
    await reader.read("search_inbox", {"query": "invoice"})
    gmail.row["revoked"] = True
    with pytest.raises(GmailMetadataError, match="connection_changed"):
        await reader.require_current()


@pytest.mark.parametrize(
    "status,code",
    [
        (401, "reconnect_required"),
        (403, "permission_denied"),
        (404, "source_changed"),
        (429, "retryable"),
        (503, "retryable"),
        (302, "retryable"),
    ],
)
async def test_provider_failure_is_not_empty_success(status, code):
    gmail = _Gmail()
    reader = _reader(gmail, lambda _: _response({"error": "private-provider-content"}, status))
    with pytest.raises(GmailMetadataError, match=code) as failure:
        await reader.read("search_inbox", {"query": "invoice"})
    assert str(failure.value) == code
    assert bool(gmail.marked) == (status == 401)


async def test_stale_provider_rejection_does_not_disable_new_connection():
    gmail = _Gmail()

    def respond(_request):
        gmail.row["token_updated_at"] = "new-connection"
        return _response({}, 401)

    with pytest.raises(GmailMetadataError, match="connection_changed"):
        await _reader(gmail, respond).read("search_inbox", {"query": "invoice"})
    assert not gmail.marked


@pytest.mark.parametrize(
    "operation,args",
    [
        ("send", {}),
        ("list_receipts", {}),
        ("search_inbox", {"query": ""}),
        ("search_inbox", {"query": "a" * 513}),
        ("search_inbox", {"query": "ok", "endpoint": "https://evil.invalid"}),
        ("list_needs_reply", {"limit": True}),
        ("list_needs_reply", {"limit": 26}),
        ("list_needs_reply", {"limit": -1}),
        # "Last N" is bounded exactly like the other reads and takes no query.
        ("list_recent", {"query": "from:anyone"}),
        ("list_recent", {"limit": 26}),
        ("list_recent", {"limit": 0}),
        ("list_recent", {"limit": "10"}),
        # Mailbox scope is a closed set, and needs-reply is inbox-only.
        ("list_recent", {"mailbox": "spam"}),
        ("search_inbox", {"query": "ok", "mailbox": "trash"}),
        ("list_needs_reply", {"mailbox": "sent"}),
        ("list_needs_reply", {"mailbox": "anywhere"}),
    ],
)
async def test_arbitrary_operations_arguments_and_limits_rejected_before_io(operation, args):
    def forbidden(_request):
        pytest.fail("Must not make a provider call")

    with pytest.raises(GmailMetadataError, match="invalid_argument"):
        await _reader(_Gmail(), forbidden).read(operation, args)


async def test_owner_authority_rechecked_and_refusal_never_reaches_provider():
    async def deny():
        raise PermissionError("owner_required")

    with pytest.raises(PermissionError, match="owner_required"):
        await _reader(_Gmail(), lambda _: pytest.fail("provider called"), deny).read(
            "list_needs_reply", {}
        )


@pytest.mark.parametrize(
    "row,code",
    [
        (None, "connect_required"),
        ({"status": "disconnected"}, "connect_required"),
        ({"status": "error", "revoked": True}, "reconnect_required"),
    ],
)
async def test_missing_and_rejected_grants_are_truthful(row, code):
    gmail = _Gmail()
    gmail.row = row
    with pytest.raises(GmailMetadataError, match=code):
        await _reader(gmail, lambda _: pytest.fail("provider called")).read("list_needs_reply", {})


async def test_transport_response_budget_and_encoding_fail_closed():
    with pytest.raises(GmailMetadataError, match="response_too_large"):
        await _reader(_Gmail(), lambda _: _response({"padding": "x" * (256 * 1024)})).read(
            "list_needs_reply", {}
        )
    with pytest.raises(GmailMetadataError, match="invalid_response"):
        await _reader(_Gmail(), lambda _: _response({}, headers={"content-encoding": "gzip"})).read(
            "list_needs_reply", {}
        )


async def test_provider_cannot_supply_a_path_or_cross_message_identity():
    for payload in ({"messages": [{"id": "../../profile"}]}, {"messages": "bad"}):
        with pytest.raises(GmailMetadataError, match="invalid_response"):
            await _reader(_Gmail(), lambda _, payload=payload: _response(payload)).read(
                "search_inbox", {"query": "invoice"}
            )


def test_gmail_log_redaction_handles_httpx_urls_and_structured_provider_identifiers():
    query_url = httpx.URL(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages?q=private-inbox-query&pageToken=private-page"
    )
    private_url = httpx.URL(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/private-message/attachments/private-attachment"
    )
    record = logging.LogRecord(
        "httpx", logging.INFO, "fixture", 1, "HTTP %s %s", (query_url, private_url), None
    )
    SensitiveLogFilter().filter(record)
    message = record.getMessage()
    assert all(
        value not in message
        for value in [
            "private-inbox-query",
            "private-page",
            "private-message",
            "private-attachment",
        ]
    )
    assert redact_log_value(
        {"gmail_message_id": "private", "thread_id": "private", "query": "private"}
    ) == {"gmail_message_id": "[REDACTED]", "thread_id": "[REDACTED]", "query": "[REDACTED]"}


async def test_provider_over_return_cannot_exceed_requested_limit():
    def respond(_request):
        return _response({"messages": [{"id": "message-1"}, {"id": "message-2"}]})

    with pytest.raises(GmailMetadataError, match="invalid_response"):
        await _reader(_Gmail(), respond).read("search_inbox", {"query": "invoice", "limit": 1})


@pytest.mark.parametrize(
    "invalid",
    [
        {"payload": None},
        {"payload": {"headers": "bad"}},
        {"payload": {"headers": [None]}},
        {"internalDate": "9" * 100},
    ],
)
async def test_malformed_nested_metadata_fails_with_authored_error(invalid):
    def respond(request):
        if request.url.path.endswith("/messages"):
            return _response({"messages": [{"id": "message-1"}]})
        return _response({**_message(), **invalid})

    with pytest.raises(GmailMetadataError, match="invalid_response"):
        await _reader(_Gmail(), respond).read("search_inbox", {"query": "invoice"})


def _b64(text, encoding="utf-8"):
    import base64

    return base64.urlsafe_b64encode(text.encode(encoding)).decode().rstrip("=")


def _full_message(identity, parts, subject="Plan"):
    return {
        "id": identity,
        "threadId": "thread-1",
        "internalDate": "1790000000000",
        "labelIds": ["INBOX"],
        "payload": {
            "mimeType": "multipart/mixed",
            "headers": [
                {"name": "Subject", "value": subject},
                {"name": "From", "value": "Alice <alice@example.com>"},
            ]
            + [{"name": "Received", "value": "hop"}] * 30,
            "parts": parts,
        },
    }


def _part(mime, text, filename="", charset=None):
    headers = [{"name": "Content-Type", "value": f"{mime}; charset={charset}"}] if charset else []
    return {
        "mimeType": mime,
        "filename": filename,
        "headers": headers,
        "body": {"data": _b64(text, charset or "utf-8")},
    }


async def test_body_read_prefers_plain_text_skips_attachments_and_requests_full_format():
    def respond(request):
        if request.url.path.endswith("/messages"):
            assert request.url.params["q"] == "from:alice"
            assert request.url.params["maxResults"] == "1"
            return _response({"messages": [{"id": "m-1"}], "nextPageToken": "more"})
        assert request.url.params["format"] == "full"
        return _response(
            _full_message(
                "m-1",
                [
                    {
                        "mimeType": "multipart/alternative",
                        "parts": [
                            _part("text/plain", "Hi,\r\n\r\nThe plan is ready.", charset="utf-8"),
                            _part("text/html", "<p>HTML twin must not win</p>"),
                        ],
                    },
                    _part("text/plain", "ATTACHMENT_TEXT_MUST_NOT_LEAVE", filename="notes.txt"),
                ],
            )
        )

    result = await _reader(_Gmail(), respond).read(
        "read_message", {"query": "from:alice", "limit": 1}
    )
    item = result["untrusted_external_content"][0]
    assert item["body"] == "Hi,\n\nThe plan is ready."
    assert item["body_truncated"] is False
    assert result["metadata_only"] is False
    # The newest match was asked for; later matches are not an omission.
    assert result["truncated"] is False
    serialized = json.dumps(result)
    assert all(v not in serialized for v in ["ATTACHMENT_TEXT", "HTML twin", "m-1", "more"])


async def test_body_read_falls_back_to_html_text_and_caps_size():
    markup = (
        "<html><head><style>.x{}</style><script>steal()</script></head>"
        "<body><p>Café invoice</p><a href='https://evil.invalid'>pay</a>"
        + "<div>line</div>" * 5000
        + "</body></html>"
    )

    def respond(request):
        if request.url.path.endswith("/messages"):
            assert "q" not in request.url.params
            return _response({"messages": [{"id": "m-1"}]})
        return _response(_full_message("m-1", [_part("text/html", markup, charset="latin-1")]))

    result = await _reader(_Gmail(), respond).read("read_message", {})
    body = result["untrusted_external_content"][0]["body"]
    assert body.startswith("Café invoice\n")
    assert "steal" not in body and ".x" not in body and "evil.invalid" not in body
    assert len(body.encode("utf-8")) <= 12000
    assert result["untrusted_external_content"][0]["body_truncated"] is True
    assert result["truncated"] is True
    assert len(json.dumps(result).encode("utf-8")) <= 24000
    # `truncated` collapsed six different causes into one bool, so a clipped
    # body made One say matches might be missing when none were. Nothing was
    # left out here; one message was shortened.
    assert result["coverage"]["content_shortened"] is True
    assert result["coverage"]["matches_beyond_page"] is False
    assert result["coverage"]["items_omitted"] is False
    assert result["coverage"]["content_depth"] == "message"
    assert result["coverage"]["returned"] == 1


async def test_thread_read_returns_each_message_body_in_thread_order():
    def respond(request):
        if request.url.path.endswith("/messages"):
            return _response({"messages": [{"id": "m-2", "threadId": "thread-1"}]})
        assert request.url.path.endswith("/threads/thread-1")
        assert request.url.params["format"] == "full"
        return _response(
            {
                "id": "thread-1",
                "messages": [
                    _full_message("m-1", [_part("text/plain", "First")], "Q"),
                    _full_message("m-2", [_part("text/plain", "Second")], "Re: Q"),
                ],
            }
        )

    result = await _reader(_Gmail(), respond).read("read_thread", {"query": "subject:Q"})
    items = result["untrusted_external_content"]
    assert [(i["source_ref"], i["body"]) for i in items] == [
        ("mail:1", "First"),
        ("mail:2", "Second"),
    ]


async def test_parallel_metadata_reads_are_bounded_and_keep_listing_order():
    import asyncio

    in_flight = 0
    peak = 0

    async def respond(request):
        nonlocal in_flight, peak
        if request.url.path.endswith("/messages"):
            return _response({"messages": [{"id": f"m-{n}"} for n in range(20)]})
        in_flight += 1
        peak = max(peak, in_flight)
        index = int(request.url.path.rsplit("-", 1)[-1])
        # Later messages answer first; the result must still follow the listing.
        await asyncio.sleep(0.001 * (20 - index))
        in_flight -= 1
        return _response(_message(f"m-{index}", subject=f"S{index}"))

    result = await _reader(_Gmail(), respond).read("list_recent", {"limit": 20})
    assert [i["subject"] for i in result["untrusted_external_content"]] == [
        f"S{n}" for n in range(20)
    ]
    assert 1 < peak <= 8


async def test_one_failed_parallel_read_fails_the_whole_page():
    def respond(request):
        if request.url.path.endswith("/messages"):
            return _response({"messages": [{"id": "m-1"}, {"id": "m-2"}]})
        if request.url.path.endswith("/m-2"):
            return _response({"error": "private"}, 503)
        return _response(_message("m-1"))

    with pytest.raises(GmailMetadataError, match="retryable"):
        await _reader(_Gmail(), respond).read("list_recent", {"limit": 2})


@pytest.mark.parametrize(
    "operation,args",
    [
        ("read_message", {"limit": 6}),
        ("read_message", {"query": "x\n"}),
        ("read_thread", {"limit": 2}),
        ("read_thread", {"mailbox": "trash"}),
    ],
)
async def test_body_read_arguments_are_bounded_before_io(operation, args):
    with pytest.raises(GmailMetadataError, match="invalid_argument"):
        await _reader(_Gmail(), lambda _: pytest.fail("provider called")).read(operation, args)


# --- Reviewed mailbox changes (archive, labels, read state, trash) ---------

_MODIFY = "https://www.googleapis.com/auth/gmail.modify"


class _ModifyGmail(_Gmail):
    def __init__(self, *, modify=True):
        super().__init__()
        if modify:
            self.row["scope_csv"] += f" {_MODIFY}"

    def is_configured(self):
        return True


class _ProposalDb:
    """In-memory stand-in for gmail_mailbox_action_proposals."""

    def __init__(self):
        self.rows = {}

    def execute_raw(self, sql, params):
        from types import SimpleNamespace

        if sql.lstrip().startswith("INSERT"):
            self.rows[params["proposal_id"]] = {**params, "status": "pending"}
            return SimpleNamespace(data=[])
        if "SET status = 'executing'" in sql:
            row = self.rows.get(params["proposal_id"])
            if not row or row["user_id"] != params["user_id"] or row["status"] != "pending":
                return SimpleNamespace(data=[])
            row["status"] = "executing"
            return SimpleNamespace(
                data=[
                    {
                        "action": row["action"],
                        "message_ids": json.loads(row["message_ids"]),
                        "label_id": row["label_id"],
                        "google_sub": row["google_sub"],
                    }
                ]
            )
        if "SET status = 'failed'" in sql:
            self.rows[params["proposal_id"]]["status"] = "failed"
        elif "WHERE proposal_id" in sql:
            self.rows.pop(params["proposal_id"], None)
        return SimpleNamespace(data=[])


def _mailbox(gmail, db, handler):
    from hushh_mcp.services.gmail_mailbox_actions import GmailMailboxActions

    return GmailMailboxActions(gmail=gmail, db=db, transport=httpx.MockTransport(handler))


def _mailbox_provider(writes, labels=None):
    def respond(request):
        if request.method == "POST":
            writes.append(request)
            return httpx.Response(204 if request.url.path.endswith("batchModify") else 200)
        if request.url.path.endswith("/labels"):
            return _response({"labels": labels or []})
        if request.url.path.endswith("/messages"):
            return _response({"messages": [{"id": "m-1"}, {"id": "m-2"}]})
        return _response(_message(request.url.path.rsplit("/", 1)[-1]))

    return respond


@pytest.mark.parametrize(
    "action,label,add,remove",
    [
        ("archive", "", [], ["INBOX"]),
        ("mark_read", "", [], ["UNREAD"]),
        ("mark_unread", "", ["UNREAD"], []),
        ("add_label", "receipts", ["Label_7"], []),
        ("remove_label", "Receipts", [], ["Label_7"]),
        ("add_label", "Starred", ["STARRED"], []),
    ],
)
async def test_mailbox_change_runs_only_after_review_with_exact_labels(action, label, add, remove):
    writes = []
    labels = [
        {"id": "Label_7", "name": "Receipts", "type": "user"},
        {"id": "STARRED", "name": "STARRED", "type": "system"},
        {"id": "TRASH", "name": "TRASH", "type": "system"},
    ]
    db = _ProposalDb()
    service = _mailbox(_ModifyGmail(), db, _mailbox_provider(writes, labels))

    proposal = await service.propose(
        user_id="owner",
        action=action,
        query="from:alice",
        mailbox="inbox",
        limit=2,
        label=label,
        require_access=_allowed,
    )
    # Proposing resolves and stores targets; Gmail is not changed yet.
    assert proposal["status"] == "confirmation_required"
    assert writes == []
    assert "m-1" not in json.dumps(proposal)

    result = await service.execute(user_id="owner", proposal_id=proposal["proposal_id"])
    assert result == {"status": "executed", "action": action, "count": 2}
    assert len(writes) == 1
    assert writes[0].url.path.endswith("/messages/batchModify")
    assert json.loads(writes[0].content) == {
        "ids": ["m-1", "m-2"],
        "addLabelIds": add,
        "removeLabelIds": remove,
    }
    # Single use: the same confirmation cannot run twice.
    with pytest.raises(GmailApiError, match="no longer available"):
        await service.execute(user_id="owner", proposal_id=proposal["proposal_id"])
    assert len(writes) == 1


async def test_trash_moves_each_reviewed_message_to_trash_and_never_deletes():
    writes = []
    service = _mailbox(_ModifyGmail(), _ProposalDb(), _mailbox_provider(writes))
    proposal = await service.propose(
        user_id="owner",
        action="trash",
        query="",
        mailbox="inbox",
        limit=2,
        label="",
        require_access=_allowed,
    )
    await service.execute(user_id="owner", proposal_id=proposal["proposal_id"])
    assert sorted(w.url.path.rsplit("/messages/", 1)[-1] for w in writes) == [
        "m-1/trash",
        "m-2/trash",
    ]
    assert all(w.method == "POST" for w in writes)


async def test_unapproved_or_foreign_proposals_never_reach_gmail():
    writes = []
    gmail = _ModifyGmail()
    db = _ProposalDb()
    service = _mailbox(gmail, db, _mailbox_provider(writes))
    proposal = await service.propose(
        user_id="owner",
        action="archive",
        query="from:alice",
        mailbox="inbox",
        limit=2,
        label="",
        require_access=_allowed,
    )
    # Negative control: no confirmation, a guessed id, or another owner's
    # confirmation never calls Gmail.
    for owner, proposal_id in [("owner", "gmod_guessed"), ("intruder", proposal["proposal_id"])]:
        with pytest.raises(GmailApiError, match="no longer available"):
            await service.execute(user_id=owner, proposal_id=proposal_id)
    # A different Gmail account connected since review cannot receive the IDs.
    gmail.row["google_sub"] = "another-account"
    with pytest.raises(GmailApiError, match="connection changed"):
        await service.execute(user_id="owner", proposal_id=proposal["proposal_id"])
    assert writes == []
    assert db.rows[proposal["proposal_id"]]["status"] == "failed"


async def test_mailbox_change_without_modify_grant_asks_for_it_before_any_read(monkeypatch):
    from hushh_mcp.agents.email.mailbox_tools import propose_gmail_mailbox_change
    from hushh_mcp.services import gmail_mailbox_actions

    service = _mailbox(
        _ModifyGmail(modify=False), _ProposalDb(), lambda _: pytest.fail("provider called")
    )
    context = _mailbox_context(monkeypatch)
    state = context.state
    original = gmail_mailbox_actions._service
    gmail_mailbox_actions._service = service
    try:
        result = await propose_gmail_mailbox_change(context, action="archive", query="from:a")
    finally:
        gmail_mailbox_actions._service = original
    assert result["status"] == "connection_required"
    payload = state["hussh:pending_directive:gmail_mailbox"]["payload"]
    assert payload == {
        "type": "gmail.connect",
        "purpose": "modify",
        "summary": payload["summary"],
        "confirmLabel": "Allow Gmail changes",
    }
    assert "directive" not in result


async def test_proposal_card_carries_subjects_but_the_model_result_does_not(monkeypatch):
    from hushh_mcp.agents.email.mailbox_tools import propose_gmail_mailbox_change
    from hushh_mcp.services import gmail_mailbox_actions

    writes = []
    service = _mailbox(_ModifyGmail(), _ProposalDb(), _mailbox_provider(writes))
    context = _mailbox_context(monkeypatch)
    state = context.state
    original = gmail_mailbox_actions._service
    gmail_mailbox_actions._service = service
    try:
        result = await propose_gmail_mailbox_change(
            context, action="mark_read", query="subject:plan", limit=2
        )
    finally:
        gmail_mailbox_actions._service = original
    payload = state["hussh:pending_directive:gmail_mailbox"]["payload"]
    assert payload["type"] == "gmail.execute_mailbox_proposal"
    assert payload["confirmLabel"] == "Mark as read"
    assert [m["subject"] for m in payload["messages"]] == ["Project plan", "Project plan"]
    assert result["status"] == "confirmation_required" and result["count"] == 2
    assert "Project plan" not in json.dumps(result)
    assert writes == []


def _mailbox_context(monkeypatch, *, sdk_owner="owner", authorized=True):
    from types import SimpleNamespace
    from unittest.mock import AsyncMock

    from hushh_mcp.one_adk import workspace_mcp_tools
    from hushh_mcp.one_adk.request_secrets import store_request_secret

    monkeypatch.setattr(workspace_mcp_tools, "pod_mode", lambda: False)
    monkeypatch.setattr(workspace_mcp_tools, "connector_feature_enabled", lambda *args: True)
    monkeypatch.setattr(
        workspace_mcp_tools, "validate_first_party_owner_token", AsyncMock(return_value=authorized)
    )
    return SimpleNamespace(
        user_id=sdk_owner,
        state={
            "hussh:user_id": "owner",
            "temp:one_execution_surface": "typed_chat",
            workspace_mcp_tools.WORKSPACE_CHAT_ADMISSION_STATE: True,
            "hussh:consent_token": store_request_secret("synthetic-owner-token"),
        },
    )


@pytest.mark.parametrize("sdk_owner,authorized", [("other", True), ("owner", False)])
async def test_mailbox_proposal_refuses_unbound_or_revoked_owner(
    monkeypatch, sdk_owner, authorized
):
    from hushh_mcp.agents.email import mailbox_tools

    monkeypatch.setattr(
        mailbox_tools, "get_gmail_mailbox_actions", lambda: pytest.fail("service accessed")
    )
    context = _mailbox_context(monkeypatch, sdk_owner=sdk_owner, authorized=authorized)
    result = await mailbox_tools.propose_gmail_mailbox_change(context, action="archive")
    assert result["status"] == "unavailable"
    assert "hussh:pending_directive:gmail_mailbox" not in context.state


@pytest.mark.parametrize("reconnect", [False, True])
async def test_mailbox_execution_rechecks_account_after_token_refresh(monkeypatch, reconnect):
    gmail, writes = _ModifyGmail(), []
    service = _mailbox(gmail, _ProposalDb(), _mailbox_provider(writes))
    proposal = await service.propose(
        user_id="owner",
        action="archive",
        query="",
        mailbox="inbox",
        limit=2,
        label="",
        require_access=_allowed,
    )

    async def refresh(*, user_id):
        gmail.row["token_updated_at"] = "refreshed"
        if reconnect:
            gmail.row["google_sub"] = "another-account"
        return "synthetic-refreshed", deepcopy(gmail.row)

    monkeypatch.setattr(gmail, "_ensure_access_token", refresh)
    if reconnect:
        with pytest.raises(GmailApiError) as caught:
            await service.execute(user_id="owner", proposal_id=proposal["proposal_id"])
        assert caught.value.code == "GMAIL_MAILBOX_CONNECTION_CHANGED"
        assert writes == []
    else:
        assert (await service.execute(user_id="owner", proposal_id=proposal["proposal_id"]))[
            "status"
        ] == "executed"
        assert len(writes) == 1


@pytest.mark.parametrize("failure", ["lost_response", "partial_trash", "cleanup"])
async def test_mailbox_never_retries_an_ambiguous_or_completed_write(failure):
    writes, db = [], _ProposalDb()
    normal = _mailbox_provider(writes)

    def provider(request):
        if request.method == "POST":
            if failure == "lost_response":
                writes.append(request)
                raise httpx.ReadError("synthetic lost response", request=request)
            if failure == "partial_trash" and "/m-2/" in request.url.path:
                return httpx.Response(403)
        return normal(request)

    service = _mailbox(_ModifyGmail(), db, provider)
    proposal = await service.propose(
        user_id="owner",
        action="trash" if failure == "partial_trash" else "archive",
        query="",
        mailbox="inbox",
        limit=2,
        label="",
        require_access=_allowed,
    )
    if failure == "cleanup":
        execute_raw = db.execute_raw

        def unavailable_cleanup(sql, params):
            if sql.lstrip().startswith("DELETE") and "WHERE proposal_id" in sql:
                raise RuntimeError("synthetic receipt cleanup failure")
            return execute_raw(sql, params)

        db.execute_raw = unavailable_cleanup
        assert (await service.execute(user_id="owner", proposal_id=proposal["proposal_id"]))[
            "status"
        ] == "executed"
    else:
        with pytest.raises(GmailApiError) as caught:
            await service.execute(user_id="owner", proposal_id=proposal["proposal_id"])
        assert caught.value.code == "GMAIL_MAILBOX_OUTCOME_UNKNOWN"
    count = len(writes)
    assert count > 0
    with pytest.raises(GmailApiError):
        await service.execute(user_id="owner", proposal_id=proposal["proposal_id"])
    assert len(writes) == count
