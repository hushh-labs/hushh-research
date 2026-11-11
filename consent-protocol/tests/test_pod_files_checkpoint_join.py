"""Hosted callbacks cannot finish while their late registry writes are running."""

import asyncio
from concurrent.futures import CancelledError as FutureCancelled
from concurrent.futures import Future, ThreadPoolExecutor
from inspect import CORO_CLOSED, getcoroutinestate
from threading import Event
from types import SimpleNamespace

import pytest

from hushh_mcp.services.compute_backend import PodSpec
from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo
from hushh_mcp.services.pod_files.capability_checkpoint import publish_on_owner_loop
from hushh_mcp.services.pod_update_capabilities import retain_late_update


async def _timeout_case(*, joined, late_failure=False):
    loop = asyncio.get_running_loop()
    started, finish, exited = asyncio.Event(), asyncio.Event(), asyncio.Event()

    async def write():
        started.set()
        try:
            await finish.wait()
            if late_failure:
                raise RuntimeError("late write failed")
        finally:
            exited.set()

    def provider():
        publish_on_owner_loop(write(), owner_loop=loop, join_on_timeout=joined, timeout=0.01)

    pending = asyncio.create_task(asyncio.to_thread(provider))
    try:
        await asyncio.wait_for(started.wait(), 1)
        if joined:
            with pytest.raises(TimeoutError):
                await asyncio.wait_for(asyncio.shield(pending), 0.05)
            assert not pending.done() and not exited.is_set()
        else:
            with pytest.raises(TimeoutError):
                await asyncio.wait_for(pending, 1)
            assert not exited.is_set()
    finally:
        finish.set()
    await asyncio.wait_for(exited.wait(), 1)
    if joined:
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(pending, 1)


@pytest.mark.parametrize("late_failure", [False, True])
async def test_timeout_joins_real_owner_callback_and_preserves_timeout(late_failure):
    await _timeout_case(joined=True, late_failure=late_failure)


async def test_byoc_callback_keeps_existing_timeout_behavior():
    await _timeout_case(joined=False)


async def test_callback_failure_before_timeout_is_not_relabelled():
    loop = asyncio.get_running_loop()

    async def write():
        raise RuntimeError("write refused")

    def provider():
        publish_on_owner_loop(write(), owner_loop=loop, join_on_timeout=True, timeout=1)

    with pytest.raises(RuntimeError, match="write refused"):
        await asyncio.to_thread(provider)


async def test_cancelled_proxy_before_start_cannot_run_callback(monkeypatch):
    loop = asyncio.get_running_loop()
    executed = []

    async def write():
        executed.append(True)

    coroutine = write()

    def cancel_before_start(supervisor, _loop):
        supervisor.close()
        proxy = Future()
        proxy.cancel()
        return proxy

    monkeypatch.setattr(asyncio, "run_coroutine_threadsafe", cancel_before_start)

    def provider():
        publish_on_owner_loop(coroutine, owner_loop=loop, join_on_timeout=True, timeout=1)

    with pytest.raises((FutureCancelled, asyncio.CancelledError)):
        await asyncio.to_thread(provider)
    assert not executed and getcoroutinestate(coroutine) == CORO_CLOSED


def test_timeout_cancels_unstarted_supervisor_without_waiting_forever(monkeypatch):
    loop = asyncio.new_event_loop()
    submitted: Future = Future()
    original_submit = asyncio.run_coroutine_threadsafe
    supervisors = []
    executed = []

    async def write():
        executed.append(True)

    coroutine = write()

    def capture(supervisor, owner_loop):
        supervisors.append(supervisor)
        proxy = original_submit(supervisor, owner_loop)
        submitted.set_result(proxy)
        return proxy

    monkeypatch.setattr(asyncio, "run_coroutine_threadsafe", capture)

    def provider():
        publish_on_owner_loop(coroutine, owner_loop=loop, join_on_timeout=True, timeout=0.01)

    try:
        with ThreadPoolExecutor(max_workers=1) as executor:
            pending = executor.submit(provider)
            proxy = submitted.result(timeout=1)
            with pytest.raises(TimeoutError):
                pending.result(timeout=1)
            assert pending.done() and proxy.cancelled()
    finally:
        for supervisor in supervisors:
            supervisor.close()
        loop.close()
    assert not executed and getcoroutinestate(coroutine) == CORO_CLOSED


async def test_supervisor_cancellation_survives_late_callback_failure():
    loop = asyncio.get_running_loop()
    started, finish = asyncio.Event(), asyncio.Event()

    async def write():
        started.set()
        await finish.wait()
        raise RuntimeError("late callback failed")

    def provider():
        publish_on_owner_loop(write(), owner_loop=loop, join_on_timeout=True, timeout=1)

    pending = loop.create_task(asyncio.to_thread(provider))
    try:
        await asyncio.wait_for(started.wait(), 1)
        supervisors = [
            task
            for task in asyncio.all_tasks()
            if task.get_coro().__qualname__.endswith("publish_on_owner_loop.<locals>.supervise")
        ]
        assert len(supervisors) == 1 and supervisors[0].cancel()
        await asyncio.sleep(0)
        assert not pending.done()
    finally:
        finish.set()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(pending, 1)


@pytest.mark.parametrize("files", [False, True])
@pytest.mark.parametrize("target", ["gcp", "user_gcp"])
async def test_late_write_uses_joined_sql_only_for_managed_files(files, target):
    received = []

    async def retain(**fields):
        received.append(fields)
        return True

    repo = SimpleNamespace(
        retain_erasure_files_upgrade_observation=retain, retain_erasure_upgrade_ack=retain
    )
    spec = PodSpec(
        hushh_id="synthetic",
        phone_e164_hash="synthetic",
        pod_pubkey="synthetic",
        deployment_target=target,
        files_upgrade_plan={},
    )
    assert await retain_late_update(repo, spec, "owner", "lease", {}, files=files)
    assert received == [
        {
            "user_id": "owner",
            "lease": "lease",
            "observation" if files else "receipt": {},
            **({"join_on_cancel": True} if target == "gcp" else {}),
        }
    ]


@pytest.mark.parametrize("port", ["files", "replacement"])
@pytest.mark.parametrize("cancel_target", ["proxy", "child"])
async def test_cancelled_callback_joins_actual_late_db_write(monkeypatch, port, cancel_target):
    loop = asyncio.get_running_loop()
    started, release, exited = Event(), Event(), Event()
    proxies, children = [], []
    original_submit = asyncio.run_coroutine_threadsafe
    original_create = asyncio.create_task

    def capture_submit(coroutine, owner_loop):
        proxy = original_submit(coroutine, owner_loop)
        proxies.append(proxy)
        return proxy

    def capture_child(coroutine):
        child = original_create(coroutine)
        children.append(child)
        return child

    class BlockingDatabase:
        def execute_raw(self, _sql, _params):
            started.set()
            try:
                release.wait()
                return SimpleNamespace(data=[{"retained": True}])
            finally:
                exited.set()

    repo = PersonalAgentRegistryRepo(BlockingDatabase())

    async def write():
        if port == "files":
            await repo.retain_erasure_files_upgrade_observation(
                user_id="synthetic", lease="lease", observation={}, join_on_cancel=True
            )
        else:
            await repo.retain_erasure_upgrade_ack(
                user_id="synthetic", lease="lease", receipt={}, join_on_cancel=True
            )

    def provider():
        publish_on_owner_loop(write(), owner_loop=loop, join_on_timeout=True, timeout=1)

    monkeypatch.setattr(asyncio, "run_coroutine_threadsafe", capture_submit)
    monkeypatch.setattr(asyncio, "create_task", capture_child)
    pending = loop.create_task(asyncio.to_thread(provider))
    try:
        assert await asyncio.to_thread(started.wait, 1)
        assert len(proxies) == len(children) == 1
        assert (proxies[0] if cancel_target == "proxy" else children[0]).cancel()
        await asyncio.sleep(0.02)
        assert not pending.done() and not exited.is_set()
    finally:
        release.set()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(pending, 1)
    assert exited.is_set()
