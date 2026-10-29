"""A managed Files cancellation must not mistake a task for its provider thread."""

import asyncio
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from threading import Event

import pytest

from hushh_mcp.services.hosted_gcp_backend import HostedGcpBackend
from hushh_mcp.services.hosted_tier_guard import HostedTierNotPermittedError
from hushh_mcp.services.pod_files.managed_worker import upgrade_thread
from hushh_mcp.services.user_gcp_backend import UserGcpBackend
from tests.test_hosted_files_authority import _hosted_files_operation


async def test_cancelled_provider_thread_is_joined_and_new_work_is_fenced(monkeypatch):
    _, spec = _hosted_files_operation(monkeypatch, "upgrade", lambda: None)
    authority = spec.hosted_admission_guard
    started, release, exited = Event(), Event(), Event()
    applied = []

    def provider():
        started.set()
        try:
            release.wait()
            authority.require_files_work()
            applied.append(True)
        finally:
            exited.set()

    task = asyncio.create_task(upgrade_thread(spec, provider))
    try:
        assert await asyncio.to_thread(started.wait, 1)
        task.cancel()
        await asyncio.sleep(0)
        task.cancel()
        await asyncio.sleep(0)
        assert authority.files_work_stopped.is_set()
        assert not task.done() and not exited.is_set()
    finally:
        release.set()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(task, 1)
    assert exited.is_set() and applied == []
    with pytest.raises(ValueError, match="stopped"):
        authority()


async def test_cancelled_executor_proxy_waits_for_the_real_thread(monkeypatch):
    _, spec = _hosted_files_operation(monkeypatch, "upgrade", lambda: None)
    started, release, exited = Event(), Event(), Event()
    loop = asyncio.get_running_loop()
    submit = loop.run_in_executor
    proxies = []

    def capture(executor, operation, *args):
        proxy = submit(executor, operation, *args)
        proxies.append(proxy)
        return proxy

    def provider():
        started.set()
        try:
            release.wait()
        finally:
            exited.set()

    monkeypatch.setattr(loop, "run_in_executor", capture)
    task = asyncio.create_task(upgrade_thread(spec, provider))
    try:
        async with asyncio.timeout(1):
            while not started.is_set():
                await asyncio.sleep(0.001)
        assert len(proxies) == 1 and proxies[0].cancel()
        await asyncio.sleep(0.01)
        assert spec.hosted_admission_guard.files_work_stopped.is_set()
        assert not task.done() and not exited.is_set()
    finally:
        release.set()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(task, 1)
    assert exited.is_set()


async def test_queued_provider_call_cannot_start_after_cancellation(monkeypatch):
    _, spec = _hosted_files_operation(monkeypatch, "upgrade", lambda: None)
    started, release, entered = Event(), Event(), Event()
    loop = asyncio.get_running_loop()
    executor = ThreadPoolExecutor(max_workers=1)
    loop.set_default_executor(executor)

    def occupied():
        started.set()
        release.wait()

    first = loop.run_in_executor(None, occupied)
    try:
        async with asyncio.timeout(1):
            while not started.is_set():
                await asyncio.sleep(0.001)
        task = asyncio.create_task(upgrade_thread(spec, entered.set))
        await asyncio.sleep(0)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, 1)
        assert spec.hosted_admission_guard.files_work_stopped.is_set()
    finally:
        release.set()
        await first
        executor.shutdown(wait=True)
    assert not entered.is_set()


async def test_cancellation_during_hosted_preflight_joins_before_return(monkeypatch):
    started, release, exited = Event(), Event(), Event()

    def admission():
        started.set()
        try:
            release.wait()
        finally:
            exited.set()

    _, spec = _hosted_files_operation(monkeypatch, "upgrade", admission)
    backend = HostedGcpBackend(
        deployment=spec.private_gcp_deployment, authority=spec.hosted_admission_guard
    )

    async def must_not_continue(*_args):
        pytest.fail("Cancelled preflight continued into the provider upgrade")

    monkeypatch.setattr(UserGcpBackend, "upgrade", must_not_continue)
    task = asyncio.create_task(backend.upgrade(spec))
    try:
        assert await asyncio.to_thread(started.wait, 1)
        task.cancel()
        await asyncio.sleep(0)
        assert not task.done() and not exited.is_set()
    finally:
        release.set()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(task, 1)
    assert exited.is_set()


async def test_cancellation_during_authority_check_cannot_advance_work(monkeypatch):
    started, release, exited = Event(), Event(), Event()
    applied = []

    def admission():
        started.set()
        release.wait()

    _, spec = _hosted_files_operation(monkeypatch, "upgrade", admission)

    def provider():
        try:
            spec.hosted_admission_guard.require_files_work()
            applied.append(True)
        finally:
            exited.set()

    task = asyncio.create_task(upgrade_thread(spec, provider))
    try:
        assert await asyncio.to_thread(started.wait, 1)
        task.cancel()
        await asyncio.sleep(0)
        assert not task.done() and not exited.is_set()
    finally:
        release.set()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(task, 1)
    assert exited.is_set() and applied == []


def _handoff_backend(monkeypatch, spec, handoff):
    from unittest.mock import Mock

    from hushh_mcp.services import hosted_update_configuration, pod_upgrade_handoff
    from hushh_mcp.services.pod_browser import capability_update as browser_update
    from hushh_mcp.services.pod_files import capability_update
    from tests.test_pod_files_provisioning import legacy_files_fixture

    _, _, existing = legacy_files_fixture()
    existing["metadata"]["uid"] = spec.expected_service_uid
    existing["status"] = {"url": "https://synthetic.run.app", "latestReadyRevisionName": "old"}
    backend = HostedGcpBackend(
        deployment=spec.private_gcp_deployment, authority=spec.hosted_admission_guard
    )
    monkeypatch.setattr(backend, "_client", lambda: Mock(get_service=lambda _: existing))
    copy_image = Mock()
    monkeypatch.setattr(backend, "_ensure_pod_image", copy_image)
    monkeypatch.setattr(capability_update, "approved_upgrade_plan", lambda *_a, **_k: object())
    monkeypatch.setattr(browser_update, "approved_upgrade_browser_plan", lambda *_a, **_k: None)
    monkeypatch.setattr(
        hosted_update_configuration, "require_update_observation", lambda *_a, **_k: None
    )

    monkeypatch.setattr(pod_upgrade_handoff, "PodUpgradeHandoffClient", lambda **_: handoff)
    return backend, copy_image


async def test_cancellation_during_handoff_joins_before_image_copy(monkeypatch):
    started, release, exited = Event(), Event(), Event()
    _, spec = _hosted_files_operation(monkeypatch, "upgrade", lambda: None)

    class Handoff:
        def prepare_and_wait(self, **kwargs):
            started.set()
            try:
                release.wait()
                kwargs["guard"]()
            finally:
                exited.set()

    backend, copy_image = _handoff_backend(monkeypatch, spec, Handoff())
    task = asyncio.create_task(backend.upgrade(spec))
    try:
        assert await asyncio.to_thread(started.wait, 1)
        task.cancel()
        await asyncio.sleep(0)
        assert not task.done() and not exited.is_set()
    finally:
        release.set()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(task, 1)
    assert exited.is_set()
    copy_image.assert_not_called()


@pytest.mark.parametrize("failure_stage", ["prepare", "image"])
async def test_revoked_authority_refuses_handoff_release(monkeypatch, failure_stage):
    admitted = True
    released = []

    def admission():
        if not admitted:
            raise RuntimeError("owner authority revoked")

    _, spec = _hosted_files_operation(monkeypatch, "upgrade", admission)

    class Handoff:
        def prepare_and_wait(self, **kwargs):
            nonlocal admitted
            kwargs["guard"]()
            if failure_stage == "prepare":
                admitted = False
                raise RuntimeError("owner authority revoked")
            return {}

        def release(self, **kwargs):
            kwargs["guard"]()
            released.append(True)

    backend, copy_image = _handoff_backend(monkeypatch, spec, Handoff())

    def image_failure(*_args):
        nonlocal admitted
        admitted = False
        raise RuntimeError("owner authority revoked")

    copy_image.side_effect = image_failure
    with pytest.raises(RuntimeError, match="authority revoked"):
        await backend.upgrade(spec)
    assert not released
    assert copy_image.call_count == (failure_stage == "image")


async def test_hosted_files_preflight_rejects_different_authority(monkeypatch):
    _, spec = _hosted_files_operation(monkeypatch, "upgrade", lambda: None)
    backend = HostedGcpBackend(
        deployment=spec.private_gcp_deployment, authority=spec.hosted_admission_guard
    )
    changed = replace(spec, hosted_admission_guard=replace(spec.hosted_admission_guard))
    with pytest.raises(HostedTierNotPermittedError, match="authority differs"):
        await backend.upgrade(changed)


async def test_byoc_keeps_the_existing_thread_contract(monkeypatch):
    _, spec = _hosted_files_operation(monkeypatch, "upgrade", lambda: None)
    spec = replace(spec, deployment_target="user_gcp", hosted_admission_guard=None)
    assert await upgrade_thread(spec, lambda value: value + 1, 3) == 4
