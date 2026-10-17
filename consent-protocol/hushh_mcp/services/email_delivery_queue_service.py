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


class EmailDeliveryQueueUnavailable(RuntimeError):
    """The in-process delivery worker cannot accept another job."""


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

    def __init__(self, *, max_pending: int = 1024, shutdown_timeout_seconds: float = 5.0) -> None:
        if max_pending < 1 or shutdown_timeout_seconds < 0:
            raise ValueError("Invalid email delivery queue capacity or shutdown timeout")
        self._max_pending = max_pending
        self._shutdown_timeout_seconds = shutdown_timeout_seconds
        self._closing = False
        self._active_job: EmailDeliveryJob | None = None
        self._queue: asyncio.Queue[EmailDeliveryJob] | None = None
        self._worker_task: asyncio.Task[None] | None = None
        self._bound_loop: asyncio.AbstractEventLoop | None = None

    def _ensure_queue(self) -> asyncio.Queue[EmailDeliveryJob]:
        if self._closing:
            raise EmailDeliveryQueueUnavailable("Email delivery is shutting down")
        loop = asyncio.get_running_loop()
        if self._queue is None or self._bound_loop is not loop:
            if self._queue is not None and (
                not self._queue.empty()
                or (self._worker_task is not None and not self._worker_task.done())
            ):
                raise EmailDeliveryQueueUnavailable("Email delivery belongs to another event loop")
            self._bound_loop = loop
            self._queue = asyncio.Queue(maxsize=self._max_pending)
        if self._worker_task is None or self._worker_task.done():
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
                self._active_job = job
                result = await asyncio.to_thread(job.send_callable)
            except Exception as exc:  # noqa: BLE001
                logger.error(
                    "email_delivery.job_failed job_id=%s kind=%s error_class=%s",
                    job.job_id,
                    job.kind,
                    type(exc).__name__,
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
                self._active_job = None
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
        try:
            self._ensure_queue().put_nowait(job)
        except asyncio.QueueFull:
            raise EmailDeliveryQueueUnavailable("Email delivery backlog is full") from None
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
        self._closing = True
        worker = self._worker_task
        if worker is None or worker.done():
            await self._fail_pending_on_shutdown()
            self._worker_task = None
            self._queue = None
            self._bound_loop = None
            return
        try:
            await asyncio.wait_for(self.wait_for_idle(), timeout=self._shutdown_timeout_seconds)
        except asyncio.TimeoutError:
            # A thread-offloaded send may still complete after cancellation.
            # Do not retry it: durable delivery requires the effect owner's
            # explicit idempotency and uncertain-outcome contract.
            logger.warning(
                "email_delivery.shutdown_drain_timeout pending=%s",
                self._queue.qsize() if self._queue else 0,
            )
            if self._active_job is not None:
                logger.warning(
                    "email_delivery.send_outcome_uncertain job_id=%s kind=%s",
                    self._active_job.job_id,
                    self._active_job.kind,
                )
            await self._fail_pending_on_shutdown()
        worker.cancel()
        try:
            await worker
        except asyncio.CancelledError:
            pass
        finally:
            self._worker_task = None
            self._queue = None
            self._bound_loop = None

    async def _fail_pending_on_shutdown(self) -> None:
        """Settle unsent jobs through their owner, without retrying active sends."""
        queue = self._queue
        if queue is None:
            return
        jobs = []
        while not queue.empty():
            jobs.append(queue.get_nowait())
            queue.task_done()
        slots = asyncio.Semaphore(4)

        async def fail(job: EmailDeliveryJob) -> None:
            if job.on_failure is None:
                logger.warning(
                    "email_delivery.unsent_on_shutdown job_id=%s kind=%s", job.job_id, job.kind
                )
                return
            async with slots:
                await job.on_failure(EmailDeliveryQueueUnavailable("Email stopped before sending"))

        tasks = [asyncio.create_task(fail(job)) for job in jobs]
        if tasks:
            _done, pending = await asyncio.wait(tasks, timeout=1.0)
            for task in pending:
                task.cancel()
            results = await asyncio.gather(*tasks, return_exceptions=True)
            unsettled = sum(isinstance(value, BaseException) for value in results)
            if unsettled:
                logger.warning("email_delivery.shutdown_unsettled pending=%s", unsettled)


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
    try:
        await service.shutdown()
    finally:
        if _email_delivery_queue_service is service:
            _email_delivery_queue_service = None
