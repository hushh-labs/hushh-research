"""In-process background queue for outbound email delivery jobs."""

from __future__ import annotations

import asyncio
import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Literal

logger = logging.getLogger(__name__)

EmailJobKind = Literal["support_message", "invite_email"]


@dataclass(slots=True)
class EmailDeliveryJob:
    job_id: str
    kind: EmailJobKind
    queued_at: datetime
    send_callable: Callable[[], Any]
    on_success: Callable[[Any], Awaitable[None]] | None = None
    on_failure: Callable[[Exception], Awaitable[None]] | None = None
    context: dict[str, Any] = field(default_factory=dict)


class EmailDeliveryQueueService:
    """Serialize outbound email sends onto a lazy background worker."""

    def __init__(self) -> None:
        self._queue: asyncio.Queue[EmailDeliveryJob] | None = None
        self._worker_task: asyncio.Task[None] | None = None
        self._bound_loop: asyncio.AbstractEventLoop | None = None

    def _ensure_queue(self) -> asyncio.Queue[EmailDeliveryJob]:
        loop = asyncio.get_running_loop()
        if (
            self._queue is None
            or self._bound_loop is not loop
            or self._worker_task is None
            or self._worker_task.done()
        ):
            self._bound_loop = loop
            self._queue = asyncio.Queue()
            self._worker_task = loop.create_task(self._worker(), name="email-delivery-worker")
        return self._queue

    async def _worker(self) -> None:
        queue = self._queue
        if queue is None:
            raise RuntimeError("Email delivery worker started without an initialized queue")
        while True:
            try:
                job = await queue.get()
            except asyncio.CancelledError:
                break

            try:
                result = await asyncio.to_thread(job.send_callable)
            except Exception as exc:  # noqa: BLE001
                logger.exception(
                    "email_delivery.job_failed job_id=%s kind=%s context=%s",
                    job.job_id,
                    job.kind,
                    job.context,
                )
                if job.on_failure is not None:
                    try:
                        await job.on_failure(exc)
                    except Exception:  # noqa: BLE001
                        logger.exception(
                            "email_delivery.failure_callback_failed job_id=%s kind=%s",
                            job.job_id,
                            job.kind,
                        )
            else:
                if job.on_success is not None:
                    try:
                        await job.on_success(result)
                    except Exception:  # noqa: BLE001
                        logger.exception(
                            "email_delivery.success_callback_failed job_id=%s kind=%s",
                            job.job_id,
                            job.kind,
                        )
            finally:
                queue.task_done()

    async def enqueue(
        self,
        *,
        kind: EmailJobKind,
        send_callable: Callable[[], Any],
        on_success: Callable[[Any], Awaitable[None]] | None = None,
        on_failure: Callable[[Exception], Awaitable[None]] | None = None,
        context: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        queued_at = datetime.now(tz=timezone.utc)
        job = EmailDeliveryJob(
            job_id=uuid.uuid4().hex,
            kind=kind,
            queued_at=queued_at,
            send_callable=send_callable,
            on_success=on_success,
            on_failure=on_failure,
            context=dict(context or {}),
        )
        await self._ensure_queue().put(job)
        return {
            "accepted": True,
            "delivery_status": "queued",
            "job_id": job.job_id,
            "kind": job.kind,
            "queued_at": queued_at.isoformat().replace("+00:00", "Z"),
            "queue_depth": self._queue.qsize() if self._queue is not None else 0,
        }

    async def wait_for_idle(self) -> None:
        if self._queue is not None:
            await self._queue.join()

    async def shutdown(self) -> None:
        worker = self._worker_task
        self._worker_task = None
        self._queue = None
        self._bound_loop = None
        if worker is None or worker.done():
            return
        worker.cancel()
        try:
            await worker
        except asyncio.CancelledError:
            pass


_email_delivery_queue_service: EmailDeliveryQueueService | None = None


def get_email_delivery_queue_service() -> EmailDeliveryQueueService:
    global _email_delivery_queue_service
    if _email_delivery_queue_service is None:
        _email_delivery_queue_service = EmailDeliveryQueueService()
    return _email_delivery_queue_service


async def shutdown_email_delivery_queue_service() -> None:
    global _email_delivery_queue_service
    if _email_delivery_queue_service is None:
        return
    service = _email_delivery_queue_service
    _email_delivery_queue_service = None
    await service.shutdown()
