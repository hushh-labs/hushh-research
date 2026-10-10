"""Foreground saves must not be blocked by registry or idle push work."""

import asyncio
import threading
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from hushh_mcp.services import circle_chat_notifications as circle
from hushh_mcp.services import direct_message_notifications as direct
from hushh_mcp.services.domain_registry_service import DomainRegistryService


@pytest.mark.asyncio
@pytest.mark.parametrize("lazy", [False, True])
async def test_registry_handles_eager_and_lazy_rpc_off_loop_without_duplicate_upsert(lazy):
    owner_thread = threading.get_ident()
    threads = []

    def result():
        threads.append(threading.get_ident())
        return SimpleNamespace(data=[{"auto_register_domain": {"domain_key": "example_business"}}])

    def rpc(*_args):
        threads.append(threading.get_ident())
        return SimpleNamespace(execute=result) if lazy else result()

    service = DomainRegistryService()
    service._db = SimpleNamespace(
        rpc=rpc, table=Mock(side_effect=AssertionError("duplicate upsert"))
    )
    domain = await service.register_domain("example_business", description=None)
    assert domain.domain_key == "example_business"
    assert threads and all(thread != owner_thread for thread in threads)
    service._db.table.assert_not_called()


@pytest.mark.asyncio
async def test_registry_read_executes_off_loop():
    owner_thread = threading.get_ident()
    threads = []
    query = Mock()
    query.select.return_value = query
    query.eq.return_value = query

    def execute():
        threads.append(threading.get_ident())
        return SimpleNamespace(data=[{"domain_key": "professional"}])

    query.execute.side_effect = execute
    service = DomainRegistryService()
    service._db = SimpleNamespace(table=lambda _: query)
    assert (await service.get_domain("professional")).domain_key == "professional"
    assert threads and threads[0] != owner_thread


def test_circle_batch_counts_work_and_keeps_the_drain_bound(monkeypatch):
    dispatch = Mock(side_effect=[True, True, False])
    monkeypatch.setattr(circle, "_dispatch_one", dispatch)
    assert circle.dispatch_circle_chat_pushes() == 2
    assert dispatch.call_count == 3
    dispatch.side_effect = None
    dispatch.return_value = True
    dispatch.reset_mock()
    assert circle.dispatch_circle_chat_pushes() == 20
    assert dispatch.call_count == 20


@pytest.mark.asyncio
@pytest.mark.parametrize("module", [circle, direct])
async def test_idle_push_sweeps_back_off_reset_and_propagate_cancellation(monkeypatch, module):
    owner_thread = threading.get_ident()
    threads = []
    sleeps = []
    results = iter([0, 0, 0, 0, 2, 0, RuntimeError("unavailable"), 0])

    def dispatch():
        threads.append(threading.get_ident())
        result = next(results)
        if isinstance(result, Exception):
            raise result
        return result

    async def sleep(delay):
        sleeps.append(delay)
        if len(sleeps) == 8:
            raise asyncio.CancelledError

    name = "dispatch_circle_chat_pushes" if module is circle else "dispatch_direct_message_pushes"
    monkeypatch.setattr(module, name, dispatch)
    if module is circle:

        async def wait_for(waiter, timeout):
            waiter.close()
            await sleep(timeout)
            raise TimeoutError

        monkeypatch.setattr(module.asyncio, "wait_for", wait_for)
        monkeypatch.setattr(circle, "_wakeup", None)
        monkeypatch.setattr(
            circle,
            "get_db",
            lambda: SimpleNamespace(engine=SimpleNamespace(pool=SimpleNamespace(size=lambda: 2))),
        )
    else:
        monkeypatch.setattr(module.asyncio, "sleep", sleep)
    worker = (
        module.run_circle_chat_push_worker
        if module is circle
        else module.run_direct_message_push_worker
    )
    with pytest.raises(asyncio.CancelledError):
        await worker()
    assert sleeps == [1, 2, 4, 5, 1, 1, 2, 4]
    assert len(threads) == len(sleeps)
    assert all(thread != owner_thread for thread in threads)


@pytest.mark.asyncio
async def test_circle_wakeup_drains_full_batches_before_waiting_again(monkeypatch):
    wait_for = asyncio.wait_for
    waiting = asyncio.Queue()
    waits = []
    dispatch = Mock(side_effect=[0, 20, 20, 0])

    async def wait_for_wakeup(waiter, timeout):
        waits.append((dispatch.call_count, timeout))
        waiting.put_nowait(dispatch.call_count)
        return await wait_for(waiter, timeout=60)

    monkeypatch.setattr(circle.asyncio, "wait_for", wait_for_wakeup)
    monkeypatch.setattr(circle, "_wakeup", None)
    monkeypatch.setattr(circle, "dispatch_circle_chat_pushes", dispatch)
    monkeypatch.setattr(
        circle,
        "get_db",
        lambda: SimpleNamespace(engine=SimpleNamespace(pool=SimpleNamespace(size=lambda: 2))),
    )
    task = asyncio.create_task(circle.run_circle_chat_push_worker())
    try:
        assert await wait_for(waiting.get(), timeout=2) == 1
        circle.wake_circle_chat_push_worker()
        assert await wait_for(waiting.get(), timeout=2) == 4
        assert waits == [(1, 1), (4, 2)]
    finally:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
