"""The pod runs the agent. This route is where that becomes true for the first time.

Until this file, **no module mounted in a pod imported ``hushh_mcp.one_adk`` at all.**
A pod process never constructed Agent One, never built a Runner, never loaded a
specialist. The pod's only agent-shaped endpoint, ``POST /api/one/a2a/message``,
reaches a containment stub that discards the message and returns a fixed string.
Meanwhile ``/health`` advertised ``["one","kai","nav","kyc"]`` from a hardcoded
literal, and a live-validation document quoted that string as proof of life. The
whole per-user-pod architecture rested on a capability nothing had ever exercised.

This began as First Light: the smallest honest thing that proves a pod can run a real
turn, deliberately narrow so that a failure was attributable to the agent running in a
pod rather than to transport, ownership, or PKM.

What it does NOT do, on purpose
-------------------------------
* **No streaming.** The events are collected into one JSON response. SSE through
  the relay is the next milestone and has its own failure modes.
* **No durable history.** ``InMemorySessionService`` — ``DatabaseSessionService``
  needs a database URL a pod will never hold.

Grounding: solved without weakening the boundary
------------------------------------------------
This route used to pass ``pkm_context=None`` and report ``grounded: false``, on the
reasoning that a pod cannot ground until it has a durable key and a populated store.
That reasoning had a false premise: it assumed the POD must be the one to read PKM.

It does not have to be. The browser already decrypts the owner's turn projection from
their own unlocked vault and already sends it to the hub on every Agent Chat turn. The
hub couriers that same value here. The projection is opened by the owner's key on the
owner's device, so Zero Knowledge is preserved exactly — the pod grounds without ever
holding a database credential, which is the property that makes it a private agent.

``grounded`` is now DERIVED from what actually reached the runtime, never asserted. A
hardcoded value was honest while the turn was ungrounded by construction and would
have become a lie the moment a projection started arriving — the same failure shape as
the ``/health`` roster literal that reported four agents from a pod running none.

Consent: the pod ASKS, it does not verify
-----------------------------------------
A pod's ``APP_SIGNING_KEY`` is deliberately a DIFFERENT key from the hub's, because
with HMAC the ability to verify is the ability to forge. So a pod cannot check the
hub's signatures -- and even if it could, that would not close revocation, whose
state lives in the hub's process and database (SECURITY-REVIEW **I1**): a revoked
token would read as live inside a pod indefinitely.

So every turn asks the hub, which issued the token and owns the revoked set. See
``api/routes/one/pod_consent.py`` for why asking beats verifying and what it costs.
An unreachable authority is a 503, never a silent pass -- an agent that keeps
acting on holdings when consent cannot be checked is exactly what consent-first
forbids.

Ship-dark behind ``HUSSH_POD_TURN_ENABLED`` (default off) **and** pod mode. The hub
already has a turn route; a second one there would be two implementations of the
same contract, free to drift.
"""

from __future__ import annotations

import logging
import os
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
    # The OWNER'S model credential, supplied per turn. See _resolve_runtime for why
    # a pod uses the person's own key rather than a fleet identity.
    # 12000 matches the hub's own bound (api/routes/kai/agent_chat.py). A tighter
    # cap here would 422 credentials the hub accepts, and the relay would surface
    # that as an opaque refusal rather than "your key is too long".
    runtime_credential: Optional[str] = Field(
        default=None, alias="runtimeCredential", max_length=12000
    )
    runtime_credential_transport: str = Field(
        default="developer_api", alias="runtimeCredentialTransport", max_length=32
    )
    vertex_project: Optional[str] = Field(default=None, alias="vertexProject", max_length=64)
    vertex_location: Optional[str] = Field(default=None, alias="vertexLocation", max_length=64)
    # The owner's consented turn projection, opened by their key on their own device
    # and couriered here by the hub. A pod grounds on this rather than reading PKM
    # itself: it holds no database credential BY DESIGN, and the browser already
    # computes exactly this value for every hub turn.
    #
    # 20000 matches the hub's cap so the two paths cannot disagree about what fits.
    pkm_context: Optional[str] = Field(default=None, alias="pkmContext", max_length=20000)

    model_config = ConfigDict(populate_by_name=True)


def _require_enabled() -> None:
    # Pod mode first: on the hub this route must not exist at all, not merely be
    # disabled, so nothing can start depending on a second turn implementation.
    if not pod_mode() or not pod_turn_enabled():
        raise HTTPException(status_code=404, detail="pod turn is not available")


async def _validate_consent(consent_token: str, *, verifier: Any = None) -> dict:
    """Ask the hub whether this consent is live. The hub is the authority.

    A pod cannot verify locally: its APP_SIGNING_KEY is deliberately a different key
    from the hub's, and even a checkable signature would not close revocation, whose
    state lives in the hub's process and database (SECURITY-REVIEW I1).

    Three outcomes, kept distinct on purpose:

      valid        run the turn
      invalid      403 -- a clean denial from the authority
      unavailable  503 -- the authority could not be asked

    The last must never collapse into either neighbour. As a denial it turns a hub
    blip into "your agent refuses to know you"; as an approval it lets a pod act on
    someone's holdings with no live consent check.
    """
    check = verifier
    if check is None:
        from hushh_mcp.services.pod_consent_client import verify_consent  # noqa: PLC0415

        check = verify_consent

    from hushh_mcp.constants import ConsentScope  # noqa: PLC0415

    verdict = await check(consent_token, expected_scope=ConsentScope.PKM_READ.value)

    if not verdict.available:
        logger.warning("pod_turn.consent_authority_unavailable reason=%s", verdict.reason)
        raise HTTPException(status_code=503, detail="consent authority is unavailable")
    if not verdict.valid:
        logger.info("pod_turn.consent_refused")
        raise HTTPException(status_code=403, detail="consent token is not valid here")

    # WHOSE turn is this? A valid token proves someone consented -- it does not
    # prove they are THIS pod's owner. Without this check a token belonging to
    # person A, presented to person B's pod, would drive B's pod on A's behalf:
    # B's memory, B's holdings, B's model spend. "Valid" and "yours" are different
    # questions and only the second one makes a per-user pod per-user.
    #
    # An unresolvable binding is refused too. An unknown owner is precisely the
    # case where serving anyway would be the bug, so empty must never read as
    # "any pod will do".
    mine = (os.getenv("HUSSH_ID") or "").strip()
    if not mine or not verdict.hushh_id or verdict.hushh_id != mine:
        logger.warning(
            "pod_turn.owner_mismatch pod_has_identity=%s token_bound=%s",
            bool(mine),
            bool(verdict.hushh_id),
        )
        # Same 403 shape as a denial: a caller must not learn from this response
        # whether the token was invalid or merely somebody else's.
        raise HTTPException(status_code=403, detail="consent token is not valid here")

    return {"user_id": verdict.user_id, "scope": verdict.scope}


async def run_pod_turn(
    *,
    payload: PodTurnRequest,
    consent_token: str,
    stream_fn: Any = None,
    verifier: Any = None,
) -> dict:
    """The testable core: validate, run one turn, collect. Injectable by keyword."""
    _require_enabled()
    if not (consent_token or "").strip():
        raise HTTPException(status_code=401, detail="consent token required")

    claims = await _validate_consent(consent_token, verifier=verifier)
    user_id = claims["user_id"]
    if not user_id:
        raise HTTPException(status_code=403, detail="consent token carries no owner")

    runner = stream_fn
    if runner is None:
        from hushh_mcp.one_adk.text_runtime import stream_one_text_turn  # noqa: PLC0415

        runner = stream_one_text_turn

    provider, model = _resolve_model()
    runtime_mode = _resolve_runtime_mode(payload)
    # Normalised once: an all-whitespace projection is not grounding, and letting it
    # count would report `grounded: true` for a turn that learned nothing.
    grounding = (payload.pkm_context or "").strip() or None

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
            # Grounded on the owner's OWN projection, opened by their key on their own
            # device and couriered here by the hub. The pod holds no database
            # credential by design, so this is what makes a pod turn grounded without
            # weakening the boundary that makes it a private agent.
            pkm_context=grounding,
            # When there is none, say WHY rather than leaving the model to infer it
            # from silence -- the same honesty the hub path now carries.
            grounding_reason=None
            if grounding
            else "no consented projection was sent with this turn",
            runtime_provider=provider,
            runtime_model=model,
            runtime_mode=runtime_mode,
            runtime_credential=payload.runtime_credential,
            runtime_credential_transport=payload.runtime_credential_transport,  # type: ignore[arg-type]
            runtime_vertex_project=payload.vertex_project,
            runtime_vertex_location=payload.vertex_location,
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
    # A SUCCESSFUL TURN LEAVES A TRACE. Until this line, `run_pod_turn` logged only on
    # failure -- so a pod that was working and a pod that was never called looked
    # exactly alike in Cloud Logging, and nothing anywhere recorded how many turns a
    # person's agent actually served, how long they took, or which model answered.
    #
    # The hub's POD_ACCESS receipt is written BEFORE the proxy call, so it records
    # "permission granted", never "turn completed". This is the only place that can
    # say the turn finished.
    #
    # Carries shape, never content: no message, no answer, no projection -- only
    # whether grounding arrived, how long it took, and whose model served it.
    logger.info(
        "pod_turn.completed grounded=%s chars=%s directives=%s runtime_mode=%s provider=%s",
        bool(grounding),
        len(text),
        len(directives),
        runtime_mode,
        provider,
    )
    return {
        "text": text,
        "model": model,
        "provider": provider,
        # DERIVED, never asserted. This was hardcoded False while the turn was
        # ungrounded by construction, which was honest then and would be a lie the
        # moment a projection started arriving. Deriving it from what actually
        # reached the runtime means the field cannot drift from the behaviour --
        # the same reason `/health` stopped reporting a hand-written roster.
        "grounded": bool(grounding),
        "directiveCount": len(directives),
        # Whose model answered. Stated, because "your AI" is a product promise and a
        # cost boundary, not an implementation detail.
        "runtimeMode": runtime_mode,
    }


def _resolve_runtime_mode(payload: PodTurnRequest) -> str:
    """Whose model serves this turn -- and the answer should be the OWNER'S.

    A pod runs on the person's own AI key, supplied per turn, for three reasons
    that all point the same way:

    * **It is the product.** "Own your AI. Own your data. Own your compute." An
      agent that quietly bills its thinking to a fleet account owns none of those.
    * **Cost and quota land where they belong** -- on the person whose agent is
      working, not on a shared pool that one heavy user can exhaust for everyone.
    * **Least privilege.** The pod service account holds ZERO project roles, which
      is the whole basis of the isolation story. Serving turns from a fleet Vertex
      identity would mean granting ``aiplatform.user`` to every pod in the fleet --
      spending the one property that makes a compromised pod uninteresting.

    The key never rests in the pod: it arrives with the turn and leaves with it.
    Nothing here writes it anywhere, and it is never logged.

    A managed fallback exists because the product supports it, but it is chosen
    explicitly, never by silent default -- a pod with no credential that quietly
    reached for a fleet identity would be spending money nobody authorised.
    """
    if str(payload.runtime_credential or "").strip():
        # `byok`, matching AgentRuntimeCredentialMode — NOT "gemini_byok".
        #
        # This returned "gemini_byok" and `text_runtime._runtime_model` branches on
        # "byok", so a pod turn carrying a credential matched neither BYOK branch,
        # fell through to `if credential:` and raised "Managed Vertex cannot be
        # constructed from an API key". The BYOK pod path failed on every turn.
        #
        # It survived because the route test asserts this STRING while injecting a
        # stub `stream_fn`, so the real runner was never constructed. A test that
        # pins the value a function returns, rather than what the next function does
        # with it, passes for exactly as long as both ends are wrong together.
        return "byok"
    from hushh_mcp.runtime_settings import pod_managed_model_enabled  # noqa: PLC0415

    if pod_managed_model_enabled():
        return "hushh_managed_vertex"
    # Refusing beats guessing. This is the honest state for a person whose AI
    # connection has not been established -- and by the provisioning gate, they
    # should not have a pod at all yet.
    raise HTTPException(
        status_code=400,
        detail="this pod has no model access; connect an AI key first",
    )


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
