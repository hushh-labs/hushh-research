"""Tests for transfer status notification task reference retention.

BrokerFundingService._queue_transfer_status_notification_if_needed starts the
push notification with loop.create_task. asyncio keeps only a weak reference
to such tasks, so without an external strong reference the task can be garbage
collected before it finishes, silently dropping the transfer status push that
tells a user their money movement completed, failed, returned, or canceled.

The fix retains the task in the module-level _transfer_notification_tasks set
until its done callback removes it. These tests drive the real method on the
real service singleton and assert:

1. A notifiable status change registers a strong reference while the task runs.
2. The scheduled notification actually runs to completion.
3. The reference is removed after completion so the set does not leak.
4. A non-notifiable change schedules nothing.

Reachable from api/routes/kai/plaid.py POST /plaid/transfers/create, which
calls BrokerFundingService.create_transfer, which queues the notification.
"""

from __future__ import annotations

import asyncio

import pytest

from hushh_mcp.services import broker_funding_service as bf_module
from hushh_mcp.services.broker_funding_service import get_broker_funding_service


def _install_fake_sender(service):
    started = asyncio.Event()
    finished = asyncio.Event()
    calls: list[dict] = []

    async def _fake_send(**kwargs):
        started.set()
        await asyncio.sleep(0)
        calls.append(kwargs)
        finished.set()

    service._send_transfer_status_notification = _fake_send  # type: ignore[assignment]
    return started, finished, calls


@pytest.mark.asyncio
async def test_notifiable_status_change_retains_then_releases_task():
    service = get_broker_funding_service()
    started, finished, calls = _install_fake_sender(service)
    bf_module._transfer_notification_tasks.clear()

    service._queue_transfer_status_notification_if_needed(
        user_id="user_1",
        transfer_id="transfer_1",
        previous_status=None,
        current_status="COMPLETED",
        amount_text="$100.00",
        direction="deposit",
        failure_reason=None,
    )

    assert len(bf_module._transfer_notification_tasks) == 1
    tracked_task = next(iter(bf_module._transfer_notification_tasks))

    await asyncio.wait_for(started.wait(), timeout=1.0)
    await asyncio.wait_for(tracked_task, timeout=1.0)

    assert finished.is_set()
    assert len(calls) == 1
    assert calls[0]["user_id"] == "user_1"
    assert calls[0]["transfer_id"] == "transfer_1"
    assert calls[0]["user_facing_status"] == "completed"
    assert tracked_task not in bf_module._transfer_notification_tasks


@pytest.mark.asyncio
async def test_notification_runs_to_completion():
    service = get_broker_funding_service()
    _started, _finished, calls = _install_fake_sender(service)
    bf_module._transfer_notification_tasks.clear()

    service._queue_transfer_status_notification_if_needed(
        user_id="user_2",
        transfer_id="transfer_2",
        previous_status="PENDING",
        current_status="FAILED",
        amount_text="$50.00",
        direction="withdrawal",
        failure_reason="insufficient funds",
    )

    await asyncio.gather(*list(bf_module._transfer_notification_tasks))

    assert [call["user_facing_status"] for call in calls] == ["failed"]
    assert len(bf_module._transfer_notification_tasks) == 0


@pytest.mark.asyncio
async def test_non_notifiable_change_schedules_nothing():
    service = get_broker_funding_service()
    _started, _finished, calls = _install_fake_sender(service)
    bf_module._transfer_notification_tasks.clear()

    # Both statuses map to the same user facing state, so no push is queued.
    service._queue_transfer_status_notification_if_needed(
        user_id="user_3",
        transfer_id="transfer_3",
        previous_status="PENDING",
        current_status="QUEUED",
        amount_text="$25.00",
        direction="deposit",
        failure_reason=None,
    )

    assert len(bf_module._transfer_notification_tasks) == 0
    assert calls == []
