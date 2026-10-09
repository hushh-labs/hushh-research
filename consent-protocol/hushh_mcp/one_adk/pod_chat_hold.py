"""Request CPU for one already-authorized turn; never starts or resumes inference.

Economy Cloud Run allocates CPU while an inbound request is active. An owner-
authenticated request to the pod's previously admitted address keeps that
request alive after the mobile stream leaves. Tokens and keys remain in memory.
The hold is process-local and cannot recover a turn after process loss.
"""

from __future__ import annotations

import asyncio
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from urllib.parse import urlsplit
from uuid import uuid4

import httpx
from fastapi import HTTPException

from hushh_mcp.services.chat_key import current_request_chat_key


@dataclass
class _Hold:
    owner: str
    authority: object
    claims: dict
    incarnation: str
    deadline: float
    finished: asyncio.Event = field(default_factory=asyncio.Event)
    attached: bool = False


_HOLDS: dict[str, _Hold] = {}


async def serve_hold(hold_id: str, owner):
    from hushh_mcp.services.pod_upgrade_admission import pod_incarnation

    hold = _HOLDS.get(hold_id)
    if (
        hold is None
        or hold.owner != owner.owner
        or hold.authority is not owner.authority
        or hold.claims != owner.claims
        or hold.incarnation != pod_incarnation()
        or hold.attached
    ):
        raise HTTPException(404, detail={"code": "POD_CHAT_HOLD_UNAVAILABLE"})
    hold.attached = True
    try:
        await owner.require_access()
    except BaseException:
        hold.attached = False
        raise

    async def events():
        try:
            yield b"ready\n"
            async with asyncio.timeout(max(0, hold.deadline - time.monotonic())):
                while not hold.finished.is_set():
                    await owner.require_access()
                    if hold.incarnation != pod_incarnation():
                        raise RuntimeError("Pod request incarnation changed.")
                    try:
                        await asyncio.wait_for(hold.finished.wait(), timeout=1)
                    except TimeoutError:
                        pass
            yield b"finished\n"
        finally:
            hold.attached = False

    from starlette.responses import StreamingResponse

    return StreamingResponse(events(), media_type="application/x-ndjson")


async def _admit_hold(owner):
    from hushh_mcp.services.pod_upgrade_admission import pod_incarnation

    await owner.require_access()
    subject = owner.authority.store.subject(owner.claims["subject_id"])
    trust = subject.trust
    if (
        subject.state != "trusted"
        or trust is None
        or trust.version != owner.claims["version"]
        or trust.binding.get("pod_key_id") != owner.authority.pod_key_id
    ):
        raise RuntimeError("Pod background authority changed.")
    origin = str(trust.binding["url"]).rstrip("/")
    parsed = urlsplit(origin)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or parsed.path not in {"", "/"}
    ):
        raise RuntimeError("Pod background request unavailable.")
    # Three chat/hold pairs leave two of the renderer's eight request slots
    # available for owner Stop, revocation and other control operations.
    if len(_HOLDS) >= 3:
        raise RuntimeError("Pod background request capacity reached.")
    key = current_request_chat_key()
    remaining = min(key.remaining_seconds if key else 0, owner.claims["exp"] - time.time())
    if remaining <= 0:
        raise RuntimeError("Pod background request expired.")
    hold_id = uuid4().hex
    hold = _Hold(
        owner.owner,
        owner.authority,
        dict(owner.claims),
        pod_incarnation(),
        time.monotonic() + remaining,
    )
    _HOLDS[hold_id] = hold
    return origin, hold_id, hold, remaining


@asynccontextmanager
async def retain_turn_request(owner):
    """Open the hold before model work; loss of its request cancels the turn.

    Destination comes only from the current pod's admitted app binding, the
    same origin the Files worker uses. No redirects or arbitrary URLs are used.
    """
    origin, hold_id, hold, remaining = await _admit_hold(owner)
    producer = asyncio.current_task()
    closing = False
    failed = False
    reader = None
    try:
        timeout = httpx.Timeout(remaining, connect=min(10, remaining))
        async with (
            asyncio.timeout(remaining),
            httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client,
        ):
            async with client.stream(
                "POST",
                f"{origin}/api/one/pod/agent-chat/holds/{hold_id}",
                headers={"Authorization": owner.authorization},
            ) as response:
                response.raise_for_status()
                lines = response.aiter_lines()
                if await asyncio.wait_for(anext(lines), timeout=10) != "ready":
                    raise RuntimeError("Pod background request unavailable.")

                async def monitor():
                    nonlocal failed
                    try:
                        async for _ in lines:
                            pass
                    finally:
                        if not closing and producer is not None:
                            failed = True
                            producer.cancel()

                reader = asyncio.create_task(monitor())
                try:
                    yield
                finally:
                    closing = True
                    hold.finished.set()
                    if reader is not None:
                        try:
                            await asyncio.wait_for(asyncio.shield(reader), timeout=5)
                        except (TimeoutError, httpx.HTTPError):
                            reader.cancel()
                            await asyncio.gather(reader, return_exceptions=True)
    except asyncio.CancelledError:
        if failed:
            raise RuntimeError("Pod background request lost.") from None
        raise
    finally:
        closing = True
        hold.finished.set()
        if reader is not None and not reader.done():
            reader.cancel()
            await asyncio.gather(reader, return_exceptions=True)
        _HOLDS.pop(hold_id, None)


__all__ = ["retain_turn_request", "serve_hold"]
