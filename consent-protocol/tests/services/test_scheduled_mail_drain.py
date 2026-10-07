"""The scheduled-mail drain sends each due email at most once, or says why not.

The drain is driven against an in-memory ledger that interprets both its own
SQL and the SQL of the UNCHANGED ``GmailDeliveryService.execute()``, so these
tests prove the arming contract (a row the drain arms is one execute() will
send) and the send-once/fail-closed boundaries end to end, with only Gmail's
HTTP endpoint and the I1 seal pair faked.
"""

from __future__ import annotations

import asyncio
import base64
import copy
import json
from datetime import datetime, timedelta, timezone
from email import message_from_bytes
from email.policy import default as default_policy
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import httpx
import pytest

from hushh_mcp.services import gmail_scheduled_drain as drain
from hushh_mcp.services.gmail_delivery_service import GmailDeliveryService, normalize_draft
from hushh_mcp.services.gmail_scheduled_drain import drain_scheduled_mail


@pytest.fixture(autouse=True)
def shared_placement(monkeypatch):
    from hushh_mcp.services import owner_placement_guard as guard

    monkeypatch.setattr(guard, "pod_mode", lambda: False)
    monkeypatch.setattr(guard, "get_owner_hosting_mode", AsyncMock(return_value="shared"))


NOW = datetime(2026, 10, 5, 12, 0, tzinfo=timezone.utc)
OWNER = "owner-uid"
RECIPIENT = "priya-uid"
ADDRESS = "priya@example.com"
SUBJECT = "Diwali plans"
BODY = "See you at seven."
NAME = "Priya Sharma"
SENDER = "google-sub-owner-1"


class _Delivery(GmailDeliveryService):
    """The real service plus stand-ins for the I1 seal pair and sender lookup."""

    sender_sub: str | None = SENDER

    async def current_sender_sub(self, *, user_id: str) -> str | None:
        return self.sender_sub

    def open_schedule_payload(self, *, user_id: str, action_id: str, sealed: str) -> dict:
        prefix = f"sealed:{user_id}:{action_id}:"
        if not sealed.startswith(prefix):
            raise ValueError("unopenable")
        return json.loads(sealed[len(prefix) :])

    @staticmethod
    def scheduled_draft_payload(payload: dict[str, Any]) -> dict[str, Any]:
        return {"to": [payload["to"]], "subject": payload["subject"], "body": payload["body"]}


def _payload(**changes: str) -> dict[str, str]:
    return {
        "to": ADDRESS,
        "subject": SUBJECT,
        "body": BODY,
        "recipient_user_id": RECIPIENT,
        "sender_sub": SENDER,
        **changes,
    }


class _Ledger:
    """gmail_owner_send_actions, with NOW() pinned and SQL interpreted."""

    def __init__(self) -> None:
        self.rows: dict[str, dict[str, Any]] = {}
        self.statements: list[str] = []
        # A statement that raises when run, to model a database blip.
        self.fail_statement: str | None = None

    def pool(self) -> _Pool:
        return _Pool(self)

    def row(self, action_id: str) -> dict[str, Any]:
        return self.rows[action_id]


class _Pool:
    def __init__(self, ledger: _Ledger) -> None:
        self.ledger = ledger

    def acquire(self) -> _Acquire:
        return _Acquire(self.ledger)


class _Acquire:
    def __init__(self, ledger: _Ledger) -> None:
        self.ledger = ledger

    async def __aenter__(self) -> _Conn:
        return _Conn(self.ledger)

    async def __aexit__(self, *exc: object) -> bool:
        return False


class _Transaction:
    def __init__(self, ledger: _Ledger) -> None:
        self.ledger = ledger
        self.snapshot: dict[str, dict[str, Any]] = {}

    async def __aenter__(self) -> _Transaction:
        self.snapshot = copy.deepcopy(self.ledger.rows)
        return self

    async def __aexit__(self, exc_type: object, *exc: object) -> bool:
        if exc_type is not None:
            self.ledger.rows.clear()
            self.ledger.rows.update(self.snapshot)
        return False


def _update(row: dict[str, Any], query: str, **changes: Any) -> None:
    """Apply an UPDATE's SET list, including the sealed-payload and subject clears."""
    row.update(changes)
    if "payload_sealed = NULL" in query:
        row["payload_sealed"] = None
    if "subject = NULL" in query:
        row["subject"] = None


_TERMINAL = ("sent", "failed", "outcome_unknown", "expired", "cancelled")


def _orphaned(row: dict[str, Any]) -> bool:
    return (
        row["state"] == "prepared"
        and row["send_at"] is not None
        and row["sending_at"] is None
        and row["updated_at"] < NOW - timedelta(minutes=10)
    )


class _Conn:
    def __init__(self, ledger: _Ledger) -> None:
        self.ledger = ledger

    def transaction(self) -> _Transaction:
        return _Transaction(self.ledger)

    async def execute(self, query: str, *args: Any) -> str:
        self._run(query, args)
        return "OK"

    async def fetchrow(self, query: str, *args: Any) -> dict[str, Any] | None:
        return self._run(query, args)

    async def fetch(self, query: str, *args: Any) -> list[dict[str, Any]]:
        return self._run(query, args)

    def _owned(self, action_id: str, user_id: str) -> dict[str, Any] | None:
        row = self.ledger.rows.get(action_id)
        return row if row is not None and row["user_id"] == user_id else None

    def _run(self, query: str, args: tuple[Any, ...]) -> Any:  # noqa: C901 - one SQL table
        self.ledger.statements.append(query)
        rows = self.ledger.rows
        if query == drain._SCRUB_TERMINAL_ROWS_SQL:
            if self.ledger.fail_statement == query:
                raise RuntimeError("scrub unavailable")
            held = [
                row
                for row in rows.values()
                if row["send_at"] is not None
                and row["state"] in _TERMINAL
                and (row["payload_sealed"] is not None or row["subject"] is not None)
            ][: args[0]]
            for row in held:
                _update(row, query)
            return [{"action_id": row["action_id"]} for row in held]
        if query == drain._STALE_SENDING_SQL:
            stale = sorted(
                (
                    row
                    for row in rows.values()
                    if row["state"] == "sending"
                    and row["send_at"] is not None
                    and row["sending_at"] < NOW - timedelta(minutes=10)
                ),
                key=lambda row: row["sending_at"],
            )[: args[0]]
            for row in stale:
                _update(
                    row,
                    query,
                    state="outcome_unknown",
                    safe_error_code="drain_interrupted",
                    updated_at=NOW,
                )
            return [{"action_id": row["action_id"], "user_id": row["user_id"]} for row in stale]
        if query == drain._CLAIM_SQL:
            due = sorted(
                (
                    row
                    for row in rows.values()
                    if row["action_id"] not in args[0]
                    and ((row["state"] == "scheduled" and row["send_at"] <= NOW) or _orphaned(row))
                ),
                key=lambda row: (row["send_at"], row["action_id"]),
            )
            if not due:
                return None
            row = due[0]
            return {
                **{
                    key: row[key]
                    for key in ("action_id", "user_id", "state", "attempt_count", "payload_sealed")
                },
                "window_passed": row["expires_at"] <= NOW,
            }
        if query in (drain._SETTLE_UNSENT_SQL, drain._ARM_SQL):
            row = self._owned(args[0], args[1])
            if row is None or row["state"] not in ("scheduled", "prepared") or row["sending_at"]:
                return None
            if query == drain._ARM_SQL:
                _update(
                    row,
                    query,
                    state="prepared",
                    attempt_count=row["attempt_count"] + 1,
                    updated_at=NOW,
                )
            else:
                _update(row, query, state=args[2], safe_error_code=args[3], updated_at=NOW)
            return {"action_id": row["action_id"]}
        if query == drain._FAIL_ARMED_SQL:
            if self.ledger.fail_statement == query:
                raise RuntimeError("settle unavailable")
            row = self._owned(args[0], args[1])
            if row is not None and row["state"] == "prepared" and row["sending_at"] is None:
                # Labelled by the window only when the statement says so.
                window = "WHEN expires_at <= NOW() THEN 'schedule_window_passed'" in query
                code = "schedule_window_passed" if window and row["expires_at"] <= NOW else args[2]
                _update(row, query, state="failed", safe_error_code=code, updated_at=NOW)
            return None
        if query == drain._SCRUB_TERMINAL_PAYLOAD_SQL:
            row = self._owned(args[0], args[1])
            if row is not None and row["state"] in _TERMINAL:
                _update(row, query)
            return None
        if query == drain._DEFER_ARMED_SQL:
            row = self._owned(args[0], args[1])
            if row is not None and row["state"] == "prepared" and row["sending_at"] is None:
                row["attempt_count"] = max(0, row["attempt_count"] - 1)
                row["updated_at"] = NOW
            return None
        if query == drain._READ_STATE_SQL:
            if self.ledger.fail_statement == query:
                raise RuntimeError("read-back unavailable")
            row = self._owned(args[0], args[1])
            return None if row is None else {k: row[k] for k in ("state", "safe_error_code")}
        if query == drain._CLAIM_NOTIFICATION_SQL:
            row = self._owned(args[0], args[1])
            if row is None or row["state"] != args[2] or row["notified_at"] is not None:
                return None
            row["notified_at"] = NOW
            return {"recipient_display": row["recipient_display"]}
        if "SET state = 'prepared', sending_at = NULL" in query:
            row = self._owned(args[0], args[1])
            if row is not None and row["state"] == "sending" and row["envelope_hmac"] == args[2]:
                row.update(state="prepared", sending_at=None, updated_at=NOW)
                if row["send_at"] is not None:
                    row["attempt_count"] = max(0, row["attempt_count"] - 1)
            return None
        # The GmailDeliveryService.execute() statements.
        if "SET state = 'expired'" in query:
            row = self._owned(args[0], args[1])
            if row is not None and row["state"] == "prepared" and row["expires_at"] <= NOW:
                # Immediate confirmations only, when the statement says so.
                if "send_at IS NULL" not in query or row["send_at"] is None:
                    row.update(state="expired", updated_at=NOW)
            return None
        if "SELECT action_id, state, expires_at, sent_at, envelope_hmac" in query:
            row = self._owned(args[0], args[1])
            if row is None:
                return None
            return {
                key: row[key]
                for key in ("action_id", "state", "expires_at", "sent_at", "envelope_hmac")
            }
        if "SET state = 'sending'" in query:
            row = self._owned(args[0], args[1])
            if (
                row is None
                or row["state"] != "prepared"
                or row["expires_at"] <= NOW
                or row["envelope_hmac"] != args[2]
            ):
                return None
            row.update(state="sending", sending_at=NOW, updated_at=NOW)
            return {key: row[key] for key in ("action_id", "state", "expires_at", "sent_at")}
        if "gmail_message_id = COALESCE" in query:
            row = rows.get(args[0])
            if row is not None and row["state"] == "sending":
                row.update(state=args[1], safe_error_code=args[2], updated_at=NOW)
                if args[1] == "sent":
                    row["sent_at"] = NOW
            return None
        raise AssertionError(f"unexpected SQL: {query.strip()[:80]}")


class _GmailServer:
    def __init__(self) -> None:
        self.posts: list[dict[str, Any]] = []
        self.status = 200

    def client_class(self) -> type:
        server = self

        class _Client:
            def __init__(self, *args: Any, **kwargs: Any) -> None:
                pass

            async def __aenter__(self) -> _Client:
                return self

            async def __aexit__(self, *exc: object) -> bool:
                return False

            async def post(self, url: str, *, headers: dict, json: dict) -> httpx.Response:
                server.posts.append(json)
                return httpx.Response(
                    server.status,
                    json={"id": f"gmail-{len(server.posts)}", "threadId": "thread"},
                    request=httpx.Request("POST", url),
                )

        return _Client

    def recipients(self) -> list[str]:
        return [
            str(
                message_from_bytes(base64.urlsafe_b64decode(post["raw"]), policy=default_policy)[
                    "To"
                ]
            )
            for post in self.posts
        ]


@pytest.fixture
def harness(monkeypatch):
    from hushh_mcp.services import gmail_delivery_service as delivery_module

    monkeypatch.setattr(
        delivery_module,
        "get_core_security_settings",
        lambda: SimpleNamespace(app_signing_key="test-signing-key"),
    )
    ledger = _Ledger()
    gmail = _GmailServer()
    monkeypatch.setattr(delivery_module, "get_pool", lambda: asyncio.sleep(0, result=ledger.pool()))
    monkeypatch.setattr(delivery_module.httpx, "AsyncClient", gmail.client_class())
    service = _Delivery(
        gmail_service=SimpleNamespace(get_send_access_token=AsyncMock(return_value="send-token"))
    )
    executed: list[str] = []
    real_execute = service.execute

    async def counting_execute(**kwargs: Any) -> dict[str, Any]:
        executed.append(kwargs["action_id"])
        return await real_execute(**kwargs)

    service.execute = counting_execute  # type: ignore[method-assign]
    return SimpleNamespace(
        ledger=ledger,
        gmail=gmail,
        service=service,
        executed=executed,
        pushes=[],
        connections=[{"userId": RECIPIENT, "email": "Priya@Example.com"}],
    )


def _schedule(
    h: SimpleNamespace,
    action_id: str,
    *,
    send_at: datetime = NOW - timedelta(minutes=1),
    payload: dict[str, str] | None = None,
    **fields: Any,
) -> dict[str, Any]:
    payload = payload or _payload()
    row = {
        "action_id": action_id,
        "user_id": OWNER,
        "state": "scheduled",
        # D3: exactly the envelope an immediate send of this draft would carry.
        "envelope_hmac": h.service._envelope_hmac(
            normalize_draft(h.service.scheduled_draft_payload(payload))
        ),
        "send_at": send_at,
        "expires_at": send_at + timedelta(hours=24),
        "sending_at": None,
        "sent_at": None,
        "updated_at": send_at - timedelta(hours=1),
        "attempt_count": 0,
        "payload_sealed": f"sealed:{OWNER}:{action_id}:{json.dumps(payload)}",
        "recipient_display": NAME,
        "subject": SUBJECT,
        "safe_error_code": None,
        "notified_at": None,
        **fields,
    }
    h.ledger.rows[action_id] = row
    return row


async def _drain(h: SimpleNamespace, **kwargs: Any) -> dict[str, Any]:
    def push(user_id: str, **payload: Any) -> int:
        h.pushes.append((user_id, payload))
        return 1

    return await drain_scheduled_mail(
        limit=kwargs.pop("limit", 50),
        delivery=h.service,
        directory=SimpleNamespace(list_connections=lambda user_id: list(h.connections)),
        push=push,
        pool_provider=lambda: asyncio.sleep(0, result=h.ledger.pool()),
        **kwargs,
    )


def _push_bodies(h: SimpleNamespace) -> list[str]:
    return [payload["body"] for _user, payload in h.pushes]


@pytest.mark.asyncio
async def test_due_rows_fire_in_send_at_order_through_unchanged_execute(harness):
    h = harness
    _schedule(h, "later", send_at=NOW - timedelta(minutes=1))
    _schedule(h, "earlier", send_at=NOW - timedelta(minutes=5))
    _schedule(h, "not-due", send_at=NOW + timedelta(minutes=5))

    result = await _drain(h)

    assert h.executed == ["earlier", "later"]
    assert h.gmail.recipients() == [ADDRESS, ADDRESS]
    assert result == {
        "success": True,
        "fired": 2,
        "sent": ["earlier", "later"],
        "failed": [],
        "outcome_unknown": [],
        "cancelled": [],
        "expired": [],
        "limit": 50,
    }
    assert h.ledger.row("earlier")["state"] == "sent"
    assert h.ledger.row("earlier")["attempt_count"] == 1
    assert h.ledger.row("not-due")["state"] == "scheduled"
    assert _push_bodies(h) == [f"Your scheduled email to {NAME} was sent."] * 2
    # The owner learns who; nothing else of the email leaves the ledger.
    rendered = json.dumps([result, [payload for _user, payload in h.pushes]])
    for private in (ADDRESS, SUBJECT, BODY, RECIPIENT, OWNER, SENDER):
        assert private not in rendered
    assert all(payload["include_user_id"] is False for _user, payload in h.pushes)

    # A second run finds nothing due and never re-sends or re-notifies.
    again = await _drain(h)
    assert again["fired"] == 0 and len(h.gmail.posts) == 2 and len(h.pushes) == 2


@pytest.mark.asyncio
async def test_tampered_envelope_fails_closed_before_any_provider_call(harness):
    h = harness
    _schedule(h, "tampered", envelope_hmac="f" * 64)

    result = await _drain(h)

    assert h.executed == ["tampered"]
    assert h.gmail.posts == []
    assert result["failed"] == ["tampered"] and result["sent"] == []
    row = h.ledger.row("tampered")
    assert (row["state"], row["safe_error_code"]) == ("failed", "draft_changed")
    # Nothing is left to review: the copy offers a new schedule, never a resend.
    assert _push_bodies(h) == [
        f"Your scheduled email to {NAME} wasn't sent (it changed after it was scheduled). "
        "Nothing was delivered. You can ask One to schedule it again."
    ]


@pytest.mark.asyncio
async def test_unopenable_payload_fails_closed_without_reaching_execute(harness):
    h = harness
    _schedule(h, "garbled", payload_sealed="sealed:someone-else:garbled:{}")

    result = await _drain(h)

    assert h.executed == [] and h.gmail.posts == []
    assert result["failed"] == ["garbled"]
    assert h.ledger.row("garbled")["safe_error_code"] == "payload_unseal_failed"
    assert len(h.pushes) == 1


@pytest.mark.asyncio
async def test_outcome_unknown_is_final_and_never_resent(harness):
    h = harness
    _schedule(h, "ambiguous")
    h.gmail.status = 503

    first = await _drain(h)
    h.gmail.status = 200
    second = await _drain(h)

    assert first["outcome_unknown"] == ["ambiguous"]
    assert second["fired"] == 0 and second["outcome_unknown"] == []
    assert len(h.gmail.posts) == 1
    assert h.ledger.row("ambiguous")["state"] == "outcome_unknown"
    assert _push_bodies(h) == [
        f"We couldn't confirm whether your scheduled email to {NAME} was sent. "
        "Please check your Gmail Sent folder before resending."
    ]


@pytest.mark.asyncio
async def test_disconnected_recipient_fails_and_never_reaches_execute(harness):
    """Recorded as ``failed`` so migration 252 projects a Feed item: the owner
    keeps a lasting record of an unsent email even with notifications off."""
    h = harness
    _schedule(h, "disconnected")
    h.connections = []

    result = await _drain(h)

    assert h.executed == [] and h.gmail.posts == []
    assert result["failed"] == ["disconnected"] and result["fired"] == 0
    assert result["cancelled"] == []
    row = h.ledger.row("disconnected")
    assert (row["state"], row["safe_error_code"]) == ("failed", "recipient_disconnected")
    assert _push_bodies(h) == [
        f"Your scheduled email to {NAME} wasn't sent because you're no longer connected "
        "with them. Nothing was delivered."
    ]
    assert h.pushes[0][1]["notification_type"] == "mail_scheduled_failed"


@pytest.mark.asyncio
async def test_changed_recipient_address_fails_closed(harness):
    h = harness
    _schedule(h, "moved")
    h.connections = [{"userId": RECIPIENT, "email": "priya@new-employer.example"}]

    result = await _drain(h)

    assert h.executed == [] and h.gmail.posts == []
    assert result["failed"] == ["moved"]
    assert h.ledger.row("moved")["safe_error_code"] == "recipient_changed"


_SENDER_CHANGED_BODY = (
    f"Your scheduled email to {NAME} wasn't sent (your connected Gmail account changed). "
    "Nothing was delivered. You can ask One to schedule it again."
)
_RECONNECT_BODY = (
    f"Your scheduled email to {NAME} wasn't sent because your Gmail is disconnected or "
    "needs to be reconnected. Nothing was delivered. Reconnect Gmail, then ask One to "
    "schedule it again."
)


@pytest.mark.parametrize(
    ("sealed_sender", "current_sender", "code", "body"),
    [
        (SENDER, "google-sub-someone-else", "sender_changed", _SENDER_CHANGED_BODY),
        (None, SENDER, "sender_changed", _SENDER_CHANGED_BODY),
        # No usable connection (disconnected or needing re-auth) is not "another
        # account": the owner is told to reconnect, and it still fails closed.
        (SENDER, None, "gmail_unavailable", _RECONNECT_BODY),
    ],
    ids=["reconnected-to-another-account", "sealed-without-sender", "gmail-disconnected"],
)
@pytest.mark.asyncio
async def test_changed_sending_account_fails_closed_without_reaching_execute(
    harness, sealed_sender, current_sender, code, body
):
    h = harness
    payload = _payload()
    if sealed_sender is None:
        payload.pop("sender_sub")
    _schedule(h, "other-account", payload=payload)
    h.service.sender_sub = current_sender

    result = await _drain(h)

    assert h.executed == [] and h.gmail.posts == []
    assert result["failed"] == ["other-account"] and result["fired"] == 0
    row = h.ledger.row("other-account")
    assert (row["state"], row["safe_error_code"]) == ("failed", code)
    assert _push_bodies(h) == [body]


@pytest.mark.asyncio
async def test_every_terminal_state_clears_the_sealed_payload(harness):
    h = harness
    _schedule(h, "sent", send_at=NOW - timedelta(minutes=9))
    _schedule(h, "tampered", send_at=NOW - timedelta(minutes=8), envelope_hmac="f" * 64)
    _schedule(h, "expired", send_at=NOW - timedelta(hours=25))
    _schedule(
        h, "other-account", send_at=NOW - timedelta(minutes=7), payload=_payload(sender_sub="x")
    )
    _schedule(h, "crashed", state="sending", sending_at=NOW - timedelta(minutes=15))
    _schedule(h, "waiting", send_at=NOW + timedelta(minutes=5))

    result = await _drain(h)
    _schedule(h, "disconnected")
    h.connections = []
    later = await _drain(h)

    assert result["sent"] == ["sent"] and result["expired"] == []
    assert result["failed"] == ["expired", "tampered", "other-account"]
    assert result["outcome_unknown"] == ["crashed"] and later["failed"] == ["disconnected"]
    for action_id in ("sent", "tampered", "expired", "other-account", "crashed", "disconnected"):
        row = h.ledger.row(action_id)
        assert (row["payload_sealed"], row["subject"]) == (None, None), action_id
    # A row still waiting to be sent keeps the payload and the subject it lists.
    assert h.ledger.row("waiting")["payload_sealed"] is not None
    assert h.ledger.row("waiting")["subject"] == SUBJECT


@pytest.mark.asyncio
async def test_outcome_unknown_from_execute_clears_the_sealed_payload(harness):
    h = harness
    _schedule(h, "ambiguous")
    h.gmail.status = 503

    result = await _drain(h)

    assert result["outcome_unknown"] == ["ambiguous"]
    assert h.ledger.row("ambiguous")["payload_sealed"] is None
    assert h.ledger.row("ambiguous")["subject"] is None


@pytest.mark.asyncio
async def test_run_start_scrub_clears_terminal_scheduled_rows_left_holding_mail(harness):
    """A crash, or execute()'s own terminal writes, can leave a finished row
    holding its sealed mail and subject. Each run clears a bounded batch."""
    h = harness
    for state in _TERMINAL:
        _schedule(h, f"left-{state}", state=state, send_at=NOW + timedelta(hours=1))
    _schedule(h, "waiting", send_at=NOW + timedelta(hours=1))
    _schedule(h, "in-flight", state="sending", sending_at=NOW - timedelta(minutes=2))
    # An immediate send is not this drain's row, whatever it holds.
    _schedule(h, "immediate", state="sent", send_at=NOW, expires_at=NOW)["send_at"] = None

    result = await _drain(h, limit=3)

    assert result["fired"] == 0 and h.pushes == []
    assert sum(h.ledger.row(f"left-{state}")["subject"] is None for state in _TERMINAL) == 3
    await _drain(h)
    for state in _TERMINAL:
        row = h.ledger.row(f"left-{state}")
        assert (row["state"], row["payload_sealed"], row["subject"]) == (state, None, None)
        assert row["notified_at"] is None  # a scrub is not an outcome
    for kept in ("waiting", "in-flight", "immediate"):
        assert h.ledger.row(kept)["payload_sealed"] is not None, kept
        assert h.ledger.row(kept)["subject"] == SUBJECT, kept


@pytest.mark.asyncio
async def test_failed_run_start_scrub_does_not_stop_delivery(harness):
    h = harness
    _schedule(h, "due")
    h.ledger.fail_statement = drain._SCRUB_TERMINAL_ROWS_SQL

    result = await _drain(h)

    assert result["sent"] == ["due"]


@pytest.mark.asyncio
async def test_read_back_failure_after_execute_is_deferred_not_raised(harness):
    """The send already happened or was refused; a failed read-back must not
    abort the run or the batch. The row is left for the next run's scrub."""
    h = harness
    _schedule(h, "first", send_at=NOW - timedelta(minutes=5))
    _schedule(h, "second", send_at=NOW - timedelta(minutes=1))
    h.ledger.fail_statement = drain._READ_STATE_SQL

    result = await _drain(h)

    assert h.executed == ["first", "second"] and len(h.gmail.posts) == 2
    assert result["fired"] == 2 and result["sent"] == [] and h.pushes == []
    assert h.ledger.row("first")["state"] == "sent"
    assert h.ledger.row("first")["subject"] == SUBJECT

    h.ledger.fail_statement = None
    again = await _drain(h)

    assert again["fired"] == 0 and len(h.gmail.posts) == 2
    assert (h.ledger.row("first")["payload_sealed"], h.ledger.row("first")["subject"]) == (
        None,
        None,
    )


@pytest.mark.asyncio
async def test_refusal_after_the_window_passed_is_labelled_window_passed(harness):
    """execute() refuses an armed row whose window passed while it was armed
    and leaves it armed (its expiry write is for immediate sends only). The
    drain records that as the window, not as an unexplained refusal."""
    h = harness
    _schedule(h, "late-arm")
    real_execute = h.service.execute

    async def window_closes_then_execute(**kwargs: Any) -> dict[str, Any]:
        h.ledger.row(kwargs["action_id"])["expires_at"] = NOW - timedelta(seconds=1)
        return await real_execute(**kwargs)

    h.service.execute = window_closes_then_execute  # type: ignore[method-assign]

    result = await _drain(h)

    assert h.gmail.posts == [] and result["failed"] == ["late-arm"]
    row = h.ledger.row("late-arm")
    assert (row["state"], row["safe_error_code"]) == ("failed", "schedule_window_passed")
    assert (row["payload_sealed"], row["subject"]) == (None, None)
    assert _push_bodies(h) == [
        f"Your scheduled email to {NAME} wasn't sent because the send window passed. "
        "Nothing was delivered. You can ask One to schedule it again."
    ]


@pytest.mark.asyncio
async def test_failed_settle_after_a_refusal_is_deferred_not_raised(harness):
    h = harness
    _schedule(h, "tampered", send_at=NOW - timedelta(minutes=5), envelope_hmac="f" * 64)
    _schedule(h, "fine", send_at=NOW - timedelta(minutes=1))
    h.ledger.fail_statement = drain._FAIL_ARMED_SQL

    result = await _drain(h)

    # The refused row stays armed (execute() re-verifies it on any re-arm) and
    # the batch goes on.
    assert result["sent"] == ["fine"] and h.gmail.recipients() == [ADDRESS]
    assert h.ledger.row("tampered")["state"] == "prepared"


@pytest.mark.asyncio
async def test_refusal_inside_the_window_stays_send_refused(harness):
    h = harness
    _schedule(h, "refused")

    async def refuse(**kwargs: Any) -> dict[str, Any]:
        raise drain.GmailDeliveryError("ACTION_NOT_SENDABLE", "no")

    h.service.execute = refuse  # type: ignore[method-assign]

    result = await _drain(h)

    assert result["failed"] == ["refused"]
    assert h.ledger.row("refused")["safe_error_code"] == "send_refused"


@pytest.mark.asyncio
async def test_cancelled_row_is_never_sent_or_notified(harness):
    h = harness
    _schedule(h, "cancelled-by-voice", state="cancelled")

    result = await _drain(h)

    assert result["fired"] == 0 and h.gmail.posts == [] and h.pushes == []
    assert h.ledger.row("cancelled-by-voice")["notified_at"] is None


@pytest.mark.asyncio
async def test_row_past_its_send_window_fails_instead_of_sending_late(harness):
    """Recorded as ``failed`` (not ``expired``) so migration 252 projects a Feed
    item: an unsent email leaves a record even with notifications off."""
    h = harness
    _schedule(h, "overdue", send_at=NOW - timedelta(hours=25))
    _schedule(h, "catch-up", send_at=NOW - timedelta(hours=23))

    result = await _drain(h)

    assert result["failed"] == ["overdue"] and result["sent"] == ["catch-up"]
    assert result["expired"] == []
    assert h.executed == ["catch-up"]
    row = h.ledger.row("overdue")
    assert (row["state"], row["safe_error_code"]) == ("failed", "schedule_window_passed")
    assert (
        f"Your scheduled email to {NAME} wasn't sent because the send window passed. "
        "Nothing was delivered. You can ask One to schedule it again."
    ) in _push_bodies(h)


@pytest.mark.asyncio
async def test_orphaned_armed_row_is_rearmed_once_and_recent_arms_are_left_alone(harness):
    h = harness
    _schedule(
        h,
        "orphan",
        state="prepared",
        attempt_count=1,
        updated_at=NOW - timedelta(minutes=15),
    )
    _schedule(
        h,
        "in-flight",
        state="prepared",
        attempt_count=1,
        updated_at=NOW - timedelta(minutes=2),
    )
    _schedule(
        h,
        "exhausted",
        state="prepared",
        attempt_count=drain.MAX_ATTEMPTS,
        updated_at=NOW - timedelta(minutes=15),
    )

    result = await _drain(h)

    assert h.executed == ["orphan"]
    assert result["sent"] == ["orphan"] and result["failed"] == ["exhausted"]
    assert h.ledger.row("orphan")["attempt_count"] == 2
    assert h.ledger.row("in-flight")["state"] == "prepared"
    assert h.ledger.row("exhausted")["safe_error_code"] == "retry_exhausted"


@pytest.mark.asyncio
async def test_row_stuck_sending_becomes_outcome_unknown_and_is_never_resent(harness):
    h = harness
    _schedule(
        h,
        "crashed-mid-post",
        state="sending",
        sending_at=NOW - timedelta(minutes=15),
        attempt_count=1,
    )

    result = await _drain(h)

    assert result["outcome_unknown"] == ["crashed-mid-post"]
    assert h.executed == [] and h.gmail.posts == []
    assert h.ledger.row("crashed-mid-post")["safe_error_code"] == "drain_interrupted"
    assert len(h.pushes) == 1


@pytest.mark.asyncio
async def test_a_failing_row_is_rolled_back_and_does_not_stop_the_batch(harness):
    h = harness
    _schedule(h, "first", send_at=NOW - timedelta(minutes=5))
    _schedule(h, "second", send_at=NOW - timedelta(minutes=1))
    calls = {"n": 0}

    def flaky(user_id: str) -> list[dict[str, Any]]:
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("directory unavailable")
        return list(h.connections)

    result = await drain_scheduled_mail(
        limit=50,
        delivery=h.service,
        directory=SimpleNamespace(list_connections=flaky),
        push=lambda user_id, **payload: 1,
        pool_provider=lambda: asyncio.sleep(0, result=h.ledger.pool()),
    )

    assert result["sent"] == ["second"] and result["fired"] == 1
    assert h.ledger.row("first")["state"] == "scheduled"
    assert h.ledger.row("first")["attempt_count"] == 0


@pytest.mark.asyncio
async def test_limit_and_deadline_bound_a_run(harness):
    h = harness
    _schedule(h, "a", send_at=NOW - timedelta(minutes=3))
    _schedule(h, "b", send_at=NOW - timedelta(minutes=2))

    limited = await _drain(h, limit=1)
    assert limited["sent"] == ["a"] and limited["limit"] == 1

    ticks = iter([0.0, 241.0])
    timed_out = await _drain(h, deadline_seconds=240, clock=lambda: next(ticks))
    assert timed_out["fired"] == 0 and h.ledger.row("b")["state"] == "scheduled"

    with pytest.raises(ValueError):
        await _drain(h, limit=101)


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["byoc", "pending", "hussh_pods", "unplaced", "unknown"])
async def test_private_or_unknown_scheduled_owner_never_opens_mail(harness, monkeypatch, mode):
    from unittest.mock import Mock

    from hushh_mcp.services import owner_placement_guard as guard

    h = harness
    original = copy.deepcopy(_schedule(h, "placement-refused"))
    opened = Mock(wraps=h.service.open_schedule_payload)
    h.service.open_schedule_payload = opened
    monkeypatch.setattr(guard, "get_owner_hosting_mode", AsyncMock(return_value=mode))
    result = await _drain(h)
    opened.assert_not_called()
    assert h.executed == [] and h.gmail.posts == [] and h.pushes == []
    if mode == "unknown":
        assert h.ledger.row("placement-refused") == original
        assert result["failed"] == []
    else:
        row = h.ledger.row("placement-refused")
        assert (row["state"], row["safe_error_code"]) == ("failed", "private_runtime_required")
        assert row["payload_sealed"] is None and row["subject"] is None
        assert drain._CLAIM_NOTIFICATION_SQL not in h.ledger.statements


@pytest.mark.asyncio
async def test_refused_first_row_does_not_starve_shared_scheduled_owner(harness, monkeypatch):
    from hushh_mcp.services import owner_placement_guard as guard

    h = harness
    _schedule(h, "private-first", user_id="private-owner", send_at=NOW - timedelta(minutes=2))
    _schedule(h, "shared-second")

    async def placement(owner):
        return "byoc" if owner == "private-owner" else "shared"

    monkeypatch.setattr(guard, "get_owner_hosting_mode", placement)
    result = await _drain(h)
    assert h.executed == ["shared-second"] and len(h.gmail.posts) == 1
    assert result["failed"] == ["private-first"] and result["sent"] == ["shared-second"]
    assert len(h.pushes) == 1 and h.pushes[0][0] == OWNER


@pytest.mark.asyncio
async def test_scheduled_owner_moving_during_sender_lookup_refuses_delivery(harness, monkeypatch):
    from hushh_mcp.services import owner_placement_guard as guard

    h = harness
    _schedule(h, "moves-before-arm")

    async def moved_sender(**_kwargs):
        monkeypatch.setattr(guard, "get_owner_hosting_mode", AsyncMock(return_value="byoc"))
        return SENDER

    h.service.current_sender_sub = moved_sender
    result = await _drain(h)
    assert h.executed == [] and h.gmail.posts == [] and h.pushes == []
    assert result["failed"] == ["moves-before-arm"]


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["byoc", "unknown"])
async def test_scheduled_owner_moving_during_token_resolution_never_posts(
    harness, monkeypatch, mode
):
    from hushh_mcp.services import owner_placement_guard as guard

    h = harness
    _schedule(h, "moves-before-post")

    async def token(**_kwargs):
        monkeypatch.setattr(guard, "get_owner_hosting_mode", AsyncMock(return_value=mode))
        return "synthetic-send-token"

    h.service.gmail_service.get_send_access_token = token
    result = await _drain(h)
    assert h.gmail.posts == [] and h.pushes == [] and result["sent"] == []
    row = h.ledger.row("moves-before-post")
    if mode == "unknown":
        assert row["state"] == "prepared" and row["sending_at"] is None
        assert row["attempt_count"] == 0
        assert row["payload_sealed"] is not None and row["subject"] == SUBJECT
        assert result["failed"] == [] and result["outcome_unknown"] == []
    else:
        assert row["state"] == "failed" and row["safe_error_code"] == "private_runtime_required"
