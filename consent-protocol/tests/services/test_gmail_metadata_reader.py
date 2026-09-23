"""Contract proof with actual HTTPX requests and synthetic Gmail metadata."""

from __future__ import annotations

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


def _message(identity="message-1", subject="Project plan"):
    return {
        "id": identity,
        "threadId": "thread-1",
        "internalDate": str(int(datetime.now(timezone.utc).timestamp() * 1000)),
        "payload": {
            "headers": [
                {"name": "Subject", "value": subject},
                {"name": "From", "value": "Alice <alice@example.com>"},
            ],
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
