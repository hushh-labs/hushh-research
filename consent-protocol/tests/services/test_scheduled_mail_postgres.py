"""Migration 275 and the scheduled-mail and draft-send ledger SQL on real PostgreSQL.

Proves what the in-memory ledgers in test_scheduled_mail_drain.py and
test_gmail_delivery_service.py cannot:

* 275 replaces 173's inline state CHECK (one constraint, not two), both CHECKs
  hold, and the rollback refuses while a scheduled or cancelled row exists;
* ``schedule_send`` is idempotent on replay and under concurrent identical
  calls (one row), and a cancel flips once, drops the sealed payload and frees
  the idempotency key;
* the drain's real claim / stale-sending / arm / settle SQL: a due row is sent
  once even with concurrent drains (``FOR UPDATE SKIP LOCKED``), a not-due or
  terminal row is never claimed, and an immediate send (``send_at IS NULL``,
  including a draft send) is never touched by the orphan reaper or the
  stale-sending sweep, however old it is;
* a row past its window, a disconnected recipient and a refusal after the
  window closed are recorded ``failed`` with their reason, so migration 252's
  trigger projects a Feed item; every terminal transition, and each run's
  bounded scrub, clears ``payload_sealed`` and ``subject``;
* the draft-send ledger claim admits one attempt per draft, and one retry
  after a definite refusal;
* account reset's delete predicate removes the owner's scheduled rows only.

Only Gmail's HTTP endpoint, the connection-row lookup and the recipient
directory are faked; every SQL statement is the shipped one. Each test gets a
disposable database, so the rollback's ``public.`` guard sees the test table.
Runs when ONE_COMMAND_TEST_DATABASE_URL points at an isolated PostgreSQL server.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import time
from collections.abc import AsyncIterator
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit
from uuid import uuid4

import httpx
import pytest

from db import db_client
from hushh_mcp.services import gmail_delivery_service, gmail_drafts_service
from hushh_mcp.services.account_service import AccountService
from hushh_mcp.services.gmail_delivery_service import GmailDeliveryError, GmailDeliveryService
from hushh_mcp.services.gmail_receipts_service import GmailApiError
from hushh_mcp.services.gmail_scheduled_drain import drain_scheduled_mail

ROOT = Path(__file__).resolve().parents[2]
MIGRATIONS = ROOT / "db" / "migrations"
M173 = (MIGRATIONS / "173_gmail_owner_approved_delivery.sql").read_text()
M275 = (MIGRATIONS / "275_scheduled_mail_send.sql").read_text()
M252 = (MIGRATIONS / "252_calendar_mail_feed_projection.sql").read_text()
R275 = (MIGRATIONS / "rollback" / "275_scheduled_mail_send.rollback.sql").read_text()

OWNER = "sched-owner"
OTHER = "sched-other"
RECIPIENT = "sched-recipient"
ADDRESS = "priya@example.com"
SUBJECT = "Diwali plans"
BODY = "See you at seven."
NAME = "Priya Sharma"
SENDER = "google-sub-owner-1"
DRAFT_ID = "r-1234567890abcdef"
_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send"
_DRAFT_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/drafts/send"


def _postgres_url() -> str:
    url = os.getenv("ONE_COMMAND_TEST_DATABASE_URL")
    if not url:
        pytest.skip("An isolated PostgreSQL database is required.")
    return url.replace("postgresql+psycopg2://", "postgresql://", 1)


async def _disposable_database() -> AsyncIterator[Any]:
    """A fresh database holding vault_keys and migration 173 only."""
    import asyncpg

    url = _postgres_url()
    name = "sched_mail_test_" + uuid4().hex
    admin = await asyncpg.connect(url)
    await admin.execute(f'CREATE DATABASE "{name}"')
    parts = urlsplit(url)
    pool = await asyncpg.create_pool(
        urlunsplit((parts.scheme, parts.netloc, "/" + name, parts.query, "")),
        min_size=1,
        max_size=12,
    )
    try:
        await pool.execute(
            "CREATE TABLE vault_keys (user_id TEXT PRIMARY KEY);"
            f" INSERT INTO vault_keys VALUES ('{OWNER}'), ('{OTHER}');"
        )
        await pool.execute(M173)
        yield pool
    finally:
        await pool.close()
        await admin.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')
        await admin.close()


@pytest.fixture
async def bare_db() -> AsyncIterator[Any]:
    async for pool in _disposable_database():
        yield pool


@pytest.fixture
async def ledger(monkeypatch) -> AsyncIterator[Any]:
    """173 then 275, replayed as every deploy does, behind both services' get_pool."""
    async for pool in _disposable_database():
        await pool.execute(M275)
        await pool.execute(M275)

        async def _pool(bound: Any = pool) -> Any:
            return bound

        monkeypatch.setattr(gmail_delivery_service, "get_pool", _pool)
        monkeypatch.setattr(gmail_drafts_service, "get_pool", _pool)

        # Placement is read by the synchronous control-plane client. Bind that
        # real client to this same disposable database, with an explicit Shared
        # choice for OWNER only; the other owner remains unplaced.
        from sqlalchemy import create_engine

        await pool.execute("ALTER TABLE vault_keys ADD COLUMN setup_capability_ids TEXT")
        for name in (
            "900_personal_agent_registry.sql",
            "906_personal_agent_user_cloud.sql",
            "909_byoc_setup_jobs.sql",
            "955_one_hosting_choice.sql",
        ):
            await pool.execute((MIGRATIONS / "parked" / name).read_text())
        await pool.execute(
            "UPDATE vault_keys SET one_hosting_choice = 'shared',"
            " one_hosting_choice_at = NOW() WHERE user_id = $1",
            OWNER,
        )
        parts = urlsplit(_postgres_url())
        database = await pool.fetchval("SELECT current_database()")
        engine = create_engine(
            urlunsplit(("postgresql+psycopg2", parts.netloc, "/" + database, parts.query, ""))
        )
        monkeypatch.setattr(db_client, "_db_client", db_client.DatabaseClient(engine))
        try:
            yield pool
        finally:
            engine.dispose()


class _Gmail:
    """The receipts connection: connected as SENDER, every grant present.

    ``lookup_delay`` slows the connection-row read, which the drain makes while
    it holds a claimed row, so a concurrent drain reaches that row mid-decision.
    """

    def __init__(self, *, lookup_delay: float = 0.0) -> None:
        self.sub = SENDER
        self.lookup_delay = lookup_delay

    def _fetch_connection_row(self, *, user_id: str) -> dict[str, Any]:
        time.sleep(self.lookup_delay)  # runs in a worker thread (asyncio.to_thread)
        return {"status": "connected", "revoked": False, "google_sub": self.sub}

    async def assert_send_ready(self, *, user_id: str) -> None:
        return None

    async def get_send_access_token(self, *, user_id: str) -> str:
        return "send-token"

    async def get_compose_access_token(self, *, user_id: str) -> str:
        return "compose-token"


class _Directory:
    def __init__(self, *, connected: bool = True) -> None:
        self.connected = connected

    def list_connections(self, user_id: str) -> list[dict[str, Any]]:
        return [{"userId": RECIPIENT, "email": ADDRESS}] if self.connected else []


class _GmailHttp:
    """Gmail's send endpoints. Counts every POST; a short delay widens races."""

    def __init__(self, *, status: int = 200, delay: float = 0.05) -> None:
        self.status = status
        self.delay = delay
        self.posts: list[httpx.Request] = []

    async def __call__(self, request: httpx.Request) -> httpx.Response:
        self.posts.append(request)
        await asyncio.sleep(self.delay)
        if self.status != 200:
            return httpx.Response(self.status, json={"error": {"code": self.status}})
        return httpx.Response(200, json={"id": f"m{len(self.posts)}", "threadId": "t1"})


@pytest.fixture
def gmail_http(monkeypatch) -> _GmailHttp:
    """Route execute()'s own httpx.AsyncClient to the fake endpoint."""
    fake = _GmailHttp()
    real_client = httpx.AsyncClient

    def _client(*args: Any, **kwargs: Any) -> httpx.AsyncClient:
        kwargs["transport"] = httpx.MockTransport(fake)
        return real_client(*args, **kwargs)

    monkeypatch.setattr(gmail_delivery_service.httpx, "AsyncClient", _client)
    return fake


def _service(*, lookup_delay: float = 0.0) -> GmailDeliveryService:
    gmail = _Gmail(lookup_delay=lookup_delay)
    return GmailDeliveryService(gmail_service=gmail)  # type: ignore[arg-type]


def _payload(**changes: str) -> dict[str, str]:
    return {
        "to": ADDRESS,
        "subject": SUBJECT,
        "body": BODY,
        "recipient_user_id": RECIPIENT,
        "sender_sub": SENDER,
        **changes,
    }


def _send_at(hours: int = 3) -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0) + timedelta(hours=hours)


async def _schedule(
    service: GmailDeliveryService, send_at: datetime, **changes: str
) -> dict[str, Any]:
    return await service.schedule_send(
        user_id=OWNER, payload=_payload(**changes), send_at=send_at, recipient_display=NAME
    )


async def _make_due(pool: Any, action_id: str, *, minutes_ago: int = 1) -> None:
    """Move a stored schedule's time into the past, keeping its 24h window."""
    await pool.execute(
        "UPDATE gmail_owner_send_actions"
        " SET send_at = NOW() - make_interval(mins => $2),"
        "     expires_at = NOW() - make_interval(mins => $2) + INTERVAL '24 hours'"
        " WHERE action_id = $1",
        action_id,
        minutes_ago,
    )


async def _row(pool: Any, action_id: str) -> dict[str, Any]:
    row = await pool.fetchrow(
        "SELECT * FROM gmail_owner_send_actions WHERE action_id = $1", action_id
    )
    assert row is not None
    return dict(row)


async def _together(pool: Any, calls: list[Any]) -> list[Any]:
    """Run ``calls`` so every one has reached its INSERT before any proceeds.

    A SHARE lock on the table admits the callers' reads (including SELECT ...
    FOR UPDATE) but queues every INSERT. Once all callers wait on it, it is
    released and they race for real; scheduling luck cannot serialize them.
    """
    blocker = await pool.acquire()
    hold = blocker.transaction()
    await hold.start()
    tasks: list[asyncio.Future[Any]] = []
    try:
        await blocker.execute("LOCK TABLE gmail_owner_send_actions IN SHARE MODE")
        tasks = [asyncio.ensure_future(call) for call in calls]
        for _ in range(500):
            waiting = await blocker.fetchval(
                "SELECT COUNT(*) FROM pg_locks WHERE NOT granted"
                " AND relation = 'gmail_owner_send_actions'::regclass"
            )
            if waiting >= len(tasks):
                break
            await asyncio.sleep(0.01)
        else:
            raise AssertionError("the callers never reached their INSERT")
    finally:
        await hold.rollback()
        await pool.release(blocker)
    return await asyncio.gather(*tasks, return_exceptions=True)


async def _insert(
    pool: Any,
    *,
    state: str,
    send_at: str | None,
    sending_at: str | None = None,
    updated_at: str = "NOW()",
    expires_at: str = "NOW() + INTERVAL '1 hour'",
    payload_sealed: str | None = None,
    attempt_count: int = 0,
    subject: str | None = None,
    user_id: str = OWNER,
) -> str:
    """A row as another writer left it. Times are SQL expressions (constants here)."""
    action_id = str(uuid4())
    await pool.execute(
        "INSERT INTO gmail_owner_send_actions (action_id, user_id, envelope_hmac,"
        " idempotency_hmac, recipient_count, state, expires_at, send_at, sending_at,"
        " payload_sealed, attempt_count, subject, created_at, updated_at)"
        f" VALUES ($1, $2, 'envelope', $3, 1, $4, {expires_at},"
        f" {send_at or 'NULL'}, {sending_at or 'NULL'}, $5, $6, $7, {updated_at}, {updated_at})",
        action_id,
        user_id,
        "idem-" + action_id,
        state,
        payload_sealed,
        attempt_count,
        subject,
    )
    return action_id


class _Push:
    def __init__(self) -> None:
        self.sent: list[tuple[str, dict[str, Any]]] = []

    def __call__(self, user_id: str, **kwargs: Any) -> int:
        self.sent.append((user_id, kwargs))
        return 1


async def _drain(
    pool: Any,
    service: GmailDeliveryService,
    push: _Push | None = None,
    directory: _Directory | None = None,
) -> dict:
    async def _pool() -> Any:
        return pool

    return await drain_scheduled_mail(
        limit=20,
        delivery=service,
        directory=directory or _Directory(),
        push=push or _Push(),
        pool_provider=_pool,
    )


# --- (a) migration 275 over 173 ---------------------------------------------


async def test_migration_275_applies_over_173_holds_its_checks_and_guards_rollback(bare_db):
    import asyncpg

    pool = bare_db
    # A row written before 275 existed must survive it untouched.
    legacy = await pool.fetchval(
        "INSERT INTO gmail_owner_send_actions (action_id, user_id, envelope_hmac,"
        " idempotency_hmac, recipient_count, state, expires_at)"
        " VALUES ('legacy', $1, 'e', 'i-legacy', 1, 'sent', NOW()) RETURNING action_id",
        OWNER,
    )
    await pool.execute(M275)
    await pool.execute(M275)  # every deploy replays it

    checks = {
        row["conname"]: row["def"]
        for row in await pool.fetch(
            "SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint"
            " WHERE conrelid = 'gmail_owner_send_actions'::regclass AND contype = 'c'"
        )
    }
    # 173's inline CHECK carried the default name 275 drops: replaced, not doubled.
    assert set(checks) == {
        "gmail_owner_send_actions_recipient_count_check",
        "gmail_owner_send_actions_state_check",
        "gmail_owner_send_actions_schedule_time_check",
    }
    assert "'scheduled'" in checks["gmail_owner_send_actions_state_check"]
    old = await _row(pool, legacy)
    assert (old["state"], old["attempt_count"], old["send_at"]) == ("sent", 0, None)

    async def insert(state: str, send_at: str) -> None:
        await pool.execute(
            "INSERT INTO gmail_owner_send_actions (action_id, user_id, envelope_hmac,"
            " idempotency_hmac, recipient_count, state, expires_at, send_at)"
            f" VALUES ($1, $2, 'e', $1, 1, $3, NOW() + INTERVAL '1 day', {send_at})",
            str(uuid4()),
            OWNER,
            state,
        )

    with pytest.raises(asyncpg.CheckViolationError) as no_time:
        await insert("scheduled", "NULL")
    assert no_time.value.constraint_name == "gmail_owner_send_actions_schedule_time_check"
    with pytest.raises(asyncpg.CheckViolationError) as unknown:
        await insert("paused", "NOW()")
    assert unknown.value.constraint_name == "gmail_owner_send_actions_state_check"
    await insert("scheduled", "NOW() + INTERVAL '1 hour'")
    with pytest.raises(asyncpg.CheckViolationError):
        await pool.execute(
            "UPDATE gmail_owner_send_actions SET send_at = NULL WHERE state = 'scheduled'"
        )

    async def rollback() -> None:
        async with pool.acquire() as conn:
            try:
                await conn.execute(R275)
            finally:
                if conn.is_in_transaction():
                    await conn.execute("ROLLBACK")

    async def columns() -> set[str]:
        return {
            row["column_name"]
            for row in await pool.fetch(
                "SELECT column_name FROM information_schema.columns"
                " WHERE table_name = 'gmail_owner_send_actions'"
            )
        }

    for state in ("scheduled", "cancelled"):
        await pool.execute(
            "UPDATE gmail_owner_send_actions SET state = $1 WHERE send_at IS NOT NULL", state
        )
        with pytest.raises(asyncpg.RaiseError, match="migration_275_rollback_refused"):
            await rollback()
        # Refused before anything was dropped.
        assert {"send_at", "payload_sealed", "attempt_count"} <= await columns()
        assert (
            await pool.fetchval(
                "SELECT state FROM gmail_owner_send_actions WHERE send_at IS NOT NULL"
            )
            == state
        )

    await pool.execute("DELETE FROM gmail_owner_send_actions WHERE send_at IS NOT NULL")
    await rollback()
    assert not {"send_at", "payload_sealed", "subject", "notified_at"} & await columns()
    with pytest.raises(asyncpg.CheckViolationError):
        await pool.execute(
            "INSERT INTO gmail_owner_send_actions (action_id, user_id, envelope_hmac,"
            " idempotency_hmac, recipient_count, state, expires_at)"
            " VALUES ('after', $1, 'e', 'i-after', 1, 'scheduled', NOW())",
            OWNER,
        )
    assert (await _row(pool, legacy))["state"] == "sent"
    await pool.execute(M275)  # forward again after a rollback
    assert {"send_at", "payload_sealed"} <= await columns()


# --- (b) schedule_send and cancel_scheduled_send ------------------------------


async def test_schedule_send_replay_is_idempotent_and_concurrent_calls_store_one_row(ledger):
    service = _service()
    send_at = _send_at()
    first = await _schedule(service, send_at)
    again = await _schedule(service, send_at)
    assert (first["created"], again["created"]) == (True, False)
    assert again["action_id"] == first["action_id"]
    stored = await _row(ledger, first["action_id"])
    assert stored["state"] == "scheduled"
    assert stored["payload_sealed"].startswith("sp1.")
    assert BODY not in stored["payload_sealed"] and ADDRESS not in stored["payload_sealed"]
    assert stored["expires_at"] - stored["send_at"] == timedelta(hours=24)

    # Eight identical confirmations racing (two devices, a retried socket).
    later = _send_at(hours=5)
    results = await _together(ledger, [_schedule(service, later) for _ in range(8)])
    assert sorted(result["created"] for result in results) == [False] * 7 + [True]
    assert len({result["action_id"] for result in results}) == 1
    assert (
        await ledger.fetchval(
            "SELECT COUNT(*) FROM gmail_owner_send_actions WHERE send_at = $1", later
        )
        == 1
    )


async def test_cancel_flips_once_drops_the_payload_and_frees_the_key(ledger):
    service = _service()
    send_at = _send_at()
    first = await _schedule(service, send_at)
    before = await _row(ledger, first["action_id"])

    # Owner-bound: another account's cancel changes nothing.
    assert await service.cancel_scheduled_send(user_id=OTHER, action_id=first["action_id"]) == {
        "cancelled": False,
        "state": None,
        "sent_at": None,
    }
    assert await service.cancel_scheduled_send(user_id=OWNER, action_id=first["action_id"]) == {
        "cancelled": True,
        "state": "cancelled",
        "sent_at": None,
    }
    second = await service.cancel_scheduled_send(user_id=OWNER, action_id=first["action_id"])
    assert (second["cancelled"], second["state"]) == (False, "cancelled")

    cancelled = await _row(ledger, first["action_id"])
    assert cancelled["payload_sealed"] is None
    assert cancelled["idempotency_hmac"] == (
        before["idempotency_hmac"] + ":cancelled:" + first["action_id"]
    )
    assert await service.list_scheduled_sends(user_id=OWNER) == []

    # The same email, person and time again is a new send, not the cancelled one.
    again = await _schedule(service, send_at)
    assert again["created"] is True
    assert again["action_id"] != first["action_id"]
    assert [row["action_id"] for row in await service.list_scheduled_sends(user_id=OWNER)] == [
        again["action_id"]
    ]


# --- (c) the drain's claim / stale-sending / arm / settle SQL -----------------


async def test_drain_sends_a_due_row_once_and_leaves_a_future_one(ledger, gmail_http):
    service = _service()
    due = await _schedule(service, _send_at())
    future = await _schedule(service, _send_at(hours=6), subject="Later")
    await _make_due(ledger, due["action_id"])
    push = _Push()

    result = await _drain(ledger, service, push)

    assert result["fired"] == 1
    assert result["sent"] == [due["action_id"]]
    assert len(gmail_http.posts) == 1
    assert str(gmail_http.posts[0].url) == _SEND_URL
    raw = base64.urlsafe_b64decode(json.loads(gmail_http.posts[0].content)["raw"]).decode()
    assert f"To: {ADDRESS}" in raw and f"Subject: {SUBJECT}" in raw
    sent = await _row(ledger, due["action_id"])
    assert (sent["state"], sent["attempt_count"], sent["gmail_message_id"]) == ("sent", 1, "m1")
    assert sent["payload_sealed"] is None and sent["notified_at"] is not None
    assert [kwargs["notification_type"] for _, kwargs in push.sent] == ["mail_scheduled_sent"]
    waiting = await _row(ledger, future["action_id"])
    assert (waiting["state"], waiting["attempt_count"]) == ("scheduled", 0)
    assert waiting["payload_sealed"] is not None

    # A second run finds nothing: the sent row is never claimed again.
    again = await _drain(ledger, service)
    assert again["fired"] == 0 and len(gmail_http.posts) == 1


@pytest.mark.parametrize("placement", ["unplaced", "unavailable"])
async def test_drain_refuses_an_owner_without_verified_shared_placement(
    ledger, gmail_http, placement
):
    from hushh_mcp.services.personal_agent_hosting import get_owner_hosting_mode

    service = _service()
    due = await service.schedule_send(
        user_id=OTHER, payload=_payload(), send_at=_send_at(), recipient_display=NAME
    )
    await _make_due(ledger, due["action_id"])
    before = await _row(ledger, due["action_id"])
    if placement == "unavailable":
        await ledger.execute("DROP TABLE personal_agent_registry")
    assert await get_owner_hosting_mode(OTHER) == (
        "unknown" if placement == "unavailable" else "unplaced"
    )

    result = await _drain(ledger, service)

    assert result["fired"] == 0 and gmail_http.posts == []
    row = await _row(ledger, due["action_id"])
    if placement == "unavailable":
        assert row["state"] == "scheduled" and row["attempt_count"] == 0
        assert row["payload_sealed"] == before["payload_sealed"]
    else:
        assert row["state"] == "failed" and row["attempt_count"] == 0
        assert row["safe_error_code"] == "private_runtime_required"
        assert row["payload_sealed"] is None


async def test_concurrent_drains_fire_a_due_row_once(ledger, gmail_http):
    # The first drain holds the claimed row while it re-checks the sender, so the
    # others reach that row mid-decision. The claim's row lock is what keeps them
    # out: without it every drain arms and fires the row (execute()'s own
    # prepared -> sending compare-and-set then stops all but one POST).
    service = _service(lookup_delay=0.2)
    due = await _schedule(service, _send_at())
    await _make_due(ledger, due["action_id"])

    results = await asyncio.gather(*(_drain(ledger, service) for _ in range(4)))

    assert sum(result["fired"] for result in results) == 1
    assert (await _row(ledger, due["action_id"]))["attempt_count"] == 1
    assert len(gmail_http.posts) == 1
    assert (await _row(ledger, due["action_id"]))["state"] == "sent"


async def test_drain_never_touches_an_immediate_send_however_old(ledger, gmail_http):
    """send_at IS NULL is an immediate send (or a draft send): it owns its own
    lifecycle, and Gmail may already have it. Neither the orphan reaper nor the
    stale-sending sweep may re-arm, fail or settle it."""
    service = _service()
    hour_ago = "NOW() - INTERVAL '1 hour'"
    immediate = [
        # prepare() wrote it and nobody executed it.
        await _insert(
            ledger,
            state="prepared",
            send_at=None,
            updated_at=hour_ago,
            expires_at="NOW() - INTERVAL '50 minutes'",
        ),
        # execute() or a draft send died mid-POST.
        await _insert(ledger, state="sending", send_at=None, sending_at=hour_ago),
    ]
    # A positive control in the same run: the drain did run and did claim.
    due = await _schedule(service, _send_at())
    await _make_due(ledger, due["action_id"])
    before = [await _row(ledger, action_id) for action_id in immediate]

    result = await _drain(ledger, service)

    assert result["sent"] == [due["action_id"]] and result["outcome_unknown"] == []
    assert [await _row(ledger, action_id) for action_id in immediate] == before
    assert len(gmail_http.posts) == 1


async def test_drain_never_claims_terminal_or_in_flight_scheduled_rows(ledger, gmail_http):
    service = _service()
    long_ago = "NOW() - INTERVAL '2 hours'"
    rows = []
    for state, sending_at in (
        ("outcome_unknown", long_ago),
        ("sent", long_ago),
        ("cancelled", None),
        ("failed", None),
        ("expired", None),
        # In flight for two minutes: not stale yet.
        ("sending", "NOW() - INTERVAL '2 minutes'"),
    ):
        action_id = str(uuid4())
        sealed = service.seal_schedule_payload(
            user_id=OWNER, action_id=action_id, payload=_payload()
        )
        rows.append(
            await _insert(
                ledger,
                state=state,
                send_at=long_ago,
                sending_at=sending_at,
                updated_at=long_ago,
                payload_sealed=sealed,
                subject=SUBJECT,
            )
        )
    before = [await _row(ledger, action_id) for action_id in rows]

    result = await _drain(ledger, service)

    assert result["fired"] == 0
    assert all(not result[key] for key in ("sent", "failed", "outcome_unknown", "cancelled"))
    after = [await _row(ledger, action_id) for action_id in rows]
    # The finished rows lose only the mail they no longer need (the run-start
    # scrub); state, codes, times and notification are as they were.
    for old, new in zip(before[:-1], after[:-1], strict=True):
        assert (new["payload_sealed"], new["subject"]) == (None, None), old["state"]
        assert {**old, "payload_sealed": None, "subject": None} == new
    # The row still in flight keeps everything.
    assert after[-1] == before[-1]
    assert gmail_http.posts == []


async def test_drain_settles_stale_sends_rearms_orphans_and_expires_late_rows(ledger, gmail_http):
    service = _service()
    eleven_ago = "NOW() - INTERVAL '11 minutes'"
    # A scheduled send that died mid-POST: Gmail may have it, so never resend.
    stale = await _schedule(service, _send_at())
    await ledger.execute(
        "UPDATE gmail_owner_send_actions SET state = 'sending', send_at = NOW() - INTERVAL"
        f" '1 hour', sending_at = {eleven_ago} WHERE action_id = $1",
        stale["action_id"],
    )
    # Armed, but execute() never reached sending: Gmail was never asked.
    orphan = await _schedule(service, _send_at(hours=4))
    await _make_due(ledger, orphan["action_id"], minutes_ago=30)
    await ledger.execute(
        "UPDATE gmail_owner_send_actions SET state = 'prepared', attempt_count = 1,"
        f" updated_at = {eleven_ago} WHERE action_id = $1",
        orphan["action_id"],
    )
    # Armed only moments ago: another drain may be mid-execute, so it waits.
    fresh = await _schedule(service, _send_at(hours=5))
    await _make_due(ledger, fresh["action_id"], minutes_ago=30)
    await ledger.execute(
        "UPDATE gmail_owner_send_actions SET state = 'prepared', attempt_count = 1"
        " WHERE action_id = $1",
        fresh["action_id"],
    )
    # Due a day and more ago: past its window, so it fails, never sent late.
    late = await _schedule(service, _send_at(hours=7))
    await _make_due(ledger, late["action_id"], minutes_ago=25 * 60)

    result = await _drain(ledger, service)

    assert result["outcome_unknown"] == [stale["action_id"]]
    assert result["sent"] == [orphan["action_id"]]
    assert result["failed"] == [late["action_id"]] and result["expired"] == []
    assert len(gmail_http.posts) == 1
    settled = await _row(ledger, stale["action_id"])
    assert (settled["state"], settled["safe_error_code"]) == (
        "outcome_unknown",
        "drain_interrupted",
    )
    assert (settled["payload_sealed"], settled["subject"]) == (None, None)
    rearmed = await _row(ledger, orphan["action_id"])
    assert (rearmed["state"], rearmed["attempt_count"]) == ("sent", 2)
    waiting = await _row(ledger, fresh["action_id"])
    assert (waiting["state"], waiting["attempt_count"]) == ("prepared", 1)
    overdue = await _row(ledger, late["action_id"])
    assert (overdue["state"], overdue["safe_error_code"]) == ("failed", "schedule_window_passed")
    assert (overdue["payload_sealed"], overdue["subject"]) == (None, None)


def _m252_function(name: str) -> str:
    """One function body exactly as migration 252 ships it."""
    start = M252.index(f"CREATE OR REPLACE FUNCTION {name}(")
    return M252[start : M252.index("\n$$;\n", start) + len("\n$$;\n")]


async def _install_mail_send_feed_projection(pool: Any) -> None:
    """252's mail-send projection, unchanged, over a minimal feed_events table.

    The full 252 file also wires Calendar and other Mail tables this database
    does not have; only the gmail_owner_send_actions trigger is installed.
    """
    await pool.execute(
        "CREATE TABLE feed_events (id BIGSERIAL PRIMARY KEY, user_id TEXT NOT NULL,"
        " source_domain TEXT NOT NULL, event_type TEXT NOT NULL, metadata JSONB NOT NULL,"
        " source_row_id TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL,"
        " UNIQUE (user_id, event_type, source_row_id))"
    )
    await pool.execute(_m252_function("project_calendar_mail_feed"))
    await pool.execute(_m252_function("feed_from_mail_send"))
    await pool.execute(
        "CREATE TRIGGER mail_send_feed_projection AFTER INSERT OR UPDATE"
        " ON gmail_owner_send_actions FOR EACH ROW EXECUTE FUNCTION feed_from_mail_send()"
    )


async def test_unsent_scheduled_mail_leaves_a_feed_record_through_migration_252(ledger, gmail_http):
    """Pushes can be off. A scheduled email that was never sent -- its window
    passed, or the recipient disconnected -- must still leave a lasting record,
    so it is settled ``failed`` and 252's existing trigger projects it."""
    await _install_mail_send_feed_projection(ledger)
    service = _service()
    overdue = await _schedule(service, _send_at())
    await _make_due(ledger, overdue["action_id"], minutes_ago=25 * 60)
    disconnected = await _schedule(service, _send_at(hours=4))
    await _make_due(ledger, disconnected["action_id"])

    result = await _drain(ledger, service, directory=_Directory(connected=False))

    assert result["fired"] == 0 and gmail_http.posts == []
    assert sorted(result["failed"]) == sorted([overdue["action_id"], disconnected["action_id"]])
    for action_id, code in (
        (overdue["action_id"], "schedule_window_passed"),
        (disconnected["action_id"], "recipient_disconnected"),
    ):
        row = await _row(ledger, action_id)
        assert (row["state"], row["safe_error_code"]) == ("failed", code)
        assert (row["payload_sealed"], row["subject"]) == (None, None)
    feed = await ledger.fetch(
        "SELECT user_id, source_domain, event_type, source_row_id FROM feed_events"
        " ORDER BY source_row_id"
    )
    assert [dict(item) for item in feed] == [
        {
            "user_id": OWNER,
            "source_domain": "connected_systems",
            "event_type": "mail_message_failed",
            "source_row_id": action_id,
        }
        for action_id in sorted([overdue["action_id"], disconnected["action_id"]])
    ]


async def test_a_refusal_after_the_window_closed_is_recorded_as_the_window(ledger, gmail_http):
    """execute() refuses an armed row whose window closed while it was armed; its
    own 'expired' write rolls back with that refusal. The drain's settle labels it
    by the window, and an ordinary refusal inside the window stays send_refused."""
    service = _service()
    late = await _schedule(service, _send_at())
    await _make_due(ledger, late["action_id"])
    refused = await _schedule(service, _send_at(hours=4))
    await _make_due(ledger, refused["action_id"], minutes_ago=2)
    real_execute = service.execute

    async def execute(**kwargs: Any) -> dict[str, Any]:
        if kwargs["action_id"] == refused["action_id"]:
            raise GmailDeliveryError("ACTION_NOT_SENDABLE", "refused")
        await ledger.execute(
            "UPDATE gmail_owner_send_actions SET expires_at = NOW() - INTERVAL '1 second'"
            " WHERE action_id = $1",
            kwargs["action_id"],
        )
        return await real_execute(**kwargs)

    service.execute = execute  # type: ignore[method-assign]
    push = _Push()

    result = await _drain(ledger, service, push)

    assert gmail_http.posts == []
    assert sorted(result["failed"]) == sorted([late["action_id"], refused["action_id"]])
    window = await _row(ledger, late["action_id"])
    assert (window["state"], window["safe_error_code"]) == ("failed", "schedule_window_passed")
    assert (window["payload_sealed"], window["subject"]) == (None, None)
    other = await _row(ledger, refused["action_id"])
    assert (other["state"], other["safe_error_code"]) == ("failed", "send_refused")
    assert (other["payload_sealed"], other["subject"]) == (None, None)
    assert [kwargs["notification_type"] for _, kwargs in push.sent] == ["mail_scheduled_failed"] * 2


async def test_each_run_scrubs_finished_scheduled_rows_and_nothing_else(ledger, gmail_http):
    service = _service()
    hour_ago = "NOW() - INTERVAL '1 hour'"
    finished = [
        await _insert(
            ledger,
            state=state,
            send_at=hour_ago,
            updated_at=hour_ago,
            payload_sealed="sp1.left-behind",
            subject=SUBJECT,
        )
        for state in ("sent", "failed", "outcome_unknown", "expired", "cancelled")
    ]
    # An immediate send (send_at IS NULL) is not the drain's row to scrub.
    immediate = await _insert(
        ledger, state="sent", send_at=None, updated_at=hour_ago, subject=SUBJECT
    )
    waiting = await _schedule(service, _send_at())
    kept = [immediate, waiting["action_id"]]
    before = [await _row(ledger, action_id) for action_id in finished + kept]

    result = await _drain(ledger, service)
    replay = await _drain(ledger, service)

    assert result["fired"] == replay["fired"] == 0
    for old in before[: len(finished)]:
        new = await _row(ledger, old["action_id"])
        assert {**old, "payload_sealed": None, "subject": None} == new
    assert [await _row(ledger, action_id) for action_id in kept] == before[len(finished) :]


async def test_account_reset_predicate_removes_only_the_owners_scheduled_rows(ledger):
    service = _service()
    mine = await _schedule(service, _send_at())
    theirs = await _insert(
        ledger,
        state="scheduled",
        send_at="NOW() + INTERVAL '1 hour'",
        user_id=OTHER,
        subject=SUBJECT,
    )
    reset_delete = str(AccountService()._delete_by_user_queries["gmail_owner_send_actions"])

    await ledger.execute(reset_delete.replace(":user_id", "$1"), OWNER)

    assert (
        await ledger.fetchval(
            "SELECT COUNT(*) FROM gmail_owner_send_actions WHERE action_id = $1", mine["action_id"]
        )
        == 0
    )
    assert (await _row(ledger, theirs))["state"] == "scheduled"


# --- (d) the draft-send ledger claim ------------------------------------------


async def test_draft_send_claim_admits_one_attempt_and_one_retry_after_a_refusal(ledger):
    service = _service()

    async def claim() -> tuple[str, str | None]:
        return await gmail_drafts_service._claim_send(
            delivery=service, user_id=OWNER, account=SENDER, draft_id=DRAFT_ID, recipient_count=1
        )

    claims = await _together(ledger, [claim() for _ in range(8)])
    assert sorted(claims, key=lambda item: item[1] or "") == [
        (claims[0][0], None),
        *[(claims[0][0], "sending")] * 7,
    ]
    row = await _row(ledger, claims[0][0])
    # A draft send is an immediate send: the drain's reaper must never see it.
    assert (row["state"], row["send_at"]) == ("sending", None)

    # Gmail refused it: nothing went out, so exactly one retry is admitted.
    await service._set_terminal(
        action_id=claims[0][0], state="failed", error_code="draft_send_refused"
    )
    retries = await _together(ledger, [claim() for _ in range(8)])
    assert sorted(prior or "" for _, prior in retries) == [""] + ["sending"] * 7
    assert {action_id for action_id, _ in retries} == {claims[0][0]}
    assert await ledger.fetchval("SELECT COUNT(*) FROM gmail_owner_send_actions") == 1

    # An unknown outcome is never retried.
    await service._set_outcome_unknown(action_id=claims[0][0], error_code="provider_timeout")
    assert await claim() == (claims[0][0], "outcome_unknown")


async def test_concurrent_draft_sends_post_to_gmail_once(ledger):
    gmail = _Gmail()
    refused = _GmailHttp(status=400, delay=0)

    async def send(transport: _GmailHttp) -> Any:
        return await gmail_drafts_service.send_gmail_draft(
            user_id=OWNER,
            draft_id=DRAFT_ID,
            expect_account=SENDER,
            gmail=gmail,  # type: ignore[arg-type]
            transport=httpx.MockTransport(transport),
        )

    with pytest.raises(GmailApiError):
        await send(refused)
    assert len(refused.posts) == 1

    accepted = _GmailHttp(delay=0.2)
    outcomes = await _together(ledger, [send(accepted) for _ in range(6)])
    assert len(accepted.posts) == 1
    assert str(accepted.posts[0].url) == _DRAFT_SEND_URL
    states = [outcome["state"] for outcome in outcomes if isinstance(outcome, dict)]
    assert states.count("sent") == 1
    assert all(state == "previous_unconfirmed" for state in states if state != "sent"), states
    assert all(
        isinstance(outcome, GmailApiError) and outcome.code == "GMAIL_DRAFT_ALREADY_SENT"
        for outcome in outcomes
        if not isinstance(outcome, dict)
    )
    with pytest.raises(GmailApiError) as again:
        await send(accepted)
    assert again.value.code == "GMAIL_DRAFT_ALREADY_SENT"
    assert len(accepted.posts) == 1
