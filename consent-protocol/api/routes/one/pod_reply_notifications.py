"""Signed serving POD completion signals; hub owns recipients and push content."""

from __future__ import annotations

import asyncio
import hashlib
import time

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field
from starlette.concurrency import run_in_threadpool

from api.routes.one.pod_identity_auth import verify_pod_request
from hushh_mcp.runtime_settings import personal_agent_enabled

router = APIRouter(prefix="/api/one/pod/reply-notifications", tags=["personal-agent"])


class ReplySignal(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    eventId: str = Field(pattern=r"^[0-9a-f]{64}$")
    conversationId: str = Field(pattern=r"^[A-Za-z0-9_-]{8,128}$")
    runId: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")
    createdAt: int
    expiresAt: int
    read: bool = False


async def signed_pod(request: Request, authorization: str | None = Header(default=None)):
    if not personal_agent_enabled():
        raise HTTPException(404, detail="private agent unavailable")
    verified = await verify_pod_request(request, authorization, owner_bound=True)
    if verified is None or not verified.signed or verified.standby:
        raise HTTPException(401, detail="signed agent identity required")
    return verified


async def resolve_owner(verified, registry):
    from hushh_mcp.services.compute_backend import is_owner_cloud_target
    from hushh_mcp.services.pod_access_audit import resolve_serving_owner_hushh_id

    row = await registry.get_by_hushh_id(verified.hushh_id)
    owner_id = str((row or {}).get("user_id") or "")
    serving = await resolve_serving_owner_hushh_id(owner_id, registry=registry)
    if (
        not row
        or not owner_id
        or serving != verified.hushh_id
        or row.get("pod_signing_key_id") != verified.key_id
        or not is_owner_cloud_target(row.get("deployment_target"))
    ):
        raise HTTPException(403, detail="serving agent identity required")
    return owner_id


def dispatch_guard(verified, registry, delivery, *, owner, event_id, attempt, deadline):
    """Recheck serving admission after provider refresh on the request's loop."""
    loop = asyncio.get_running_loop()

    async def admitted():
        if not personal_agent_enabled() or await resolve_owner(verified, registry) != owner:
            return False
        return await asyncio.to_thread(
            delivery.is_sendable, owner_id=owner, event_id=event_id, attempt=attempt
        )

    def before_send():
        future = asyncio.run_coroutine_threadsafe(admitted(), loop)
        try:
            return future.result(timeout=min(8, max(0, deadline - time.monotonic())))
        except Exception:
            return False
        finally:
            future.cancel()

    return before_send


async def accept_reply(signal, verified, *, registry=None, delivery=None, sender=None):
    from hushh_mcp.one_adk.turn_completion import one_reply_push
    from hushh_mcp.services.one_reply_delivery import OneReplyDelivery
    from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo
    from hushh_mcp.services.push_notifications import PushDeliveryReport, send_user_data_push

    now = int(time.time())
    expected_id = hashlib.sha256(
        f"{verified.hushh_id}\0{signal.conversationId}\0{signal.runId}".encode()
    ).hexdigest()
    if (
        signal.eventId != expected_id
        or signal.createdAt > now + 60
        or not signal.createdAt < signal.expiresAt <= signal.createdAt + 21600
        or signal.expiresAt <= now
    ):
        raise HTTPException(400, detail="completion signal invalid or expired")
    registry = registry or PersonalAgentRegistryRepo()
    owner = await resolve_owner(verified, registry)
    delivery = delivery or await asyncio.to_thread(OneReplyDelivery)
    row, state = await asyncio.to_thread(
        delivery.accept,
        owner_id=owner,
        hushh_id=verified.hushh_id,
        signal=signal,
    )
    if row is None:
        return {"settled": state != "pending", "outcome": state}
    # Database/provider work may block: refuse an owner or signing-key change
    # before sending. Payload never chooses a recipient or notification words.
    if await resolve_owner(verified, registry) != owner:
        raise HTTPException(403, detail="serving agent identity changed")
    if not await asyncio.to_thread(
        delivery.is_sendable, owner_id=owner, event_id=signal.eventId, attempt=row["attempts"]
    ):
        state = await asyncio.to_thread(delivery.state, owner_id=owner, event_id=signal.eventId)
        return {"settled": state != "pending", "outcome": state}
    deadline = time.monotonic() + 45
    report = PushDeliveryReport(
        accepted=set(row.get("accepted_devices") or []),
        deadline=deadline,
        expires_at=signal.expiresAt,
        before_send=dispatch_guard(
            verified,
            registry,
            delivery,
            owner=owner,
            event_id=signal.eventId,
            attempt=row["attempts"],
            deadline=deadline,
        ),
        record_accepted=lambda token_hash: delivery.record_accepted(
            owner_id=owner, event_id=signal.eventId, attempt=row["attempts"], token_hash=token_hash
        ),
    )
    payload = one_reply_push(signal.conversationId)
    payload["data"]["message_id"] = signal.eventId
    # Keep blocking provider work off the executor used by registry admission.
    await run_in_threadpool(sender or send_user_data_push, owner, **payload, delivery=report)
    state = await asyncio.to_thread(
        delivery.finish,
        owner_id=owner,
        event_id=signal.eventId,
        attempt=row["attempts"],
        report=report,
    )
    return {"settled": state != "pending", "outcome": state}


@router.post("")
async def reply_route(signal: ReplySignal, verified=Depends(signed_pod)):
    try:
        return await accept_reply(signal, verified)
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(503, detail="completion delivery unavailable") from None
