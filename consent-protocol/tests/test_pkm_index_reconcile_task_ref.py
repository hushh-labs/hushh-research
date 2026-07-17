"""Tests for background index reconcile task reference retention.

PersonalKnowledgeModelService._schedule_index_reconcile starts a self-heal
reconcile with asyncio.create_task. asyncio keeps only a weak reference to
such tasks, so without an external strong reference the task can be garbage
collected before it finishes, silently skipping the reconcile.

The fix retains the task in the instance-level _background_reconcile_tasks set
(matching the pattern used by gmail_receipts_service and plaid_portfolio_service)
until its done callback removes it. These tests drive the real method and assert:

1. Scheduling registers a strong reference while the task runs.
2. The scheduled coroutine actually runs to completion.
3. The reference is removed after completion so the set does not leak.
4. Scheduling outside a running event loop is handled without raising.

Reachable from api/routes/developer.py get metadata view, which calls
PersonalKnowledgeModelService.resolve_metadata_index with self heal enabled.
"""

from __future__ import annotations

import asyncio

import pytest

from hushh_mcp.services.personal_knowledge_model_service import get_pkm_service


@pytest.mark.asyncio
async def test_schedule_index_reconcile_retains_then_releases_task():
    service = get_pkm_service()
    service._background_reconcile_tasks.clear()
    started = asyncio.Event()
    finished = asyncio.Event()

    async def _fake_reconcile(user_id: str):
        started.set()
        await asyncio.sleep(0)
        finished.set()
        return {"user_id": user_id, "reconciled": True}

    service.reconcile_user_index_domains = _fake_reconcile  # type: ignore[assignment]

    service._schedule_index_reconcile("user_xyz")

    assert len(service._background_reconcile_tasks) == 1
    tracked_task = next(iter(service._background_reconcile_tasks))

    await asyncio.wait_for(started.wait(), timeout=1.0)
    await asyncio.wait_for(tracked_task, timeout=1.0)

    assert finished.is_set()
    assert tracked_task not in service._background_reconcile_tasks


@pytest.mark.asyncio
async def test_schedule_index_reconcile_runs_real_method_to_completion():
    service = get_pkm_service()
    service._background_reconcile_tasks.clear()
    calls: list[str] = []

    async def _fake_reconcile(user_id: str):
        calls.append(user_id)

    service.reconcile_user_index_domains = _fake_reconcile  # type: ignore[assignment]

    service._schedule_index_reconcile("user_abc")

    pending = list(service._background_reconcile_tasks)
    await asyncio.gather(*pending)

    assert calls == ["user_abc"]
    assert len(service._background_reconcile_tasks) == 0


def test_schedule_index_reconcile_without_event_loop_does_not_raise():
    service = get_pkm_service()
    service._background_reconcile_tasks.clear()

    service._schedule_index_reconcile("user_no_loop")

    assert len(service._background_reconcile_tasks) == 0
