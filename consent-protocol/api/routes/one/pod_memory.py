"""Owner-gated memory routes in the private pod: close, revoke, consent, status.

The learning loop's doors, beside ``/api/one/pod/turn`` and under the same
admission: pod mode plus ``HUSSH_POD_TURN_ENABLED`` (``pod_turn._require_enabled``),
a hub-verified ``pkm.read`` consent bound to THIS pod's owner
(``pod_turn._validate_consent``). Nothing here is mounted on the hub.

``POST /conversation/{conversationId}/close`` runs the memory review on the
model the conversation used. It therefore carries the same runtime triple a
turn carries (credential, transport, provider, device) until Lane A makes the
device session implicit; a ``/pod/tick`` cannot do this work because it holds
no Puppy grant and no BYOK credential.

Responses carry counts, words and sequence numbers only. The one exception is
deliberate: a ``pkm_memory_proposal`` directive carries the proposed fact back to
the OWNER for confirmation, on the existing ``directives[]`` contract. That is
the person's own information returned to the person; it is never logged.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import APIRouter, Body, Header, HTTPException, Path
from pydantic import BaseModel, ConfigDict, Field

# Called THROUGH the module, never bound by name: the turn route's admission
# helpers are the single implementation, and a test that stubs the turn's
# consent verifier must stub this route's in the same motion.
from api.routes.one import pod_turn as _turn

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/one/pod", tags=["personal-agent"])


class PodConversationCloseRequest(BaseModel):
    """The runtime triple of the conversation being closed. No message, no history."""

    runtime_credential: Optional[str] = Field(
        default=None, alias="runtimeCredential", max_length=12000
    )
    runtime_credential_transport: str = Field(
        default="developer_api", alias="runtimeCredentialTransport", max_length=32
    )
    runtime_provider: Optional[str] = Field(default=None, alias="runtimeProvider", max_length=32)
    puppy_device_id: Optional[str] = Field(default=None, alias="puppyDeviceId", max_length=128)
    vertex_project: Optional[str] = Field(default=None, alias="vertexProject", max_length=64)
    vertex_location: Optional[str] = Field(default=None, alias="vertexLocation", max_length=64)

    model_config = ConfigDict(populate_by_name=True)


def _memory_service() -> Any:
    """The pod's memory service, or None when this pod holds no memory."""
    from hushh_mcp.one_adk.text_runtime import _resolve_pod_memory_service  # noqa: PLC0415

    return _resolve_pod_memory_service()


def _pod_own_id() -> str:
    import os  # noqa: PLC0415

    return (os.environ.get("HUSSH_ID") or "").strip()


async def run_conversation_close(
    *,
    conversation_id: str,
    payload: PodConversationCloseRequest,
    consent_token: str,
    verifier: Any = None,
    review_fn: Any = None,
    memory_service: Any = None,
    model_builder: Any = None,
) -> dict:
    """The testable core: validate, review on the conversation's model, report."""
    _turn._require_enabled()
    if not (consent_token or "").strip():
        raise HTTPException(status_code=401, detail="consent token required")
    claims = await _turn._validate_consent(consent_token, verifier=verifier)
    if not claims.get("user_id"):
        raise HTTPException(status_code=403, detail="consent token carries no owner")

    from hushh_mcp.services.pod_config import active_pod_config  # noqa: PLC0415

    config = active_pod_config()
    conversation = str(conversation_id or "").strip()[:128]
    if not config.memory_review_on_close:
        return {
            "conversationId": conversation,
            "memory": {"review": {"outcome": "disabled", "reason": "close"}, "written": 0},
            "directives": [],
        }

    service = memory_service if memory_service is not None else _memory_service()
    if service is None:
        return {
            "conversationId": conversation,
            "memory": {"review": {"outcome": "disabled", "reason": "close"}, "written": 0},
            "directives": [],
        }

    # The same resolvers a turn uses, so the review cannot land on a model or a
    # credential path the conversation itself would have been refused.
    provider, model = (
        _turn._resolve_model(payload)  # type: ignore[arg-type]
        if payload.runtime_provider
        else _turn._resolve_model()
    )
    runtime_mode = _turn._resolve_runtime_mode(payload, provider)  # type: ignore[arg-type]
    build = model_builder
    if build is None:
        from hushh_mcp.one_adk.text_runtime import _runtime_model  # noqa: PLC0415

        build = _runtime_model
    try:
        model_object = build(
            runtime_model=model,
            runtime_mode=runtime_mode,
            runtime_credential=payload.runtime_credential,
            runtime_provider=provider,
            puppy_device_id=payload.puppy_device_id,
            runtime_credential_transport=payload.runtime_credential_transport,
            runtime_vertex_project=payload.vertex_project,
            runtime_vertex_location=payload.vertex_location,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None

    review = review_fn
    if review is None:
        from hushh_mcp.one_adk.memory_review import run_memory_review  # noqa: PLC0415

        review = run_memory_review
    try:
        result = await review(
            memory_service=service,
            model=model_object,
            runtime_provider=provider,
            runtime_model=model,
            reason="close",
            budget_seconds=config.memory_review_budget_seconds,
            max_records=config.memory_review_max_records,
            session_owner_id=_pod_own_id() or str(claims.get("user_id") or ""),
        )
    except Exception as exc:  # noqa: BLE001 - a close never surfaces as a 500
        logger.warning("pod_memory.close_failed reason=%s", type(exc).__name__)
        raise HTTPException(
            status_code=502, detail=f"the review could not complete: {type(exc).__name__}"
        ) from None

    logger.info(
        "pod_memory.closed outcome=%s records=%s written=%s provider=%s",
        result.outcome,
        result.records,
        result.written,
        provider,
    )
    return {
        "conversationId": conversation,
        "memory": {
            "review": result.as_dict(),
            "written": result.written,
            "pkmProposals": len(result.pkm_proposals),
        },
        "directives": result.directives(),
        "provider": provider,
        "model": model,
        "runtimeMode": runtime_mode,
    }


@router.post("/conversation/{conversation_id}/close")
async def pod_conversation_close_route(
    conversation_id: str = Path(..., min_length=1, max_length=128),
    payload: PodConversationCloseRequest = Body(default=PodConversationCloseRequest()),
    x_consent_token: Optional[str] = Header(default=None, alias="X-Consent-Token"),
) -> dict:
    """The person left the chat: review what was said, on the model that said it."""
    return await run_conversation_close(
        conversation_id=conversation_id,
        payload=payload,
        consent_token=x_consent_token or "",
    )
