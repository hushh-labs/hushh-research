from __future__ import annotations

import pytest

from hushh_mcp.services.email_delivery_queue_service import EmailDeliveryQueueService


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
async def test_success_callback_failure_does_not_stop_worker():
    service = EmailDeliveryQueueService()

    calls: list[str] = []
    completed: list[str] = []

    def send_job_1():
        calls.append("job1")
        return {"message_id": "msg1"}

    def send_job_2():
        calls.append("job2")
        return {"message_id": "msg2"}

    async def failing_success_callback(_result):
        raise RuntimeError("callback failed")

    async def success_callback(result):
        completed.append(result["message_id"])

    try:
        ack1 = await service.enqueue(
            kind="support_message",
            send_callable=send_job_1,
            on_success=failing_success_callback,
        )

        ack2 = await service.enqueue(
            kind="support_message",
            send_callable=send_job_2,
            on_success=success_callback,
        )

        assert ack1["delivery_status"] == "queued"
        assert ack2["delivery_status"] == "queued"

        await service.wait_for_idle()

        assert calls == ["job1", "job2"]
        assert completed == ["msg2"]

    finally:
        await service.shutdown()
