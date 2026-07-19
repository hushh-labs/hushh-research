"""Informational pre-vault agent route for One.

This is the lower-privilege sibling of ``agent_chat.py``. It exists so the single
One agent bar can help users *before* the vault is unlocked, including anonymous
visitors on the onboarding welcome flow, without ever crossing the vault trust
boundary.

Hard guarantees that keep this safe to expose at a lower privilege than the
vault-gated chat:

- It NEVER accepts or reads PKM / vault data. There is no ``pkm_context`` field
  and no decrypted user memory is ever passed to the model.
- It NEVER persists anything. There is no conversation, no encrypted history,
  no database write. Every turn is ephemeral.
- It NEVER runs vault, finance-data, consent, or destructive operations. The
  only app actions it forwards are pure ``route.*`` navigation proposals, which
  are harmless on their own (each destination route enforces its own gates).
- It uses One's restricted semantic ADK head, not the legacy keyword/action
  planner. Semantic assessment stays with the model; the navigation-only tool
  validates its authority before any client directive is emitted.
- It uses the Hussh-managed runtime only. It does not accept a BYOK runtime
  credential.
- It is rate limited per user/IP to bound abuse and cost on the unauthenticated
  path.

When a user is signed in (Firebase) the turn is bucketed to their UID; anonymous
onboarding visitors fall back to the IP bucket. Auth is optional here precisely
because the welcome flow is pre-sign-in, but because nothing sensitive is read
or written, that is acceptable.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Optional

from fastapi import APIRouter, Header, HTTPException, Request, status
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from api.middlewares.rate_limit import RateLimits, limiter
from api.routes.one.live_context import sanitize_live_context
from hushh_mcp.one_adk.text_runtime import OneTextDirective, stream_one_intro_text_turn
from hushh_mcp.services.action_gateway import get_action_gateway_action, is_navigation_action
from hushh_mcp.services.agent_chat_service import (
    AgentRuntimeContractError,
    AgentRuntimeProviderError,
    get_agent_chat_service,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["Agent Chat"])


class AgentIntroStreamRequest(BaseModel):
    message: str = Field(..., min_length=1, max_length=4000)
    screen_context: Optional[dict] = Field(default=None)


def _event(event: str, data: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def _navigation_tool_payload(directive: OneTextDirective) -> dict[str, Any] | None:
    """Translate One's low-privilege route directive into the shared SSE shape."""
    if directive.kind != "action":
        return None
    action_id = str(directive.payload.get("actionId") or "").strip()
    entry = get_action_gateway_action(action_id)
    if (
        entry is None
        or not action_id.startswith("route.")
        or not is_navigation_action(entry)
        or str((entry.get("risk") or {}).get("execution_policy") or "") != "allow_direct"
        or str((entry.get("execution_target") or {}).get("status") or "") != "wired"
    ):
        return None
    raw_slots = directive.payload.get("slots")
    slots = raw_slots if isinstance(raw_slots, dict) else {}
    return {
        "call_id": f"intro:{action_id}",
        "action_id": action_id,
        "label": str(entry.get("label") or action_id),
        "execution": "frontend",
        "slots": slots,
        "message": f"Opening {str(entry.get('label') or action_id)}.",
    }


async def _resolve_optional_uid(authorization: Optional[str]) -> Optional[str]:
    """Best-effort Firebase UID for rate-limit bucketing only.

    Never raises. A missing or invalid token simply means "anonymous" here,
    which is allowed on this informational route. The UID is used only for the
    rate-limit key and structured logging, never to read user data.
    """
    if not authorization or not authorization.startswith("Bearer "):
        return None
    try:
        from api.utils.firebase_auth import verify_firebase_bearer

        return await run_in_threadpool(verify_firebase_bearer, authorization)
    except Exception:  # noqa: BLE001 - optional auth, anonymous is acceptable
        return None


@router.post("/agent/chat/intro/stream")
@limiter.limit(RateLimits.AGENT_CHAT)
async def stream_agent_intro(
    request: Request,
    body: AgentIntroStreamRequest,
    authorization: Optional[str] = Header(None),
):
    """Stream one informational/navigation-only One response as token SSE.

    This is the pre-vault tier: no PKM, no persistence, no vault operations.
    """

    uid = await _resolve_optional_uid(authorization)
    # Bucket the rate limiter to the signed-in user when we have one, otherwise
    # the limiter falls back to the caller IP for anonymous onboarding traffic.
    if uid:
        request.state.rate_limit_user_id = uid

    service = get_agent_chat_service()
    try:
        runtime = await service.prepare_agent_runtime()
    except (AgentRuntimeContractError, AgentRuntimeProviderError) as error:
        logger.warning(
            "agent_intro.runtime_failed uid=%s error_code=%s",
            uid or "anon",
            error.error_code,
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": error.error_code, "message": error.message},
        ) from error
    except Exception as error:  # noqa: BLE001
        logger.exception("agent_intro.prepare_failed uid=%s: %s", uid or "anon", error)
        raise HTTPException(status_code=500, detail="Agent could not be started") from error

    sanitized_screen_context = sanitize_live_context(body.screen_context or {})

    async def generate():
        try:
            yield _event("start", {"conversation_id": None, "model": runtime.model})
            emitted_action = False
            async for one_event in stream_one_intro_text_turn(
                user_id=uid or "anonymous",
                message=body.message,
                screen_context=sanitized_screen_context,
                runtime_provider=runtime.provider,
                runtime_model=runtime.model,
                runtime_mode=runtime.mode,
                runtime_credential=None,
            ):
                if await request.is_disconnected():
                    return
                if one_event.kind == "token" and one_event.text:
                    yield _event("token", {"token": one_event.text})
                    continue
                if emitted_action or one_event.directive is None:
                    continue
                payload = _navigation_tool_payload(one_event.directive)
                if payload is None:
                    continue
                emitted_action = True
                yield _event("tool_start", payload)
                yield _event(
                    "tool_waiting",
                    {**payload, "status": "waiting_for_frontend"},
                )

            yield _event(
                "complete",
                {"conversation_id": None, "status": "complete", "model": runtime.model},
            )
        except asyncio.CancelledError:
            raise
        except AgentRuntimeProviderError as error:
            logger.warning(
                "agent_intro.stream_provider_failed uid=%s error_code=%s",
                uid or "anon",
                error.error_code,
            )
            yield _event("error", {"code": error.error_code, "message": error.message})
        except Exception as error:  # noqa: BLE001
            logger.exception("agent_intro.stream_failed uid=%s: %s", uid or "anon", error)
            yield _event("error", {"message": "Agent failed. Please try again."})

    headers = {
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
        "X-Agent-Model": runtime.model,
    }
    return StreamingResponse(generate(), media_type="text/event-stream", headers=headers)
