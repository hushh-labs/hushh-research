"""Bounded Browser work ownership; synthetic fixtures are not cloud acceptance."""

import asyncio

import pytest

from hushh_mcp.services.pod_browser.contracts import BrowserRefused
from tests.helpers.pod_browser import approved_task, task_runtime_fixture


@pytest.mark.parametrize(
    "fault", ["none", "lost_publication_reply", "delivery_lost", "queued", "duplicate"]
)
async def test_browser_delivery_owns_existing_task_without_replaying_goal(monkeypatch, fault):
    from hushh_mcp.services.pod_browser.delivery import hold_delivery

    fixture = task_runtime_fixture(monkeypatch)
    deliveries, holders = [], []
    checks, at_claim = {}, asyncio.Event()

    async def checked():
        await fixture.owner.check()
        if fault != "duplicate":
            return
        current = asyncio.current_task()
        checks[current] = checks.get(current, 0) + 1
        if sum(count >= 2 for count in checks.values()) == 2:
            at_claim.set()
        if checks[current] == 2:
            await at_claim.wait()

    class Delivery:
        def require_ready(self):
            return None

        async def publish(self, binding, message):
            deliveries.append(message)
            if fault == "queued":
                return
            for _ in range(2 if fault == "duplicate" else 1):
                holders.append(
                    asyncio.create_task(
                        hold_delivery(
                            fixture.runtime,
                            message,
                            check=checked,
                            clock=lambda: 1000,
                        )
                    )
                )
            if fault == "lost_publication_reply":
                raise BrowserRefused("BROWSER_TASK_DELIVERY_UNCONFIRMED")

    fixture.runtime._delivery = Delivery()
    try:
        if fault == "lost_publication_reply":
            for _ in range(2):
                failed = await fixture.runtime.start(fixture.owner, fixture.request)
                assert (
                    failed.phase == "unavailable"
                    and failed.code == "BROWSER_TASK_DELIVERY_UNCONFIRMED"
                )
            assert len(deliveries) == 1 and fixture.launcher.calls == 0
        else:
            if fault == "queued":
                queued = await fixture.runtime.start(fixture.owner, fixture.request)
                assert queued.code == "BROWSER_WAITING_FOR_WORKER" and fixture.launcher.calls == 0
                same = await fixture.runtime.start(fixture.owner, fixture.request)
                assert same.binding == queued.binding and len(deliveries) == 1
                holders.append(
                    asyncio.create_task(
                        hold_delivery(
                            fixture.runtime,
                            deliveries[0],
                            check=fixture.owner.check,
                            clock=lambda: 1000,
                        )
                    )
                )
            started = await approved_task(fixture)
            task_id = started.binding.task_id
            same = await fixture.runtime.start(fixture.owner, fixture.request)
            assert (
                same.binding == started.binding and len(deliveries) == fixture.launcher.calls == 1
            )
            if fault == "duplicate":
                duplicate = [holder for holder in holders if holder.done()]
                assert len(duplicate) == 1 and duplicate[0].result() == {"state": "duplicate"}
                holders.remove(duplicate[0])
            assert not holders[0].done()
            wrong = deliveries[0].model_copy(update={"delivery": "0" * 32})
            assert await hold_delivery(fixture.runtime, wrong, check=fixture.owner.check) == {
                "state": "interrupted"
            }
            assert not holders[0].done()
            if fault == "delivery_lost":
                holders[0].cancel()
                await asyncio.gather(holders[0], return_exceptions=True)
                terminal = await fixture.runtime.read(fixture.owner, task_id)
                assert (
                    terminal.phase == "cancelled" and terminal.code == "BROWSER_TASK_DELIVERY_ENDED"
                )
                assert fixture.admission._states["epoch"].active == 0
            else:
                fixture.model.release.set()
                await fixture.runtime._tasks[task_id].worker
                assert await asyncio.wait_for(holders[0], 1) == {"state": "completed"}
    finally:
        await fixture.runtime.drain()
        await asyncio.gather(*holders, return_exceptions=True)


async def test_browser_start_ack_waits_for_durable_publication_not_worker_attachment(monkeypatch):
    fixture = task_runtime_fixture(monkeypatch)
    publishing, acknowledged = asyncio.Event(), asyncio.Event()

    class Delivery:
        def require_ready(self):
            pass

        async def publish(self, binding, message):
            publishing.set()
            await acknowledged.wait()

    fixture.runtime._delivery = Delivery()
    started = asyncio.create_task(fixture.runtime.start(fixture.owner, fixture.request))
    await publishing.wait()
    await asyncio.sleep(0.2)
    assert not started.done()  # HTTP still owns request-based CPU for publication
    acknowledged.set()
    snapshot = await started
    task = fixture.runtime._tasks[snapshot.binding.task_id]
    assert snapshot.code == "BROWSER_WAITING_FOR_WORKER" and not task.delivery_attached.is_set()
    await fixture.runtime.control(
        fixture.owner, task.binding.task_id, "cancel", snapshot.control_epoch
    )
    assert task.closed and fixture.admission._states["epoch"].active == 0
