"""The pod runs the agent. This route is where that becomes true for the first time.

Until this file, **no module mounted in a pod imported ``hushh_mcp.one_adk`` at all.**
A pod process never constructed Agent One, never built a Runner, never loaded a
specialist. The pod's only agent-shaped endpoint, ``POST /api/one/a2a/message``,
reaches a containment stub that discards the message and returns a fixed string.
Meanwhile ``/health`` advertised ``["one","kai","nav","kyc"]`` from a hardcoded
literal, and a live-validation document quoted that string as proof of life. The
whole per-user-pod architecture rested on a capability nothing had ever exercised.

This is First Light: the smallest honest thing that proves a pod can run a real
turn. Deliberately narrow — no streaming, no relay, no grounding — so that when it
fails, the failure is attributable to the agent running in a pod and not to
transport, ownership, or PKM.

What it does NOT do, on purpose
-------------------------------
* **No streaming.** The events are collected into one JSON response. SSE through
  the relay is the next milestone and has its own failure modes.
* **No grounding.** ``pkm_context=None``, and the response says ``grounded: false``
  rather than letting a caller assume the agent knew anything about its owner. A
  pod cannot ground until it has a durable key and a populated store; claiming
  otherwise here would be the same lie the health literal was telling.
* **No durable history.** ``InMemorySessionService`` — ``DatabaseSessionService``
  needs a database URL a pod will never hold.

Consent, and why this fails closed loudly
-----------------------------------------
A pod's ``APP_SIGNING_KEY`` is deliberately a DIFFERENT key from the hub's, because
with HMAC the ability to verify is the ability to forge. So a pod fundamentally
cannot validate an HMAC-signed consent token, and the asymmetric path
(``consent/token_signing``) is what makes pod-side verification possible at all.

If issuance is still HMAC, this route refuses rather than degrading: an
unverifiable token must never be treated as absent-but-fine, and a turn that ran
without a validated grant would be exactly the consent bypass the whole protocol
exists to prevent.

Ship-dark behind ``HUSSH_POD_TURN_ENABLED`` (default off) **and** pod mode. The hub
already has a turn route; a second one there would be two implementations of the
same contract, free to drift.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import APIRouter, Body, Header, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from hushh_mcp.runtime_settings import pod_mode, pod_turn_enabled

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/one/pod", tags=["personal-agent"])


class PodTurnRequest(BaseModel):
    message: str = Field(..., min_length=1, max_length=8000)
    conversation_id: str = Field(default="pod-first-light", alias="conversationId", max_length=128)
    timezone: Optional[str] = Field(default=None, max_length=64)

    model_config = ConfigDict(populate_by_name=True)


def _require_enabled() -> None:
    # Pod mode first: on the hub this route must not exist at all, not merely be
    # disabled, so nothing can start depending on a second turn implementation.
    if not pod_mode() or not pod_turn_enabled():
        raise HTTPException(status_code=404, detail="pod turn is not available")


async def _validate_consent(consent_token: str) -> dict:
    """Validate the owner's consent token inside the pod, or refuse.

    Separated so the refusal is one readable block. Every failure mode ends in 403
    with one shape -- a pod must not become an oracle for which tokens exist, which
    scopes are held, or how issuance is configured.
    """
    from hushh_mcp.consent.token import validate_token  # noqa: PLC0415
    from hushh_mcp.constants import ConsentScope  # noqa: PLC0415

    try:
        valid, reason, parsed = validate_token(consent_token, expected_scope=ConsentScope.PKM_READ)
    except Exception as exc:  # noqa: BLE001 - an unverifiable token is simply refused
        logger.warning("pod_turn.consent_error %s", type(exc).__name__)
        raise HTTPException(status_code=403, detail="consent token is not valid here") from exc

    if not valid or parsed is None:
        # Includes the case this route exists to make visible: issuance is still
        # HMAC, so a pod holding a different signing key cannot verify anything.
        # Refusing is correct. Running the turn anyway would be a consent bypass.
        logger.warning("pod_turn.consent_refused reason=%s", str(reason or "")[:120])
        raise HTTPException(status_code=403, detail="consent token is not valid here")
    return {"user_id": getattr(parsed, "user_id", "") or "", "scope": str(reason or "")}


async def run_pod_turn(
    *,
    payload: PodTurnRequest,
    consent_token: str,
    stream_fn: Any = None,
) -> dict:
    """The testable core: validate, run one turn, collect. Injectable by keyword."""
    _require_enabled()
    if not (consent_token or "").strip():
        raise HTTPException(status_code=401, detail="consent token required")

    claims = await _validate_consent(consent_token)
    user_id = claims["user_id"]
    if not user_id:
        raise HTTPException(status_code=403, detail="consent token carries no owner")

    runner = stream_fn
    if runner is None:
        from hushh_mcp.one_adk.text_runtime import stream_one_text_turn  # noqa: PLC0415

        runner = stream_one_text_turn

    provider, model = _resolve_model()

    chunks: list[str] = []
    directives: list[Any] = []
    try:
        async for event in runner(
            user_id=user_id,
            consent_token=consent_token,
            conversation_id=payload.conversation_id,
            message=payload.message,
            history=[],
            timezone=payload.timezone,
            screen_context=None,
            # First Light is UNGROUNDED and reports it. See the module docstring.
            pkm_context=None,
            runtime_provider=provider,
            runtime_model=model,
            runtime_mode="hushh_managed_vertex",
            runtime_credential=None,
        ):
            kind = getattr(event, "kind", "")
            if kind == "token":
                chunks.append(str(getattr(event, "text", "") or ""))
            elif kind == "directive" and getattr(event, "directive", None) is not None:
                directives.append(event.directive)
    except Exception as exc:  # noqa: BLE001 - a failed turn is a 502, never a 500 traceback
        logger.warning("pod_turn.failed %s: %s", type(exc).__name__, str(exc)[:200])
        raise HTTPException(
            status_code=502, detail=f"the agent could not complete this turn: {type(exc).__name__}"
        ) from exc

    text = "".join(chunks).strip()
    return {
        "text": text,
        "model": model,
        "provider": provider,
        # Stated, not implied. A caller must be able to tell that this answer came
        # from an agent that knows nothing about its owner yet.
        "grounded": False,
        "directiveCount": len(directives),
    }


def _resolve_model() -> tuple[str, str]:
    """Provider + model from the file-backed runtime manifest. No database.

    ``load_one_agent_runtime_manifest`` reads the checked-in agent YAML, so it works
    in a pod, where the DB-backed ``AgentChatService`` cannot be constructed at all.
    """
    from hushh_mcp.services.agent_chat_service import (  # noqa: PLC0415
        load_one_agent_runtime_manifest,
    )

    manifest = load_one_agent_runtime_manifest()
    provider = str(manifest.model.provider or "gemini").strip().lower()
    model = str(manifest.model.name or "").strip()
    if not model:
        raise HTTPException(status_code=503, detail="pod has no runtime model configured")
    return provider, model


@router.post("/turn")
async def pod_turn_route(
    payload: PodTurnRequest = Body(...),
    x_consent_token: Optional[str] = Header(default=None, alias="X-Consent-Token"),
) -> dict:
    """Run one Agent One turn inside this pod."""
    return await run_pod_turn(payload=payload, consent_token=x_consent_token or "")
