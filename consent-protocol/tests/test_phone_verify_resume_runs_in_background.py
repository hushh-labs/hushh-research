"""Phone verification never waits for an own-cloud attach.

The resume after the phone can reach ``provision``, which for a Google own cloud
is a Cloud Run deploy that takes minutes. Awaiting it inside the phone-verify
request would time the request out while the attach is half done, so the claim
schedules it (``owner_cloud_attach.run_after_phone``) and returns.
"""

from __future__ import annotations

import asyncio
import logging

import pytest

from hushh_mcp.services import actor_identity_service
from hushh_mcp.services import owner_cloud_attach as attach
from hushh_mcp.services.actor_identity_service import ActorIdentityService
from tests.services.test_actor_identity_service import (
    _AliasFakePool,
    _PhoneClaimFakeConnection,
)

UID = "firebase-user-123456789012"
PHONE = "+16505550101"


@pytest.fixture(autouse=True)
def _no_leftover_tasks():
    attach._AFTER_PHONE_TASKS.clear()
    yield
    for task in attach._AFTER_PHONE_TASKS.values():
        task.cancel()
    attach._AFTER_PHONE_TASKS.clear()


async def test_the_claim_returns_while_the_attach_is_still_running(monkeypatch):
    service = ActorIdentityService()
    conn = _PhoneClaimFakeConnection()
    started, release = asyncio.Event(), asyncio.Event()
    resumed: list[tuple[str, str]] = []

    async def fake_get_pool() -> _AliasFakePool:
        return _AliasFakePool(conn)

    async def _slow_resume(user_id: str, phone: str = "") -> None:
        started.set()
        await release.wait()  # a deploy that takes minutes
        resumed.append((user_id, phone))

    monkeypatch.setattr(actor_identity_service, "get_pool", fake_get_pool)
    monkeypatch.setattr(service, "schedule_provision_personal_agent", lambda *_a, **_k: False)
    monkeypatch.setattr(service, "_resume_ai_connection", _slow_resume)

    identity = await asyncio.wait_for(
        service.claim_verified_phone(user_id=UID, phone_number=PHONE), timeout=2
    )

    assert identity is not None and identity["phone_verified"] is True
    await asyncio.wait_for(started.wait(), timeout=2)
    assert resumed == []  # the request finished first
    task = attach._AFTER_PHONE_TASKS[UID]
    release.set()
    await task
    assert resumed == [(UID, PHONE)]
    assert UID not in attach._AFTER_PHONE_TASKS


async def test_a_second_verification_while_one_resume_runs_is_a_no_op():
    release = asyncio.Event()
    calls: list[str] = []

    async def _work(user_id: str, phone: str) -> None:
        calls.append(phone)
        await release.wait()

    assert attach.run_after_phone(UID, _work, PHONE) is True
    assert attach.run_after_phone(UID, _work, PHONE) is False
    task = attach._AFTER_PHONE_TASKS[UID]
    release.set()
    await task
    assert calls == [PHONE]
    assert attach.run_after_phone(UID, _work, PHONE) is True
    await attach._AFTER_PHONE_TASKS[UID]


async def test_a_failing_resume_is_logged_by_type_and_never_raises(caplog):
    async def _boom(_user_id: str, _phone: str) -> None:
        raise RuntimeError(f"provider said {PHONE}")

    caplog.set_level(logging.WARNING, logger=attach.__name__)
    assert attach.run_after_phone(UID, _boom, PHONE) is True
    task = attach._AFTER_PHONE_TASKS[UID]
    await asyncio.gather(task, return_exceptions=True)
    await asyncio.sleep(0)
    messages = "\n".join(record.getMessage() for record in caplog.records)
    assert "resume_task_failed err=RuntimeError" in messages
    assert PHONE not in messages


def test_without_a_running_loop_nothing_is_scheduled():
    async def _work(_user_id: str, _phone: str) -> None:
        raise AssertionError("must not run")

    assert attach.run_after_phone(UID, _work, PHONE) is False
    assert attach.run_after_phone("", _work, PHONE) is False
