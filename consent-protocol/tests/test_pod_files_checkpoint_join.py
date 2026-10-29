"""A timed-out owner-loop receipt can still hold a real registry write."""

import asyncio
from concurrent.futures import Future, ThreadPoolExecutor, TimeoutError
from threading import Event

import pytest

from hushh_mcp.services.pod_files.capability_checkpoint import await_owned_publication


def test_joined_timeout_waits_for_the_actual_receipt_before_returning():
    receipt = Future()
    entered = Event()

    def worker():
        entered.set()
        await_owned_publication(receipt, join_on_timeout=True, timeout=0.01)

    with ThreadPoolExecutor(max_workers=1) as executor:
        pending = executor.submit(worker)
        assert entered.wait(1)
        with pytest.raises(TimeoutError):
            pending.result(timeout=0.05)
        assert not pending.done()
        receipt.set_result(None)
        with pytest.raises(TimeoutError):
            pending.result(timeout=1)
    assert receipt.done()


def test_legacy_callback_keeps_its_existing_timeout_behavior():
    receipt = Future()
    with pytest.raises(TimeoutError):
        await_owned_publication(receipt, join_on_timeout=False, timeout=0.01)
    assert not receipt.done()


def test_joined_timeout_keeps_the_original_timeout_when_late_receipt_fails():
    receipt = Future()
    entered = Event()

    def worker():
        entered.set()
        await_owned_publication(receipt, join_on_timeout=True, timeout=0.01)

    with ThreadPoolExecutor(max_workers=1) as executor:
        pending = executor.submit(worker)
        assert entered.wait(1)
        with pytest.raises(TimeoutError):
            pending.result(timeout=0.05)
        assert not pending.done()
        receipt.set_exception(RuntimeError("late write failed"))
        with pytest.raises(TimeoutError):
            pending.result(timeout=1)


def test_callback_failure_before_timeout_is_not_relabelled():
    receipt = Future()
    receipt.set_exception(RuntimeError("write refused"))
    with pytest.raises(RuntimeError, match="write refused"):
        await_owned_publication(receipt, join_on_timeout=True, timeout=0.01)


async def test_timeout_waits_for_a_real_owner_loop_publication():
    loop = asyncio.get_running_loop()
    started = asyncio.Event()
    finish = asyncio.Event()
    written = asyncio.Event()

    async def publish():
        started.set()
        await finish.wait()
        written.set()

    def worker():
        receipt = asyncio.run_coroutine_threadsafe(publish(), loop)
        await_owned_publication(receipt, join_on_timeout=True, timeout=0.01)

    pending = asyncio.create_task(asyncio.to_thread(worker))
    try:
        await asyncio.wait_for(started.wait(), 1)
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(asyncio.shield(pending), 0.05)
        assert not pending.done()
    finally:
        finish.set()
    with pytest.raises(TimeoutError):
        await asyncio.wait_for(pending, 1)
    assert written.is_set()


async def test_cancelled_publication_proxy_is_not_a_worker_exit_witness():
    loop = asyncio.get_running_loop()
    started, release, exited = Event(), Event(), Event()
    unwound = asyncio.Event()

    def database_work():
        started.set()
        try:
            release.wait()
        finally:
            exited.set()

    async def publish():
        try:
            await asyncio.to_thread(database_work)
        finally:
            unwound.set()

    proxy = asyncio.run_coroutine_threadsafe(publish(), loop)
    try:
        assert await asyncio.to_thread(started.wait, 1)
        assert proxy.cancel()
        await asyncio.wait_for(unwound.wait(), 1)
        assert proxy.done()
        assert not exited.is_set()
    finally:
        release.set()
        assert await asyncio.to_thread(exited.wait, 1)
