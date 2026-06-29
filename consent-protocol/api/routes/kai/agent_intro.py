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
from hushh_mcp.services.agent_chat_service import (
    AgentChatActionPlan,
    AgentRuntimeContractError,
    AgentRuntimeProviderError,
    get_agent_chat_service,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["Agent Chat"])

# The informational tier only ever forwards pure navigation. Any other action
# kind (PKM save, CRM, blocked/destructive) is suppressed so the pre-vault bar
# can never propose a vault-touching operation; it just answers in text and, if
# relevant, tells the user to unlock the vault to go further.
_NAVIGATION_ACTION_PREFIX = "route."


class AgentIntroStreamRequest(BaseModel):
    message: str = Field(..., min_length=1, max_length=4000)
    screen_context: Optional[dict] = Field(default=None)


def _event(event: str, data: dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


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
        # Navigation planning only. We pass no PKM context and ignore anything
        # that is not a pure navigation proposal.
        action_plan: AgentChatActionPlan | None = await service.plan_action_with_gemini(
            user_message=body.message,
            history=[],
            runtime_client=runtime.client,
            runtime_model=runtime.model,
            pkm_context=None,
            screen_context=body.screen_context,
        )
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

    navigation_plan: AgentChatActionPlan | None = None
    if (
        action_plan is not None
        and action_plan.execution == "frontend"
        and isinstance(action_plan.action_id, str)
        and action_plan.action_id.startswith(_NAVIGATION_ACTION_PREFIX)
    ):
        navigation_plan = action_plan

    async def generate():
        try:
            yield _event("start", {"conversation_id": None, "model": runtime.model})

            if navigation_plan is not None:
                payload = navigation_plan.to_event_payload()
                receipt = navigation_plan.message.strip() or "Taking you there."
                yield _event("tool_start", payload)
                yield _event("token", {"token": receipt})
                yield _event(
                    "tool_waiting",
                    {**payload, "message": receipt, "status": "waiting_for_frontend"},
                )
                yield _event(
                    "complete",
                    {"conversation_id": None, "status": "complete", "model": runtime.model},
                )
                return

            async for token in service.stream_response(
                user_message=body.message,
                history=[],
                runtime_client=runtime.client,
                runtime_model=runtime.model,
                action_plan=None,
                pkm_context=None,
            ):
                if await request.is_disconnected():
                    return
                yield _event("token", {"token": token})

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
