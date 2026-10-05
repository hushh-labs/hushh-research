"""The owner's Gmail drafts: which grant each call uses, and what a send records.

Gmail is an ``httpx.MockTransport`` and the connection a double whose token
getters return distinct tokens, so every test can see which grant a request
carried. The ledger is a recording pool: nothing here touches a database.
"""

from __future__ import annotations

import base64
import json
from types import SimpleNamespace
from typing import Any

import httpx
import pytest

from hushh_mcp.services import gmail_delivery_service as delivery_module
from hushh_mcp.services import gmail_drafts_service as drafts
from hushh_mcp.services.gmail_receipts_service import GmailApiError

OWNER = "owner-uid"
ACCOUNT = "google-sub-owner"
DRAFT_ID = "r-5012345678901234567"
MESSAGE_ID = "msg18c0ffee"


class GmailDouble:
    """A connection whose grants are told apart by the token each one returns."""

    def __init__(self) -> None:
        self.calls: list[str] = []
        self.send_error: GmailApiError | None = None
        self.compose_error: GmailApiError | None = None
        self.account = ACCOUNT

    async def get_read_access_token(self, *, user_id: str) -> str:
        assert user_id == OWNER
        self.calls.append("read")
        return "read-token"

    async def assert_send_ready(self, *, user_id: str) -> None:
        assert user_id == OWNER
        self.calls.append("send_ready")
        if self.send_error is not None:
            raise self.send_error

    async def get_compose_access_token(self, *, user_id: str) -> str:
        self.calls.append("compose")
        if self.compose_error is not None:
            raise self.compose_error
        return "compose-token"

    async def get_send_access_token(self, *, user_id: str) -> str:
        raise AssertionError("drafts.send refuses the plain send grant; never ask for it")

    def _fetch_connection_row(self, *, user_id: str) -> dict[str, Any]:
        return {"google_sub": self.account, "status": "connected", "revoked": False}


def _b64(text: str) -> str:
    return base64.urlsafe_b64encode(text.encode("utf-8")).decode("ascii").rstrip("=")


def _metadata_draft(draft_id: str, index: int) -> dict[str, Any]:
    return {
        "id": draft_id,
        "message": {
            "id": f"msg{index}",
            "threadId": f"thread{index}",
            "snippet": f"Snippet {index}",
            "internalDate": "1759600000000",
            "payload": {
                "headers": [
                    {"name": "To", "value": f"Priya Sharma <priya{index}@example.com>"},
                    {"name": "Subject", "value": f"Diwali plans {index}"},
                ]
            },
        },
    }


def _full_draft(
    body: str = "Let's meet at 7.", *, to: str = "Priya <priya@example.com>", bcc: str = ""
):
    bcc_headers = [{"name": "Bcc", "value": bcc}] if bcc else []
    return {
        "id": DRAFT_ID,
        "message": {
            "id": MESSAGE_ID,
            "threadId": "thread1",
            "internalDate": "1759600000000",
            "payload": {
                "mimeType": "text/plain",
                "headers": [
                    {"name": "To", "value": to},
                    {"name": "Cc", "value": "a@example.com, b@example.com"},
                    *bcc_headers,
                    {"name": "Subject", "value": "Diwali plans"},
                ],
                "body": {"data": _b64(body)},
            },
        },
    }


class _Bytes(httpx.AsyncByteStream):
    """A streamed body, as Gmail's responses arrive (read with ``aiter_raw``)."""

    def __init__(self, data: bytes) -> None:
        self.data = data

    async def __aiter__(self):
        yield self.data


def _json(status: int, payload: Any) -> httpx.Response:
    return httpx.Response(status, stream=_Bytes(json.dumps(payload).encode()))


class Gmail:
    """Records every request; answers from a route table."""

    def __init__(self, routes: dict[tuple[str, str], Any]) -> None:
        self.routes = routes
        self.requests: list[httpx.Request] = []

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self._handle)

    def _handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        key = (request.method, request.url.path)
        answer = self.routes.get(key)
        if answer is None:
            return _json(404, {})
        if isinstance(answer, httpx.Response):
            return answer
        return _json(200, answer)


def _path(suffix: str) -> str:
    return "/gmail/v1/users/me" + suffix


# -- list -----------------------------------------------------------------------


async def test_list_reads_headers_with_the_readonly_grant_and_never_a_body():
    ids = [f"r-{index}" for index in range(1, 4)]
    routes: dict[tuple[str, str], Any] = {
        ("GET", _path("/drafts")): {
            "drafts": [{"id": value, "message": {"id": "m", "threadId": "t"}} for value in ids],
            "nextPageToken": "more",
        }
    }
    for index, value in enumerate(ids, start=1):
        routes[("GET", _path(f"/drafts/{value}"))] = _metadata_draft(value, index)
    gmail = Gmail(routes)
    connection = GmailDouble()

    listed = await drafts.list_gmail_drafts(
        user_id=OWNER, max_results=50, gmail=connection, transport=gmail.transport()
    )

    assert connection.calls == ["read"], "a list needs the readonly grant and nothing more"
    assert all(r.headers["Authorization"] == "Bearer read-token" for r in gmail.requests)
    # Clamped to the service's ceiling, and every per-draft read is metadata only.
    assert gmail.requests[0].url.params["maxResults"] == str(drafts.DRAFTS_LIST_MAX)
    per_draft = gmail.requests[1:]
    assert [r.url.params["format"] for r in per_draft] == ["metadata"] * 3
    assert listed["account"] == ACCOUNT
    assert listed["has_more"] is True
    assert [row["draft_id"] for row in listed["drafts"]] == ids
    first = listed["drafts"][0]
    assert first["to_label"] == "Priya Sharma"
    assert first["subject"] == "Diwali plans 1"
    assert first["updated_at_iso"].startswith("2025-10-04")
    assert "body_text" not in first


async def test_one_unreadable_draft_fails_the_list_rather_than_hiding_a_row():
    routes: dict[tuple[str, str], Any] = {
        ("GET", _path("/drafts")): {"drafts": [{"id": "r-1"}, {"id": "r-2"}]},
        ("GET", _path("/drafts/r-1")): _metadata_draft("r-1", 1),
        ("GET", _path("/drafts/r-2")): _json(503, {}),
    }

    with pytest.raises(GmailApiError) as caught:
        await drafts.list_gmail_drafts(
            user_id=OWNER, gmail=GmailDouble(), transport=Gmail(routes).transport()
        )

    assert caught.value.code == "GMAIL_PROVIDER_RETRYABLE"


# -- open -----------------------------------------------------------------------


async def test_open_returns_the_body_for_the_screen_read_with_the_readonly_grant():
    gmail = Gmail(
        {("GET", _path(f"/drafts/{DRAFT_ID}")): _full_draft(bcc="Hidden <hidden@example.com>")}
    )
    connection = GmailDouble()

    draft = await drafts.get_gmail_draft(
        user_id=OWNER,
        draft_id=DRAFT_ID,
        expect_account=ACCOUNT,
        gmail=connection,
        transport=gmail.transport(),
    )

    assert connection.calls == ["read"]
    assert gmail.requests[0].url.params["format"] == "full"
    assert draft["body_text"] == "Let's meet at 7."
    assert draft["body_truncated"] is False
    assert draft["message_id"] == MESSAGE_ID
    assert draft["to_list"] == ["priya@example.com"]
    # Bcc goes to the owner's screen too: a send must never surprise them with a
    # recipient the draft view did not show.
    assert draft["bcc_list"] == ["hidden@example.com"]
    assert draft["recipient_count"] == 4


async def test_a_long_draft_is_shortened_and_says_so():
    body = "word " * 20_000
    gmail = Gmail({("GET", _path(f"/drafts/{DRAFT_ID}")): _full_draft(body)})

    draft = await drafts.get_gmail_draft(
        user_id=OWNER, draft_id=DRAFT_ID, gmail=GmailDouble(), transport=gmail.transport()
    )

    assert draft["body_truncated"] is True
    assert len(draft["body_text"].encode("utf-8")) <= 32 * 1024


@pytest.mark.parametrize("bad", ["", "../messages/x", "r 1", "a" * 257, None])
async def test_an_invalid_draft_id_is_refused_before_any_request(bad):
    gmail = Gmail({})

    with pytest.raises(GmailApiError) as caught:
        await drafts.get_gmail_draft(
            user_id=OWNER, draft_id=bad, gmail=GmailDouble(), transport=gmail.transport()
        )

    assert caught.value.code == "INVALID_DRAFT_ID"
    assert gmail.requests == []


async def test_a_draft_listed_in_another_account_is_not_opened_in_this_one():
    gmail = Gmail({("GET", _path(f"/drafts/{DRAFT_ID}")): _full_draft()})

    with pytest.raises(GmailApiError) as caught:
        await drafts.get_gmail_draft(
            user_id=OWNER,
            draft_id=DRAFT_ID,
            expect_account="google-sub-other",
            gmail=GmailDouble(),
            transport=gmail.transport(),
        )

    assert caught.value.code == "GMAIL_ACCOUNT_CHANGED"
    assert gmail.requests == []


async def test_a_deleted_draft_is_named_as_gone():
    gmail = Gmail({})

    with pytest.raises(GmailApiError) as caught:
        await drafts.get_gmail_draft(
            user_id=OWNER, draft_id=DRAFT_ID, gmail=GmailDouble(), transport=gmail.transport()
        )

    assert (caught.value.code, caught.value.status_code) == ("GMAIL_DRAFT_NOT_FOUND", 404)


# -- send -----------------------------------------------------------------------


class _Transaction:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


class LedgerConn:
    """The send ledger: an INSERT that may conflict, a locked SELECT, updates."""

    def __init__(self, existing: dict[str, Any] | None = None) -> None:
        self.existing = existing
        self.calls: list[tuple[str, tuple[Any, ...]]] = []

    def transaction(self):
        return _Transaction()

    async def fetchrow(self, query: str, *args: Any):
        self.calls.append((" ".join(query.split()), args))
        if query.lstrip().startswith("INSERT"):
            return None if self.existing is not None else {"action_id": args[0]}
        return self.existing

    async def execute(self, query: str, *args: Any):
        self.calls.append((" ".join(query.split()), args))


class Pool:
    def __init__(self, conn: LedgerConn) -> None:
        self.conn = conn

    def acquire(self):
        return self

    async def __aenter__(self):
        return self.conn

    async def __aexit__(self, *exc):
        return False


@pytest.fixture
def ledger(monkeypatch):
    def install(existing: dict[str, Any] | None = None) -> LedgerConn:
        conn = LedgerConn(existing)

        async def get_pool():
            return Pool(conn)

        monkeypatch.setattr(drafts, "get_pool", get_pool)
        monkeypatch.setattr(delivery_module, "get_pool", get_pool)
        monkeypatch.setattr(
            delivery_module,
            "get_core_security_settings",
            lambda: SimpleNamespace(app_signing_key="drafts-test-signing-key-0123456789"),
        )
        return conn

    return install


def _states(conn: LedgerConn) -> list[str]:
    """The states the ledger was moved to, in order."""
    moved: list[str] = []
    for query, args in conn.calls:
        if query.startswith("INSERT") and conn.existing is None:
            moved.append("sending")
        elif query.startswith("UPDATE gmail_owner_send_actions SET state = $2"):
            moved.append(str(args[1]))
        elif "SET state = 'sending'" in query:
            moved.append("sending")
    return moved


def _sent(message_id: str = "msgSENT1") -> httpx.Response:
    return httpx.Response(200, json={"id": message_id, "threadId": "thread1"})


async def test_a_send_uses_the_send_gate_and_the_compose_grant_and_records_metadata(ledger):
    conn = ledger()
    gmail = Gmail({("POST", _path("/drafts/send")): _sent()})
    connection = GmailDouble()

    sent = await drafts.send_gmail_draft(
        user_id=OWNER,
        draft_id=DRAFT_ID,
        expect_account=ACCOUNT,
        recipient_count=3,
        gmail=connection,
        transport=gmail.transport(),
    )

    assert sent["state"] == "sent"
    # The owner's Send switch first, then the grant drafts.send actually needs.
    assert connection.calls == ["send_ready", "compose"]
    (post,) = gmail.requests
    assert post.headers["Authorization"] == "Bearer compose-token"
    assert json.loads(post.content) == {"id": DRAFT_ID}
    assert _states(conn) == ["sending", "sent"]
    insert_args = conn.calls[0][1]
    assert insert_args[4] == 3, "recipient_count"
    # Metadata only: the draft id rides in HMACs, never in a column.
    assert DRAFT_ID not in repr(conn.calls)


async def test_send_disabled_sends_nothing_and_records_nothing(ledger):
    """Negative control for the send gate: drop assert_send_ready and this posts."""
    conn = ledger()
    gmail = Gmail({("POST", _path("/drafts/send")): _sent()})
    connection = GmailDouble()
    connection.send_error = GmailApiError(
        "Turn on Gmail sending.", status_code=409, code="GMAIL_SEND_DISABLED"
    )

    with pytest.raises(GmailApiError) as caught:
        await drafts.send_gmail_draft(
            user_id=OWNER, draft_id=DRAFT_ID, gmail=connection, transport=gmail.transport()
        )

    assert caught.value.code == "GMAIL_SEND_DISABLED"
    assert gmail.requests == []
    assert conn.calls == []


async def test_a_connection_without_the_drafts_grant_is_refused_before_gmail(ledger):
    conn = ledger()
    gmail = Gmail({("POST", _path("/drafts/send")): _sent()})
    connection = GmailDouble()
    connection.compose_error = GmailApiError(
        "Enable Gmail drafts.", status_code=409, code="GMAIL_COMPOSE_PERMISSION_REQUIRED"
    )

    with pytest.raises(GmailApiError) as caught:
        await drafts.send_gmail_draft(
            user_id=OWNER, draft_id=DRAFT_ID, gmail=connection, transport=gmail.transport()
        )

    assert caught.value.code == "GMAIL_COMPOSE_PERMISSION_REQUIRED"
    assert gmail.requests == []
    assert conn.calls == []


async def test_a_draft_gone_from_gmail_is_honest_and_recorded_as_not_sent(ledger):
    conn = ledger()
    gmail = Gmail({("POST", _path("/drafts/send")): httpx.Response(404, json={})})

    with pytest.raises(GmailApiError) as caught:
        await drafts.send_gmail_draft(
            user_id=OWNER, draft_id=DRAFT_ID, gmail=GmailDouble(), transport=gmail.transport()
        )

    assert caught.value.code == "GMAIL_DRAFT_NOT_FOUND"
    assert _states(conn) == ["sending", "failed"]


@pytest.mark.parametrize(
    "answer",
    [
        httpx.Response(500, json={}),
        httpx.Response(200, json={}),
        httpx.ReadTimeout("slow"),
        httpx.WriteError("reset"),
    ],
)
async def test_an_ambiguous_send_is_outcome_unknown_never_a_failure(ledger, answer):
    conn = ledger()

    def handle(request: httpx.Request) -> httpx.Response:
        if isinstance(answer, Exception):
            raise answer
        return answer

    sent = await drafts.send_gmail_draft(
        user_id=OWNER,
        draft_id=DRAFT_ID,
        gmail=GmailDouble(),
        transport=httpx.MockTransport(handle),
    )

    assert sent["state"] == "outcome_unknown"
    assert _states(conn) == ["sending", "outcome_unknown"]


@pytest.mark.parametrize("error", [httpx.ConnectError("refused"), httpx.ConnectTimeout("slow")])
async def test_a_request_that_never_left_the_host_is_a_definite_non_send(ledger, error):
    """Negative control: a write or read failure above stays outcome_unknown."""
    conn = ledger()

    def handle(request: httpx.Request) -> httpx.Response:
        raise error

    with pytest.raises(GmailApiError) as caught:
        await drafts.send_gmail_draft(
            user_id=OWNER,
            draft_id=DRAFT_ID,
            gmail=GmailDouble(),
            transport=httpx.MockTransport(handle),
        )

    assert caught.value.code == "GMAIL_PROVIDER_RETRYABLE"
    # Failed, so the owner may ask again; outcome_unknown would block that forever.
    assert _states(conn) == ["sending", "failed"]


@pytest.mark.parametrize("prior", ["sent", "outcome_unknown", "sending"])
async def test_a_second_send_of_the_same_draft_never_reaches_gmail(ledger, prior):
    ledger({"action_id": "earlier", "state": prior})
    gmail = Gmail({("POST", _path("/drafts/send")): _sent()})

    if prior == "sent":
        with pytest.raises(GmailApiError) as caught:
            await drafts.send_gmail_draft(
                user_id=OWNER, draft_id=DRAFT_ID, gmail=GmailDouble(), transport=gmail.transport()
            )
        assert caught.value.code == "GMAIL_DRAFT_ALREADY_SENT"
    else:
        sent = await drafts.send_gmail_draft(
            user_id=OWNER, draft_id=DRAFT_ID, gmail=GmailDouble(), transport=gmail.transport()
        )
        # Distinct from this turn's own unknown outcome: nothing was asked now.
        assert sent == {"state": "previous_unconfirmed", "action_id": "earlier"}
    assert gmail.requests == []


async def test_a_refused_attempt_may_be_asked_again(ledger):
    conn = ledger({"action_id": "earlier", "state": "failed"})
    gmail = Gmail({("POST", _path("/drafts/send")): _sent()})

    sent = await drafts.send_gmail_draft(
        user_id=OWNER, draft_id=DRAFT_ID, gmail=GmailDouble(), transport=gmail.transport()
    )

    assert sent == {"state": "sent", "action_id": "earlier"}
    assert len(gmail.requests) == 1
    assert _states(conn) == ["sending", "sent"]
