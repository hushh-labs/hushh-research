"""Completion contracts: one owner notice per committed erasure, and an early drain."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager, suppress
from types import SimpleNamespace
from unittest.mock import ANY, AsyncMock

import pytest

from hushh_mcp.services import account_cleanup_runtime as runtime
from hushh_mcp.services import account_deletion_lifecycle_service as lifecycle
from hushh_mcp.services import account_deletion_provider_journal as journal
from hushh_mcp.services import account_deletion_provider_worker as worker
from hushh_mcp.services import support_email_service as mail


def _claim(uid: str) -> journal.ProviderCleanupClaim:
    return journal.ProviderCleanupClaim("owner", uid, "cleanup", "token", {}, {})


@pytest.fixture
def notices(monkeypatch):
    events: list[str] = []

    @asynccontextmanager
    async def admitted():
        events.append("admission_open")
        yield SimpleNamespace(check=AsyncMock())
        events.append("admission_closed")

    async def send(uid, kind, *, identity_lookup):
        assert identity_lookup(uid) == uid  # The retained sign-in, never an owner lookup.
        events.append(f"notice:{uid}:{kind}")

    monkeypatch.setattr(worker, "release_admission", admitted)
    _sender(monkeypatch, delivery_mode="test", test_to_email="qa@example.com")
    monkeypatch.setattr(mail, "send_verified_account_notice", AsyncMock(side_effect=send))
    return events


def _sender(monkeypatch, **config) -> None:
    sender = SimpleNamespace(configured=True, **config)
    monkeypatch.setattr(mail.SupportEmailConfig, "from_env", classmethod(lambda cls: sender))


@pytest.mark.parametrize("erased", [True, False])
async def test_notice_follows_only_a_committed_erasure(monkeypatch, notices, erased):
    monkeypatch.setattr(worker, "_run_admitted_claim", AsyncMock(return_value=erased))

    assert await worker.run_claim(_claim("retained-uid")) is erased

    if erased:
        # Sent once, after the release admission closed.
        assert notices == [
            "admission_open",
            "admission_closed",
            "notice:retained-uid:account_deleted",
        ]
    else:
        assert notices == ["admission_open", "admission_closed"]


@pytest.mark.parametrize(
    ("environment", "mode", "test_inbox", "sent"),
    [
        ("production", "live", None, True),
        ("uat", "test", "qa@example.com", True),
        # Shared Dev reads production sign-ins in live mode: never mail a real owner.
        ("dev", "live", None, False),
    ],
)
async def test_non_production_notice_only_reaches_a_test_inbox(
    monkeypatch, notices, environment, mode, test_inbox, sent
):
    monkeypatch.setenv("ENVIRONMENT", environment)
    _sender(monkeypatch, delivery_mode=mode, test_to_email=test_inbox)
    monkeypatch.setattr(worker, "_run_admitted_claim", AsyncMock(return_value=True))

    assert await worker.run_claim(_claim("retained-uid"))

    assert ("notice:retained-uid:account_deleted" in notices) is sent


async def test_drain_sends_one_notice_per_erasure_and_contains_a_failed_send(monkeypatch, notices):
    queue = [[_claim("erased-uid")], [_claim("pending-uid")], []]
    released: list[str] = []

    async def store_call(fn, *args, **kwargs):
        if fn is journal.available:
            return True
        if fn is journal.claim_due:
            return queue.pop(0)
        if fn is journal.release:
            released.append(args[0].firebase_uid)
            return None
        raise AssertionError(fn)

    monkeypatch.setattr(worker, "_store_call", store_call)
    monkeypatch.setattr(worker, "_run_admitted_claim", AsyncMock(side_effect=[True, False]))
    mail.send_verified_account_notice.side_effect = RuntimeError("synthetic delivery failure")

    outcome = await worker.drain_with_outcome(limit=5)

    assert (outcome.settled, outcome.paused_reason) == (1, None)
    mail.send_verified_account_notice.assert_awaited_once_with(
        "erased-uid", "account_deleted", identity_lookup=ANY
    )
    assert released == ["pending-uid"]  # An erased claim is final, never released.


async def test_wake_drains_before_the_next_tick(monkeypatch):
    calls: list[int] = []
    second = asyncio.Event()

    async def drain():
        calls.append(1)
        if len(calls) == 2:
            second.set()

    monkeypatch.setattr(runtime, "_wake", None)
    monkeypatch.setattr(lifecycle, "drain_account_deletion_cleanup_intents", drain)
    loop = asyncio.create_task(runtime._account_deletion_cleanup_loop(3600))
    try:
        await asyncio.sleep(0.05)
        assert calls == [1]  # Idle until the hour-long tick: no wake, no drain.
        runtime.wake_cleanup_worker()
        await asyncio.wait_for(second.wait(), timeout=2)
    finally:
        loop.cancel()
        with suppress(asyncio.CancelledError):
            await loop
