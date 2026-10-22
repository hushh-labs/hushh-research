"""Bounded owner Storage Queue transport; each capability owns its message schema.

No SAS or connection string. Callers bind the queue to verified owner custody,
validate identifier-only messages, and settle only after their durable outcome.
"""

from __future__ import annotations

import asyncio
import base64
import json
import re
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from email.utils import formatdate
from functools import partial
from typing import Any, Protocol, cast
from urllib.parse import quote
from uuid import UUID

from defusedxml.ElementTree import fromstring
from opentelemetry.instrumentation.utils import suppress_instrumentation

from hushh_mcp.services.pod_bounded_object import read_bounded_response
from hushh_mcp.services.pod_object_version import run_write_to_completion
from hushh_mcp.services.pod_workload_identity import get_workload_token


class OwnerQueueRefused(RuntimeError):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


class QueueLease(Protocol):
    @property
    def message_id(self) -> str: ...

    @property
    def receipt(self) -> str: ...

    @property
    def lease_deadline(self) -> float: ...


@dataclass(frozen=True)
class AzureQueueItem:
    message_id: str
    receipt: str
    payload: dict
    lease_deadline: float


class OwnerAzureQueue:
    def __init__(
        self,
        url: str,
        *,
        session: Any = None,
        token_provider: Any = get_workload_token,
        refused: Callable[[str], Exception] = OwnerQueueRefused,
    ):
        import requests  # type: ignore[import-untyped]  # existing runtime dependency

        self._refused = refused

        if not re.fullmatch(
            r"https://[a-z0-9]{3,24}\.queue\.core\.windows\.net/[a-z0-9]+(?:-[a-z0-9]+)*", url
        ):
            raise self._refused("POD_BACKGROUND_NOT_CONFIGURED")
        self.url = url
        self.session = session or requests.Session()
        self.token_provider = token_provider

    async def _call(self, *args: Any, **kwargs: Any) -> tuple[bytes, dict]:
        return cast(
            tuple[bytes, dict],
            await run_write_to_completion(partial(self._request, *args, **kwargs)),
        )

    def _request(self, method: str, suffix: str = "", **kwargs: Any) -> tuple[bytes, dict]:
        response = None
        try:
            with suppress_instrumentation():
                response = self.session.request(
                    method,
                    self.url + "/messages" + suffix,
                    headers={
                        "Authorization": "Bearer "
                        + self.token_provider("https://storage.azure.com/"),
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
            raise self._refused("POD_QUEUE_UNAVAILABLE") from None
        finally:
            if response is not None:
                response.close()

    async def send_payload(self, payload: dict, *, ttl: int) -> None:
        if type(ttl) is not int or not 1 <= ttl <= 86400:
            raise self._refused("POD_QUEUE_MESSAGE_INVALID")
        raw = json.dumps(payload, allow_nan=False).encode()
        if len(raw) > 4096:
            raise self._refused("POD_QUEUE_MESSAGE_INVALID")
        encoded = base64.b64encode(raw).decode()
        await self._call(
            "POST",
            data=f"<QueueMessage><MessageText>{encoded}</MessageText></QueueMessage>",
            params={"messagettl": str(ttl)},
        )

    async def receive_payload(self) -> AzureQueueItem | None:
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
            receipt = message.findtext("PopReceipt") or ""
            if not isinstance(payload, dict) or not receipt or len(receipt) > 4096:
                raise ValueError("invalid delivery")
            return AzureQueueItem(
                str(UUID(message.findtext("MessageId") or "")), receipt, payload, started + 50
            )
        except Exception:
            raise self._refused("POD_QUEUE_MESSAGE_INVALID") from None

    async def renew(self, message: QueueLease, receipt: str) -> str:
        _, headers = await self._call(
            "PUT",
            "/" + quote(message.message_id, safe=""),
            params={"popreceipt": receipt, "visibilitytimeout": "60"},
        )
        following = next((v for k, v in headers.items() if k.lower() == "x-ms-popreceipt"), "")
        if not following or len(following) > 4096:
            raise self._refused("POD_QUEUE_LEASE_UNCONFIRMED")
        return following

    async def settle(self, message: QueueLease, receipt: str) -> None:
        await self._call(
            "DELETE", "/" + quote(message.message_id, safe=""), params={"popreceipt": receipt}
        )


async def run_leased(
    queue: Any,
    message: QueueLease,
    work: Callable[[Callable[[], Awaitable[None]]], Awaitable[dict]],
    *,
    terminal: Callable[[dict], bool],
    max_seconds: float,
    renew_seconds: float = 20,
    refused: Callable[[str], Exception] = OwnerQueueRefused,
) -> bool:
    """Join work and cleanup before ack; lease loss fences the owning operation."""
    receipt = message.receipt
    deadline = message.lease_deadline or time.monotonic() + 50

    async def valid() -> None:
        if time.monotonic() >= deadline:
            raise refused("POD_QUEUE_LEASE_EXPIRED")

    await valid()
    job = asyncio.ensure_future(work(valid))
    loop = asyncio.get_running_loop()
    fence = loop.call_later(max(0, deadline - time.monotonic()), job.cancel)
    try:
        async with asyncio.timeout(max_seconds):
            while not job.done():
                done, _ = await asyncio.wait({job}, timeout=renew_seconds)
                if not done:
                    began = time.monotonic()
                    receipt = await queue.renew(message, receipt)
                    await valid()
                    deadline = began + 50
                    fence.cancel()
                    fence = loop.call_later(max(0, deadline - time.monotonic()), job.cancel)
            result = await job
        await valid()
        if not terminal(result):
            raise refused("POD_QUEUE_SETTLEMENT_UNCONFIRMED")
        await queue.settle(message, receipt)
        return True
    except asyncio.CancelledError:
        task = asyncio.current_task()
        if time.monotonic() >= deadline and task is not None and not task.cancelling():
            raise refused("POD_QUEUE_LEASE_EXPIRED") from None
        raise
    finally:
        fence.cancel()
        if not job.done():
            job.cancel()
        await asyncio.gather(job, return_exceptions=True)
