"""Identifier-only delivery in the owner's Storage Queue; the sealed job owns state."""

from __future__ import annotations

import asyncio
import os
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

from hushh_mcp.services.pod_files.library import FilesRefused, identifier
from hushh_mcp.services.pod_queue_transport import AzureQueueItem, OwnerAzureQueue, run_leased
from hushh_mcp.services.pod_workload_identity import get_workload_token

_TERMINAL = {"completed", "cancelled", "failed", "review_required", "superseded"}
_wake = asyncio.Event()


def wake_consumer() -> None:
    """Wake the existing receiver after local publication; never keep compute alive."""
    _wake.set()


def queue_url() -> str:
    """A queue on the very same account as the owner's recovery container."""
    value = os.getenv("POD_FILES_AZURE_QUEUE_URL", "")
    match = re.fullmatch(
        r"https://([a-z0-9]{3,24})\.queue\.core\.windows\.net/([a-z0-9]+(?:-[a-z0-9]+)*)",
        value,
    )
    blob = urlsplit(os.getenv("POD_STORAGE_AZURE_BLOB_URL", ""))
    if (
        not match
        or not 3 <= len(match[2]) <= 63
        or blob.scheme != "https"
        or blob.netloc != f"{match[1]}.blob.core.windows.net"
        or blob.query
        or blob.fragment
    ):
        raise FilesRefused("FILES_BACKGROUND_NOT_CONFIGURED", 503)
    return value


@dataclass(frozen=True)
class QueueMessage:
    message_id: str
    receipt: str
    job_id: str
    delivery: str
    lease_deadline: float = 0


class FilesAzureQueue(OwnerAzureQueue):
    """Files keeps its exact legacy schema over the shared owner transport."""

    def __init__(self, *, session: Any = None, token_provider: Any = get_workload_token):
        super().__init__(
            queue_url(),
            session=session,
            token_provider=token_provider,
            refused=lambda code: FilesRefused(code.replace("POD_", "FILES_", 1), 503),
        )

    async def send(self, job_id: str, delivery: str) -> None:
        await self.send_payload(
            {"job_id": identifier(job_id), "delivery": identifier(delivery)}, ttl=86400
        )

    async def receive(self) -> QueueMessage | AzureQueueItem | None:
        message = await self.receive_payload()
        if message is None:
            return None
        try:
            if message.payload.get("capability") == "browser":
                from hushh_mcp.services.pod_browser.delivery import BrowserDelivery

                BrowserDelivery.model_validate(message.payload)
                return message
            if set(message.payload) != {"job_id", "delivery"}:
                raise ValueError("unexpected payload")
            return QueueMessage(
                message.message_id,
                message.receipt,
                identifier(message.payload["job_id"]),
                identifier(message.payload["delivery"]),
                message.lease_deadline,
            )
        except Exception:
            raise FilesRefused("FILES_QUEUE_MESSAGE_INVALID", 503) from None


async def consume_one(
    queue: FilesAzureQueue,
    *,
    renew_seconds: float = 20,
    browser_work: Callable[[dict, Callable[[], Awaitable[None]]], Awaitable[dict]] | None = None,
) -> bool:
    """Delete only after durable terminal state; lease loss cancels future actions."""
    from hushh_mcp.services.pod_role import require_serving_role

    from .jobs import run_job

    await require_serving_role()
    message = await queue.receive()
    if message is None:
        return False
    if isinstance(message, AzureQueueItem):
        if browser_work is None:
            raise FilesRefused("FILES_QUEUE_HANDLER_UNAVAILABLE", 503)
        return await run_leased(
            queue,
            message,
            lambda valid: browser_work(message.payload, valid),
            terminal=lambda result: (
                result.get("state") in {"completed", "interrupted", "duplicate"}
            ),
            max_seconds=1000,
            renew_seconds=renew_seconds,
        )
    return await run_leased(
        queue,
        message,
        lambda valid: run_job(message.job_id, message.delivery, delivery_check=valid),
        terminal=lambda result: result.get("state") in _TERMINAL,
        max_seconds=180,
        renew_seconds=renew_seconds,
        refused=lambda code: FilesRefused(
            "FILES_JOB_SETTLEMENT_UNCONFIRMED"
            if code == "POD_QUEUE_SETTLEMENT_UNCONFIRMED"
            else code.replace("POD_", "FILES_", 1),
            503,
        ),
    )


async def consume_forever(*, browser_work=None) -> None:
    """One consumer inside the existing worker; KEDA includes invisible messages."""
    queue = FilesAzureQueue()
    try:
        while True:
            _wake.clear()
            try:
                worked = await consume_one(queue, browser_work=browser_work)
            except Exception:
                # The encrypted ledger and queue preserve retriable work. Never
                # log message bodies, exception text or receipt credentials.
                worked = False
            if not worked:
                try:
                    async with asyncio.timeout(30):
                        await _wake.wait()
                except TimeoutError:
                    pass
    finally:
        queue.session.close()
