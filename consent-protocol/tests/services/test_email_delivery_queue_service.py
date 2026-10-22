from __future__ import annotations

import asyncio

import pytest

from hushh_mcp.services import email_delivery_queue_service as queue_module
from hushh_mcp.services.email_delivery_queue_service import (
    EmailDeliveryQueueService,
    EmailDeliveryQueueUnavailable,
)


@pytest.mark.asyncio
async def test_email_delivery_queue_runs_success_callback():
    service = EmailDeliveryQueueService()
    calls: list[str] = []
    callback_results: list[dict[str, str]] = []

    def _send():
        calls.append("send")
        return {"message_id": "msg_1"}

    async def _on_success(result):
        callback_results.append(result)

    try:
        ack = await service.enqueue(
            kind="support_message",
            send_callable=_send,
            on_success=_on_success,
            context={"user_id": "user_1"},
        )

        assert ack["delivery_status"] == "queued"
        await service.wait_for_idle()

        assert calls == ["send"]
        assert callback_results == [{"message_id": "msg_1"}]
    finally:
        await service.shutdown()


@pytest.mark.asyncio
async def test_email_delivery_queue_runs_failure_callback():
    service = EmailDeliveryQueueService()
    callback_errors: list[str] = []

    def _send():
        raise RuntimeError("boom")

    async def _on_failure(exc):
        callback_errors.append(str(exc))

    try:
        ack = await service.enqueue(
            kind="invite_email",
            send_callable=_send,
            on_failure=_on_failure,
            context={"invite_id": "invite_1"},
        )

        assert ack["delivery_status"] == "queued"
        await service.wait_for_idle()

        assert callback_errors == ["boom"]
    finally:
        await service.shutdown()


@pytest.mark.asyncio
async def test_queue_saturation_is_explicit_and_shutdown_drains_accepted_jobs(monkeypatch):
    service = EmailDeliveryQueueService(max_pending=1, shutdown_timeout_seconds=1)
    started, release = asyncio.Event(), asyncio.Event()
    sent: list[str] = []

    async def send_in_thread(sender):
        started.set()
        await release.wait()
        return sender()

    monkeypatch.setattr(queue_module.asyncio, "to_thread", send_in_thread)
    shutdown = None
    try:
        await service.enqueue(kind="invite_email", send_callable=lambda: sent.append("first"))
        await asyncio.wait_for(started.wait(), timeout=1)
        # An empty queue can still have an active sender on the old loop.
        with monkeypatch.context() as context:
            context.setattr(queue_module.asyncio, "get_running_loop", lambda: object())
            with pytest.raises(EmailDeliveryQueueUnavailable, match="another event loop"):
                service._ensure_queue()
        await service.enqueue(kind="invite_email", send_callable=lambda: sent.append("second"))
        with pytest.raises(EmailDeliveryQueueUnavailable, match="backlog is full"):
            await service.enqueue(
                kind="invite_email", send_callable=lambda: sent.append("rejected")
            )
        shutdown = asyncio.create_task(service.shutdown())
        await asyncio.sleep(0)
        with pytest.raises(EmailDeliveryQueueUnavailable, match="shutting down"):
            await service.enqueue(kind="invite_email", send_callable=lambda: sent.append("late"))
        release.set()
        await asyncio.wait_for(shutdown, timeout=1)
        assert sent == ["first", "second"]
        assert service._worker_task is None
    finally:
        release.set()
        if shutdown is not None:
            await asyncio.gather(shutdown, return_exceptions=True)
        await service.shutdown()


@pytest.mark.asyncio
async def test_shutdown_marks_unsent_jobs_but_never_retries_an_uncertain_send(monkeypatch, caplog):
    service = EmailDeliveryQueueService(max_pending=1, shutdown_timeout_seconds=0.01)
    started, release = asyncio.Event(), asyncio.Event()
    failures: list[str] = []
    sends: list[str] = []

    async def send_in_thread(sender):
        started.set()
        await release.wait()
        return sender()

    async def failed(error):
        failures.append(str(error))

    monkeypatch.setattr(queue_module.asyncio, "to_thread", send_in_thread)
    monkeypatch.setattr(queue_module, "_email_delivery_queue_service", service)
    await service.enqueue(
        kind="invite_email", send_callable=lambda: sends.append("active"), on_failure=failed
    )
    await asyncio.wait_for(started.wait(), timeout=1)
    await service.enqueue(
        kind="invite_email", send_callable=lambda: sends.append("pending"), on_failure=failed
    )
    shutdown = asyncio.create_task(queue_module.shutdown_email_delivery_queue_service())
    try:
        await asyncio.sleep(0)
        assert queue_module.get_email_delivery_queue_service() is service
        with pytest.raises(EmailDeliveryQueueUnavailable, match="shutting down"):
            await service.enqueue(kind="invite_email", send_callable=lambda: sends.append("late"))
        await asyncio.wait_for(shutdown, timeout=1)
        assert sends == []
        assert failures == ["Email stopped before sending"]
        assert "email_delivery.send_outcome_uncertain" in caplog.text
        assert queue_module._email_delivery_queue_service is None
    finally:
        release.set()
        await asyncio.gather(shutdown, return_exceptions=True)
        await service.shutdown()
