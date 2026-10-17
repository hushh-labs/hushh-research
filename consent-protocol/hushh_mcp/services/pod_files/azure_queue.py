"""Identifier-only delivery in the owner's Storage Queue; the sealed job owns state."""

from __future__ import annotations

import asyncio
import base64
import json
import os
import re
import time
from dataclasses import dataclass
from email.utils import formatdate
from functools import partial
from typing import Any
from urllib.parse import quote, urlsplit
from uuid import UUID

from defusedxml.ElementTree import fromstring
from opentelemetry.instrumentation.utils import suppress_instrumentation

from hushh_mcp.services.pod_bounded_object import read_bounded_response
from hushh_mcp.services.pod_files.library import FilesRefused, identifier
from hushh_mcp.services.pod_object_version import run_write_to_completion
from hushh_mcp.services.pod_workload_identity import get_workload_token

_AUDIENCE = "https://storage.azure.com/"
_TERMINAL = {"completed", "cancelled", "failed", "review_required", "superseded"}


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


class FilesAzureQueue:
    """No connection strings, SAS tokens, payload contents or hub credentials."""

    def __init__(self, *, session: Any = None, token_provider: Any = get_workload_token):
        import requests

        self.url = queue_url()
        self.session = session or requests.Session()
        self.token_provider = token_provider

    async def _call(self, *args: Any, **kwargs: Any) -> tuple[bytes, dict]:
        # Queue reads acquire a lease; all operations must finish before a
        # cancelled caller closes its session or reports shutdown complete.
        return await run_write_to_completion(partial(self._request, *args, **kwargs))

    def _request(self, method: str, suffix: str = "", **kwargs: Any) -> tuple[bytes, dict]:
        response = None
        try:
            with suppress_instrumentation():
                response = self.session.request(
                    method,
                    self.url + "/messages" + suffix,
                    headers={
                        "Authorization": "Bearer " + self.token_provider(_AUDIENCE),
                        "x-ms-version": "2023-11-03",
                        "x-ms-date": formatdate(usegmt=True),
                        "Content-Type": "application/xml",
                        "Accept-Encoding": "identity",
                    },
                    timeout=15,
                    allow_redirects=False,
                    stream=True,
                    **kwargs,
                )
            if response.status_code != {"GET": 200, "POST": 201, "PUT": 204, "DELETE": 204}[method]:
                raise ValueError("queue refused")
            headers = dict(response.headers)
            if response.status_code in {201, 204}:
                return b"", headers
            return read_bounded_response(response, max_bytes=16384) or b"", headers
        except Exception:
            # Transport failures may carry bearer headers or pop receipts.
            raise FilesRefused("FILES_QUEUE_UNAVAILABLE", 503) from None
        finally:
            if response is not None:
                response.close()

    async def send(self, job_id: str, delivery: str) -> None:
        payload = {"job_id": identifier(job_id), "delivery": identifier(delivery)}
        encoded = base64.b64encode(json.dumps(payload).encode()).decode()
        await self._call(
            "POST",
            data=f"<QueueMessage><MessageText>{encoded}</MessageText></QueueMessage>",
            params={"messagettl": "86400"},
        )

    async def receive(self) -> QueueMessage | None:
        started = time.monotonic()
        raw, _ = await self._call("GET", params={"numofmessages": "1", "visibilitytimeout": "60"})
        try:
            messages = fromstring(raw).findall("QueueMessage")
            if not messages:
                return None
            if len(messages) != 1:
                raise ValueError("unbounded delivery")
            message = messages[0]
            payload = json.loads(
                base64.b64decode(message.findtext("MessageText") or "", validate=True)
            )
            if not isinstance(payload, dict) or set(payload) != {"job_id", "delivery"}:
                raise ValueError("unexpected payload")
            receipt = message.findtext("PopReceipt") or ""
            if not receipt or len(receipt) > 4096:
                raise ValueError("missing lease")
            return QueueMessage(
                str(UUID(message.findtext("MessageId") or "")),
                receipt,
                identifier(payload["job_id"]),
                identifier(payload["delivery"]),
                started + 50,  # Conservative bound, including request transit.
            )
        except Exception:
            raise FilesRefused("FILES_QUEUE_MESSAGE_INVALID", 503) from None

    async def renew(self, message: QueueMessage, receipt: str) -> str:
        _, headers = await self._call(
            "PUT",
            "/" + quote(message.message_id, safe=""),
            params={"popreceipt": receipt, "visibilitytimeout": "60"},
        )
        following = next((v for k, v in headers.items() if k.lower() == "x-ms-popreceipt"), "")
        if not following or len(following) > 4096:
            raise FilesRefused("FILES_QUEUE_LEASE_UNCONFIRMED", 503)
        return following

    async def settle(self, message: QueueMessage, receipt: str) -> None:
        await self._call(
            "DELETE",
            "/" + quote(message.message_id, safe=""),
            params={"popreceipt": receipt},
        )


async def consume_one(queue: FilesAzureQueue, *, renew_seconds: float = 20) -> bool:
    """Delete only after durable terminal state; lease loss cancels future actions."""
    from hushh_mcp.services.pod_role import require_serving_role

    from .jobs import run_job

    await require_serving_role()
    message = await queue.receive()
    if message is None:
        return False
    receipt = message.receipt
    deadline = message.lease_deadline or time.monotonic() + 50

    async def lease_valid() -> None:
        if time.monotonic() >= deadline:
            raise FilesRefused("FILES_QUEUE_LEASE_EXPIRED", 503)

    await lease_valid()
    job = asyncio.create_task(run_job(message.job_id, message.delivery, delivery_check=lease_valid))
    loop = asyncio.get_running_loop()
    fence = loop.call_later(max(0, deadline - time.monotonic()), job.cancel)
    try:
        async with asyncio.timeout(180):
            while not job.done():
                done, _ = await asyncio.wait({job}, timeout=renew_seconds)
                if not done:
                    began = time.monotonic()
                    receipt = await queue.renew(message, receipt)
                    # The independent fence cancels work even if renewal stalls.
                    await lease_valid()
                    deadline = began + 50
                    fence.cancel()
                    fence = loop.call_later(max(0, deadline - time.monotonic()), job.cancel)
            result = await job
        if result.get("state") not in _TERMINAL:
            raise FilesRefused("FILES_JOB_SETTLEMENT_UNCONFIRMED", 503)
        await queue.settle(message, receipt)
        return True
    except asyncio.CancelledError:
        task = asyncio.current_task()
        if time.monotonic() >= deadline and task is not None and not task.cancelling():
            raise FilesRefused("FILES_QUEUE_LEASE_EXPIRED", 503) from None
        raise
    finally:
        fence.cancel()
        if not job.done():
            job.cancel()
        await asyncio.gather(job, return_exceptions=True)


async def consume_forever() -> None:
    """One consumer inside the existing worker; KEDA includes invisible messages."""
    queue = FilesAzureQueue()
    try:
        while True:
            try:
                worked = await consume_one(queue)
            except Exception:
                # The encrypted ledger and queue preserve retriable work. Never
                # log message bodies, exception text or receipt credentials.
                worked = False
            if not worked:
                await asyncio.sleep(30)
    finally:
        queue.session.close()
