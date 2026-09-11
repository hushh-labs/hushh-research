"""Owner-gated memory routes in the private pod: close, revoke, consent, status.

The learning loop's doors, beside ``/api/one/pod/turn`` and under the same
admission: pod mode plus ``HUSSH_POD_TURN_ENABLED`` (``pod_turn._require_enabled``),
then an owner-bound consent. Nothing here is mounted on the hub.

Two doors, one core, exactly as ``pod_turn.pod_turn_route`` has them. A hub-relayed
call carries ``X-Consent-Token`` and the hub verifies the ``pkm.read`` grant against
THIS pod's owner (``pod_turn._validate_consent``). An owner-direct call carries this
pod's own app-role session as the bearer, and the pod's own authority answers
(``pod_session.verified_session`` plus ``PodSessionAuthority.local_verifier``), with
no hub in the path at all. Which door was used never changes what a core does; a
bearer that is not a pod session is refused by shape, never accepted as local, and
an owner-local token that arrives without its verified claims is refused rather
than admitted with no role question asked (``_require_local_session`` here,
``pod_turn._require_local_session`` there: the same guard, deliberately in step).

The owner-local door is why the learning loop can be exercised where no metadata
server exists (a laptop): the hub path answers 503 there, because it cannot ask.
A door is only owner-reachable if the pod's ingress policy also names its path, so
all four are on the app surface (``api/middlewares/pod_ingress.APP_SURFACE_EXACT``,
where each placement carries its own reason); ``tests/test_pod_server.py`` pins that
surface exactly, path by path, against what the pod actually mounts.

THE COST OF THAT PLACEMENT, STATED UP FRONT. Everything not on the app surface is
behind the pod's machine wall, which verifies the hub's Google identity token with
``verify_scheduler_request`` against the pod's hub-caller allowlist. Naming these
paths on the app surface removes that check FROM THEM. The hub relay still sends
the identity token on all four (``pod_relay``), and the pod no longer looks at it
there, so each route's own admission is the entire defence: a hub-verified consent
token bound to this pod's owner, or this pod's own app-role session. That is the
same trade ``/api/one/pod/turn`` has carried since it shipped, and it is the price
of erasure and inspection that keep working when the hub is unreachable. It is
worth re-reading before any future memory route is added to that set:
``tests/test_pod_memory_routes.py`` pins the placement and its consequence
together, so the trade cannot be widened silently.

Whether this feature is on is answered BEFORE any door is opened. A pod with
``HUSSH_POD_TURN_ENABLED`` off answers 404 to every caller, bearer or not: the
route must look absent rather than broken, or a refusal becomes an oracle for a
disabled pod's memory surface and the state of its local authority.

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
from typing import TYPE_CHECKING, Any, Optional

from fastapi import APIRouter, Body, Header, HTTPException, Path
from pydantic import BaseModel, ConfigDict, Field

# Called THROUGH the module, never bound by name: the turn route's admission
# helpers are the single implementation, and a test that stubs the turn's
# consent verifier must stub this route's in the same motion.
from api.routes.one import pod_turn as _turn

if TYPE_CHECKING:
    # A TYPE ONLY: importing the reviewer here would pull `pod_memory_service`
    # into this module's import, which every memory door resolves lazily so a pod
    # that cannot resolve its memory answers 404 rather than failing to start.
    from hushh_mcp.one_adk.memory_review import MemoryReviewPolicy

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


def review_policy_for_session(session: Optional[dict]) -> "MemoryReviewPolicy":
    """What a memory review opened by THIS caller may do. The one resolver.

    RETIRE, not merely forget. The review has two operations that end at a
    tombstone: ``forget`` reaches ``PodMemoryService.revoke``, and ``supersede``
    reaches ``PodMemoryService.supersede``, which kills the old record through the
    same ``PodMemoryStore._kill`` before hydrating its replacement. One answer
    governs both (``memory_review.AdditiveOnlyReviewSink``).

    Permissive on the hub door (``session is None``), and the honest statement of
    why is narrower than it is tempting to write. This resolver branches on
    ``session is None`` and on nothing else: it reads no hub claim, no hub scope
    and no hub verdict, so it cannot know what the hub decided. What it knows is
    that a request carrying no binding carries no binding scope to check, and that
    ``/api/one/pod/memory/revoke`` has always admitted the hub door without a
    retire scope. Permissive here preserves that behaviour rather than deriving an
    authority. On the owner-local door there IS a binding to read, and the answer
    is its own word, the same ``pod.revoke`` scope that route requires of a
    session.

    PUBLIC, AND CALLED FROM BOTH ROUTES. ``pod_turn.run_pod_turn`` asks it too, for
    the catch-up review inside a turn, so the close door and the turn door cannot
    reach different answers about the same caller. It is deliberately the only
    place in the memory lane that reads ``scopes`` for this question; the reviewer
    and the model runtime receive the finding and never re-derive it.
    """
    from hushh_mcp.one_adk.memory_review import MemoryReviewPolicy  # noqa: PLC0415
    from hushh_mcp.services.pod_session_authority import SCOPE_POD_REVOKE  # noqa: PLC0415

    if session is None:
        return MemoryReviewPolicy(may_retire=True, authority="hub_consent")
    if SCOPE_POD_REVOKE in {str(s) for s in (session.get("scopes") or [])}:
        return MemoryReviewPolicy(may_retire=True, authority="binding_scope")
    return MemoryReviewPolicy(may_retire=False, authority="binding_narrowed")


def _require_local_session(consent_token: str, session: Optional[dict], *, scope: str = "") -> None:
    """An owner-local call opens these doors in the app role, with the named scope.

    The route already asks ``verified_session`` these questions when it verifies the
    bearer. This repeats them at the core, so a caller reaching a core directly
    cannot present a device-role or under-scoped session and skip what the binding
    states.

    A local call is recognised by the token itself, not by whether a session was
    passed: ``local_token`` is the only token shaped ``pod-session:<sid>`` and only
    the authority mints it. Asking the shape is what makes the repeat a real check
    rather than an honour system, because a direct caller that supplies the local
    token and the local verifier but omits ``session`` would otherwise reach the
    core with no role or scope question asked at all.
    """
    from hushh_mcp.services.pod_session_authority import (  # noqa: PLC0415
        LOCAL_TOKEN_PREFIX,
        ROLE_APP,
    )

    if str(consent_token or "").strip().startswith(LOCAL_TOKEN_PREFIX) and session is None:
        raise HTTPException(
            status_code=403,
            detail={
                "code": "session_required",
                "message": "an owner-local call must carry its verified session",
            },
        )
    if session is None:
        return
    if str(session.get("role") or "") != ROLE_APP:
        raise HTTPException(
            status_code=403,
            detail={"code": "role_mismatch", "message": "an app-role session is required"},
        )
    if scope and scope not in {str(s) for s in (session.get("scopes") or [])}:
        raise HTTPException(
            status_code=403,
            detail={"code": "scope_not_granted", "message": f"{scope} is not in this binding"},
        )


def _owner_door(
    consent_token: Optional[str], authorization: Optional[str], *, scope: str = ""
) -> dict[str, Any]:
    """Resolve which door the caller came through into the core's keyword arguments.

    Availability is settled first, so a disabled pod is a flat 404 on every path
    into this module and never reveals, by answering differently, that it has a
    memory surface or a live local authority behind the flag.

    A hub token then takes precedence and is handled exactly as before. Otherwise a
    pod session bearer opens the owner-local door: the session's own stand-in token
    and verifier travel where the hub token and the hub verifier used to, and the
    verified claims travel with them so the core can see the role and the scopes.
    ``scope`` is the binding scope this particular door needs beyond the app role.
    No bearer at all resolves to an empty token, which every core answers with 401.
    """
    _turn._require_enabled()
    if str(consent_token or "").strip():
        return {"consent_token": consent_token or ""}

    from api.routes.one.pod_session import bearer, verified_session  # noqa: PLC0415
    from hushh_mcp.services.pod_session_authority import ROLE_APP  # noqa: PLC0415

    if not bearer(authorization):
        return {"consent_token": ""}
    authority, claims = verified_session(authorization, role=ROLE_APP, scope=scope or None)
    return {
        "consent_token": authority.local_token(claims),
        "verifier": authority.local_verifier(claims),
        "session": claims,
    }


async def _admit_owner(
    consent_token: str,
    *,
    verifier: Any = None,
    session: Optional[dict] = None,
    scope: str = "",
) -> dict:
    """The one admission every memory core shares, whichever door was used.

    ``verifier`` is the hub's ``verify_consent`` on the hub door and the session's
    own local verifier on the owner-local one; ``_validate_consent`` asks the same
    question of either, including the owner binding, and answers 503 only when the
    authority could not be asked.
    """
    _turn._require_enabled()
    _require_local_session(consent_token, session, scope=scope)
    if not (consent_token or "").strip():
        raise HTTPException(status_code=401, detail="consent token required")
    claims = await _turn._validate_consent(consent_token, verifier=verifier)
    if not claims.get("user_id"):
        raise HTTPException(status_code=403, detail="consent token carries no owner")
    return claims


async def run_conversation_close(
    *,
    conversation_id: str,
    payload: PodConversationCloseRequest,
    consent_token: str,
    verifier: Any = None,
    review_fn: Any = None,
    memory_service: Any = None,
    model_builder: Any = None,
    session: Optional[dict] = None,
) -> dict:
    """The testable core: validate, review on the conversation's model, report.

    Closing a conversation is admitted on the app role alone, deliberately: leaving
    a chat must not require a destructive grant. What is narrowed instead is the
    REVIEW the close then runs. Two of its tools end at a tombstone, not one:
    ``forget`` reaches the same ``PodMemoryService.revoke`` that
    ``/api/one/pod/memory/revoke`` reaches, and ``supersede`` reaches
    ``PodMemoryService.supersede``, which kills the old record before hydrating the
    replacement. So a session whose binding does not name ``pod.revoke`` gets a
    review that may remember and propose, and may neither forget nor supersede
    (``memory_review.AdditiveOnlyReviewSink``).

    And if such a review DOES reach for a tombstone, it writes nothing at all,
    including its additive half: the alternative is the corrected sentence landing
    beside the stale fact it was meant to replace, which recall would then serve as
    two equally true facts. ``run_memory_review`` states that rule, what it costs
    and why the checkpoint still advances.
    """
    claims = await _admit_owner(consent_token, verifier=verifier, session=session)

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
            policy=review_policy_for_session(session),
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
    authorization: Optional[str] = Header(default=None),
) -> dict:
    """The person left the chat: review what was said, on the model that said it."""
    return await run_conversation_close(
        conversation_id=conversation_id,
        payload=payload,
        **_owner_door(x_consent_token, authorization),
    )


# -- owner revoke, provider consent, status ------------------------------------------
#
# The memory outcomes AGENTS.md doctrine 1 requires of a private pod: owner
# inspection (status), revocation (revoke) and the provider processing boundary
# (provider-consent). Same admission as the turn on every one of them, through
# either of the turn's two doors. The one thing an owner-local session never
# carries is the provider processing grant; see ``run_memory_provider_consent``.
#
# Revocation asks the owner-local session for one scope more than the others,
# ``pod.revoke``, the same scope ``POST /api/one/pod/session/revoke`` requires of
# the session that revokes another subject. Reading counts and talking to your
# agent is what ``pkm.read`` says; destroying facts is not. The hub door cannot be
# held to the same vocabulary, because a hub consent token carries hub scopes
# rather than binding scopes; there the hub is the authority that decided who may
# ask.
#
# WHAT THAT SCOPE DOES AND DOES NOT GUARANTEE. This route is not the only way to
# put a tombstone in the log, and ``revoke`` is not the only primitive that writes
# one. Two review operations retire a record the person gave the agent earlier:
# ``forget`` reaches ``PodMemoryService.revoke``, and ``supersede`` reaches
# ``PodMemoryService.supersede``, which calls the very same ``PodMemoryStore._kill``
# on the old id before hydrating its replacement. A rule written about ``forget``
# alone is a rule with a second door beside it. So the narrowing is stated over the
# authority, not over one tool name: a caller that cannot evidence ``pod.revoke``
# gets a review that may remember and propose, and may neither forget nor supersede
# (``memory_review.AdditiveOnlyReviewSink``, whose docstring argues why a
# supersession is refused whole rather than kept as its additive half).
#
# A review runs from two places, and both are covered:
#
# * ``POST /conversation/{id}/close``, admitted on the app role with no scope. It is
#   narrowed instead of gated, because closing a conversation should not need a
#   destructive grant: ``run_conversation_close`` passes its door's answer
#   (``review_policy_for_session``) as the review's ``policy``.
# * The catch-up review inside ``POST /api/one/pod/turn``. It runs deep in
#   ``one_adk.text_runtime``, and the turn route resolves the SAME answer from the
#   SAME helper above and hands it down as a prepared ``MemoryReviewPolicy``. So a
#   catch-up retires under the same authority answer a close on that same door
#   would have been given, and a read-narrowed session's catch-up retires nothing.
#   The runtime carries the verdict and never derives it: an authority decision taken inside the model runtime would be
#   a second reader of the same consent, free to disagree with this one.
#   ``run_memory_review`` stays DEFAULT-DENY underneath, so a call site that
#   supplies nothing still inherits nothing.
#
# THE GUARANTEE, STATED AS NARROWLY AS THE CODE HOLDS IT. It is a property of the
# BINDING, not of the person holding it. A call made WITH a binding that does not
# name ``pod.revoke`` cannot retire a held fact by any route the pod exposes: not
# this route, not a close, and not the catch-up review inside a turn opened with
# that binding. The same person, presenting a hub-verified consent token on the hub
# door, retires exactly as before -- that door is admitted on the hub's own verdict
# and this pod asks it for no retire scope at all, here or on a close. Narrowing a
# binding narrows the calls made with it; it does not narrow the owner, and nothing
# here is a claim about what the person can reach by another door. It is a claim
# about retiring a NAMED fact, too: whole-pod erasure is a different operation on a
# path no binding reaches, behind the machine wall
# (``api/middlewares/pod_ingress``), and this sentence says nothing about it.
#
# All of it is defense in depth rather than a reachable hole today, and the negative
# controls say so: ``pod_binding_service`` mints exactly ``APP_SCOPES`` for an app
# role, and ``APP_SCOPES`` contains ``pod.revoke``. No binding the hub can issue is
# narrowed to reading, so the narrowing has never refused anything a real owner
# session could do. It is here for the vocabulary widening later.


class PodMemoryRevokeRequest(BaseModel):
    memory_ids: list[str] = Field(..., alias="memoryIds", min_length=1, max_length=50)
    reason_code: str = Field(default="owner_request", alias="reasonCode", max_length=32)

    model_config = ConfigDict(populate_by_name=True)


class PodMemoryProviderConsentRequest(BaseModel):
    """``granted`` with the hub-minted ``cap.memory.provider.process`` token, or a withdrawal."""

    granted: bool
    provider_consent_token: Optional[str] = Field(
        default=None, alias="providerConsentToken", max_length=4096
    )

    model_config = ConfigDict(populate_by_name=True)


def _require_memory(memory_service: Any) -> Any:
    service = memory_service if memory_service is not None else _memory_service()
    if service is None:
        raise HTTPException(status_code=404, detail="this pod holds no agent memory")
    return service


async def run_memory_revoke(
    *,
    payload: PodMemoryRevokeRequest,
    consent_token: str,
    verifier: Any = None,
    memory_service: Any = None,
    session: Optional[dict] = None,
) -> dict:
    """Tombstone the named facts. Ids only in and out; never content."""
    from hushh_mcp.services.pod_memory_service import (  # noqa: PLC0415
        MEMORY_REVOKE_REASON_CODES,
        PodMemoryError,
    )
    from hushh_mcp.services.pod_session_authority import SCOPE_POD_REVOKE  # noqa: PLC0415

    await _admit_owner(consent_token, verifier=verifier, session=session, scope=SCOPE_POD_REVOKE)
    service = _require_memory(memory_service)
    reason = str(payload.reason_code or "owner_request").strip()
    if reason not in MEMORY_REVOKE_REASON_CODES:
        raise HTTPException(status_code=400, detail="unknown revocation reason")
    try:
        revoked = await service.revoke(payload.memory_ids, reason_code=reason, requested_by="owner")
    except PodMemoryError as exc:
        # An id this pod does not hold is a refusal, not a silent no-op: the owner
        # asked for something specific and must learn it did not happen.
        raise HTTPException(status_code=404, detail=str(exc)) from None
    status = await service.memory_status()
    logger.info("pod_memory.revoke_route revoked=%s tombstones=%s", revoked, status["tombstones"])
    return {"revoked": revoked, "tombstones": status["tombstones"], "provider": status["provider"]}


async def run_memory_provider_consent(
    *,
    payload: PodMemoryProviderConsentRequest,
    consent_token: str,
    verifier: Any = None,
    memory_service: Any = None,
    session: Optional[dict] = None,
    provider_verifier: Any = None,
) -> dict:
    """Record the owner's answer on provider processing, durably, in the pod's log.

    Granting needs a SECOND token: the hub-minted, five-minute
    ``cap.memory.provider.process`` grant, verified here against the same consent
    authority and bound to this pod's owner. The standing ``pkm.read`` token that
    admits every route says the caller may talk to their agent; it never says the
    provider may process the agent's memory. Withdrawing needs only the owner.

    The owner-local door moves neither half of that, and deliberately.

    * **Withdrawal is owner-local and needs no hub.** Turning provider processing
      off is the direction that must keep working when nothing is reachable, so an
      app-role pod session is the whole authority for it.
    * **Granting still needs the hub-minted grant, checked against the hub.** On the
      owner-local door the session's local verifier answers the admission question
      and is then deliberately NOT reused for this second one: a pod session proves
      the owner is here, never that the owner agreed a provider may process their
      memory. Letting the pod answer that from its own session would make the pod
      the sole asserter of the consent it is about to rely on, and would collapse a
      five-minute single-purpose grant into a twelve-hour general one. So a laptop
      with no reachable authority gets a 503 on a grant and records nothing, which
      is the honest answer; the rest of the learning loop runs there regardless.

      This split closes a reachable hole only if a binding could ever carry the
      provider scope, and today none can: ``pod_binding_service`` mints exactly
      ``APP_SCOPES`` for an app role, so a real session reusing its own verifier
      here would have been refused for want of the scope, not granted. The split
      is defense in depth against the binding vocabulary widening later, and the
      negative control below asserts against a hand-built binding the hub does not
      currently mint. It was never demonstrated on a session the hub can issue.

    ``provider_verifier`` is the injection seam for this second question alone.
    """
    from hushh_mcp.constants import ConsentScope  # noqa: PLC0415

    await _admit_owner(consent_token, verifier=verifier, session=session)
    service = _require_memory(memory_service)
    if payload.granted:
        token = str(payload.provider_consent_token or "").strip()
        if not token:
            raise HTTPException(status_code=403, detail="provider consent grant required")
        check = provider_verifier
        if check is None and session is None:
            # The hub door's single verifier answers both questions, unchanged.
            check = verifier
        if check is None:
            from hushh_mcp.services.pod_consent_client import verify_consent  # noqa: PLC0415

            check = verify_consent
        verdict = await check(token, expected_scope=ConsentScope.CAP_MEMORY_PROVIDER_PROCESS.value)
        if not verdict.available:
            raise HTTPException(status_code=503, detail="consent authority is unavailable")
        mine = _pod_own_id()
        if not verdict.valid or not mine or verdict.hushh_id != mine:
            raise HTTPException(status_code=403, detail="provider consent grant is not valid here")
        if str(verdict.scope or "") != ConsentScope.CAP_MEMORY_PROVIDER_PROCESS.value:
            raise HTTPException(status_code=403, detail="provider consent grant is not valid here")
    seq = await service.set_provider_consent(
        bool(payload.granted),
        requested_by="owner",
        scope=ConsentScope.CAP_MEMORY_PROVIDER_PROCESS.value,
    )
    status = await service.memory_status()
    return {"granted": bool(payload.granted), "seq": seq, "provider": status["provider"]}


async def run_memory_status(
    *,
    consent_token: str,
    verifier: Any = None,
    memory_service: Any = None,
    session: Optional[dict] = None,
) -> dict:
    """Owner inspection: counts, sequence numbers and provider words. No content."""
    await _admit_owner(consent_token, verifier=verifier, session=session)
    service = _require_memory(memory_service)
    return await service.memory_status()


@router.post("/memory/revoke")
async def pod_memory_revoke_route(
    payload: PodMemoryRevokeRequest = Body(...),
    x_consent_token: Optional[str] = Header(default=None, alias="X-Consent-Token"),
    authorization: Optional[str] = Header(default=None),
) -> dict:
    from hushh_mcp.services.pod_session_authority import SCOPE_POD_REVOKE  # noqa: PLC0415

    return await run_memory_revoke(
        payload=payload, **_owner_door(x_consent_token, authorization, scope=SCOPE_POD_REVOKE)
    )


@router.post("/memory/provider-consent")
async def pod_memory_provider_consent_route(
    payload: PodMemoryProviderConsentRequest = Body(...),
    x_consent_token: Optional[str] = Header(default=None, alias="X-Consent-Token"),
    authorization: Optional[str] = Header(default=None),
) -> dict:
    return await run_memory_provider_consent(
        payload=payload, **_owner_door(x_consent_token, authorization)
    )


@router.get("/memory/status")
async def pod_memory_status_route(
    x_consent_token: Optional[str] = Header(default=None, alias="X-Consent-Token"),
    authorization: Optional[str] = Header(default=None),
) -> dict:
    return await run_memory_status(**_owner_door(x_consent_token, authorization))
