"""The private relay: the hub is the ONLY door to a pod, and only for its owner.

A pod is ``internal`` ingress with no ``allUsers`` binding, so nothing outside
the project can reach it. That is the property to preserve: the pod stays
unreachable from the internet, and this route is the single authorized bridge.

``GET /api/one/u/{hushh_id}/info`` resolves a HusshID to its owner's registry
row, proves the caller is that owner, and proxies to the pod's ``/pod/info`` at
the URL the HUB recorded in ``backend_metadata`` at service creation. Three
guards, in order, each fail-closed:

1. **Authenticated owner.** ``require_firebase_auth`` gives the caller's user id;
   there is no path here for an anonymous caller.
2. **Ownership, audited.** ``PodAccessAuditService.authorize_owner_read`` checks
   the caller owns THIS HusshID and writes a POD_ACCESS receipt either way -- so
   a valid session for user A can never reach user B's pod, and every attempt is
   on the ledger. This is the audit guard that was built and tested with zero
   callers; the relay is its caller.
3. **Hub-minted identity.** The hub calls the pod as itself (the pod SA grants
   ``run.invoker`` to the hub runtime), so no shared secret crosses the boundary
   and the pod authenticates the hub without either holding the other's key.

The address is never supplied by the caller -- it comes only from the row the
hub wrote. Missing hub identity refuses before network access. Redirects are not
followed and are normalized to a safe 502, so a pod response cannot forward the
owner's projection, model credential or consent grant to another destination.

Flag-gated: 404 while ``PERSONAL_AGENT_ENABLED`` is off, the same posture as
every other personal-agent surface.
"""

from __future__ import annotations

import inspect
import logging
from typing import Any, Literal, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Path, Query, Request
from pydantic import BaseModel, ConfigDict, Field
from starlette.concurrency import run_in_threadpool

from api.middleware import require_firebase_auth
from hushh_mcp.constants import ConsentScope
from hushh_mcp.runtime_settings import personal_agent_enabled, pod_data_door_enabled
from hushh_mcp.services.personal_agent_grant_service import PersonalAgentDisabledError
from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo
from hushh_mcp.services.pod_access_audit import (
    PERSONAL_AGENT_ID,
    PodAccessAuditService,
    PodAccessDenied,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/one/u", tags=["personal-agent"])

_INFO_TIMEOUT_SECONDS = 5.0
# A turn waits on a model, not a status read. Real questions routinely take tens of
# seconds, and a 5s bound would turn every genuine answer into "your agent is not
# answering right now" -- a false fault report, in the person's own language.
#
# One rung above the pod route's own 155 s bound (`pod_turn.POD_TURN_ROUTE_TIMEOUT_SECONDS`),
# so the pod's typed 504 always reaches the person before this proxy gives up and
# reports a vaguer failure. `tests/test_timeout_ladder.py` pins the order.
_TURN_TIMEOUT_SECONDS = 160.0
# The names are the single wire contract shared by text and Live pod relays.
# Each value is a short-lived, owner-scoped consent grant; no caller may add a
# header outside this allowlist.
POD_DATA_DOOR_NAMES: tuple[str, ...] = (
    "invoke",
    "marketplace",
    "nav",
    "location",
    "email",
    "calendar",
)


def _require_enabled() -> None:
    if not personal_agent_enabled():
        raise HTTPException(status_code=404, detail="personal agent is not available")


def _pod_url(row: dict) -> Optional[str]:
    """The pod's URL as the HUB recorded it. Never taken from the request."""
    metadata = row.get("backend_metadata")
    if not isinstance(metadata, dict):
        return None
    url = str(metadata.get("url") or "").strip().rstrip("/")
    return url if url.startswith("https://") else None


def _identity_token(audience: str) -> Optional[str]:
    try:
        import google.auth.transport.requests
        import google.oauth2.id_token

        request = google.auth.transport.requests.Request()
        token = google.oauth2.id_token.fetch_id_token(request, audience)
        return str(token) if token else None
    except Exception as exc:  # noqa: BLE001 - unauthenticated call is simply refused
        logger.info("pod_relay.identity_token_failed %s", type(exc).__name__)
        return None


async def _proxy_get(
    url: str,
    path: str,
    *,
    extra_headers: Optional[dict[str, str]] = None,
    session: Any = None,
) -> tuple[int, Any]:
    client: Any = session
    if client is None:
        import requests  # type: ignore[import-untyped]  # noqa: PLC0415 - deferred so tests can inject

        client = requests
    token = await run_in_threadpool(_identity_token, url)
    if not token:
        return 503, {"detail": "pod identity unavailable"}
    headers = {"Authorization": f"Bearer {token}", **(extra_headers or {})}
    try:
        response = await run_in_threadpool(
            lambda: client.get(
                f"{url}{path}",
                headers=headers,
                timeout=_INFO_TIMEOUT_SECONDS,
                allow_redirects=False,
            )
        )
    except Exception as exc:  # noqa: BLE001 - a pod that is not up is a 503, not a 500
        logger.info("pod_relay.unreachable %s", type(exc).__name__)
        return 503, {"detail": "pod unreachable"}
    if 300 <= getattr(response, "status_code", 502) < 400:
        return 502, {"detail": "pod redirect refused"}
    try:
        body = response.json()
    except Exception:  # noqa: BLE001
        body = {"detail": "pod returned a non-JSON body"}
    return getattr(response, "status_code", 502), body


def _correlation_headers(request: Any) -> dict[str, str]:
    """The request/trace ids this turn arrived with, to carry into the pod.

    The browser mints a request id and the hub honours it -- and the chain stopped
    dead at this boundary. The pod's middleware then minted an unrelated UUID, so
    nothing linked a hub request to the pod request it caused, and "my agent gave a
    bad answer" could not be traced past the relay.

    The pod's middleware already accepts these exact header names and prefers an
    inbound value over a fresh one, so forwarding is the entire fix.

    Carries only opaque correlation ids -- never identity, never holdings. Tolerates
    any request-like object, because a correlation id must never be the reason a turn
    fails.
    """
    headers = getattr(request, "headers", None) or {}
    out: dict[str, str] = {}
    for name in ("x-request-id", "x-trace-id"):
        value = ""
        try:
            value = str(headers.get(name) or "").strip()
        except Exception:  # noqa: BLE001 - see above
            value = ""
        if value:
            out[name] = value[:128]
    return out


async def _proxy_post(
    url: str,
    path: str,
    *,
    body: dict,
    consent_token: str,
    extra_headers: Optional[dict[str, str]] = None,
    correlation: dict[str, str] | None = None,
    session: Any = None,
) -> tuple[int, Any]:
    """POST to a pod as the hub, carrying the owner's standing read grant.

    Longer timeout than the info proxy: this waits on a model, not a status read.
    A person's question routinely takes tens of seconds to answer, and a 5s bound
    would turn every real turn into a spurious "your agent is not answering".
    """
    client: Any = session
    if client is None:
        import requests  # type: ignore[import-untyped]  # noqa: PLC0415 - deferred so tests can inject

        client = requests
    token = await run_in_threadpool(_identity_token, url)
    if not token:
        return 503, {"detail": "pod identity unavailable"}
    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {token}"}
    if consent_token:
        headers["X-Consent-Token"] = consent_token
    headers.update(extra_headers or {})
    headers.update(correlation or {})
    try:
        response = await run_in_threadpool(
            lambda: client.post(
                f"{url}{path}",
                json=body,
                headers=headers,
                timeout=_TURN_TIMEOUT_SECONDS,
                # A 307/308 could forward the owner's projection, model key and
                # consent grant to a destination outside the registered pod.
                allow_redirects=False,
            )
        )
    except Exception as exc:  # noqa: BLE001 - a pod that is not up is a 503, not a 500
        logger.info("pod_relay.turn_unreachable %s", type(exc).__name__)
        return 503, {"detail": "pod unreachable"}
    if 300 <= getattr(response, "status_code", 502) < 400:
        return 502, {"detail": "pod redirect refused"}
    try:
        answer = response.json()
    except Exception:  # noqa: BLE001
        answer = {"detail": "pod returned a non-JSON body"}
    return getattr(response, "status_code", 502), answer


async def relay_pod_info(
    *,
    hushh_id: str,
    user_id: str,
    registry: Optional[PersonalAgentRegistryRepo] = None,
    audit: Optional[PodAccessAuditService] = None,
    session: Any = None,
) -> dict:
    """Owner-authorized proxy to a pod's /pod/info. The only door to a pod.

    The testable core, injectable by keyword. The FastAPI route below is a thin
    shell so the request-parsed params never collide with these seams.
    """
    _require_enabled()
    repo = registry or PersonalAgentRegistryRepo()
    auditor = audit or PodAccessAuditService(registry=repo)

    # Ownership check, audited both ways. A read scope + the pod agent id are what
    # authorize_owner_read expects; it verifies the caller owns THIS hushh_id.
    try:
        await auditor.authorize_owner_read(
            user_id=user_id,
            agent_id=PERSONAL_AGENT_ID,
            scope=ConsentScope.PKM_READ.value,
            hushh_id=hushh_id,
            request_id=f"relay-info:{hushh_id}",
        )
    except PodAccessDenied as exc:
        # One shape for every denial -- owner mismatch, no row, not provisioned --
        # so the relay is not an oracle for which HusshIDs exist.
        logger.info("pod_relay.denied reason=%s", str(exc))
        raise HTTPException(status_code=403, detail="not authorized for this pod") from exc
    except PersonalAgentDisabledError as exc:
        raise HTTPException(status_code=404, detail="personal agent is not available") from exc

    row = await repo.get(user_id)
    url = _pod_url(row or {})
    if url is None:
        # Authorized, but the pod has no reachable address yet (still connecting).
        raise HTTPException(status_code=409, detail="pod is not reachable yet")

    status, body = await _proxy_get(url, "/pod/info", session=session)
    if status == 503:
        raise HTTPException(status_code=503, detail="pod unreachable")
    return {"hushhId": hushh_id, "podStatus": status, "pod": body}


async def relay_pod_model_diagnostic(
    *,
    hushh_id: str,
    user_id: str,
    model: str,
    location: str = "",
    registry: Optional[PersonalAgentRegistryRepo] = None,
    audit: Optional[PodAccessAuditService] = None,
    session: Any = None,
) -> dict:
    """Owner-authorized proxy to a pod's read-only model reachability check.

    The same door as ``relay_pod_info`` -- same ownership proof, same audit, same
    address resolution -- so a person can ask their own pod "can you reach this
    model?" and nobody else can. It exists because that question can only be
    answered by the pod's own identity (see ``pod_server.probe_model_reachability``).
    """
    from urllib.parse import urlencode  # noqa: PLC0415

    _require_enabled()
    model = (model or "").strip()
    location = (location or "").strip()
    if not model or len(model) > 96:
        raise HTTPException(status_code=400, detail="model is required")
    repo = registry or PersonalAgentRegistryRepo()
    auditor = audit or PodAccessAuditService(registry=repo)
    try:
        await auditor.authorize_owner_read(
            user_id=user_id,
            agent_id=PERSONAL_AGENT_ID,
            scope=ConsentScope.PKM_READ.value,
            hushh_id=hushh_id,
            request_id=f"relay-diag-model:{hushh_id}",
        )
    except PodAccessDenied as exc:
        logger.info("pod_relay.denied reason=%s", str(exc))
        raise HTTPException(status_code=403, detail="not authorized for this pod") from exc
    except PersonalAgentDisabledError as exc:
        raise HTTPException(status_code=404, detail="personal agent is not available") from exc
    row = await repo.get(user_id)
    url = _pod_url(row or {})
    if url is None:
        raise HTTPException(status_code=409, detail="pod is not reachable yet")
    query = urlencode({"model": model, **({"location": location} if location else {})})
    status, body = await _proxy_get(url, f"/pod/diagnostics/model?{query}", session=session)
    if status == 503:
        raise HTTPException(status_code=503, detail="pod unreachable")
    return {"hushhId": hushh_id, "podStatus": status, "diagnostic": body}


@router.get("/{hushh_id}/diagnostics/model")
async def relay_pod_model_diagnostic_route(
    hushh_id: str = Path(..., min_length=1, max_length=128),
    model: str = Query(..., min_length=1, max_length=96),
    location: str = Query(default="", max_length=64),
    user_id: str = Depends(require_firebase_auth),
) -> dict:
    """The private relay: can the person's own pod reach a model on their own Vertex?"""
    return await relay_pod_model_diagnostic(
        hushh_id=hushh_id, user_id=user_id, model=model, location=location
    )


@router.get("/{hushh_id}/info")
async def relay_pod_info_route(
    hushh_id: str = Path(..., min_length=1, max_length=128),
    user_id: str = Depends(require_firebase_auth),
) -> dict:
    """The private relay: owner-authorized proxy to a pod's /pod/info."""
    return await relay_pod_info(hushh_id=hushh_id, user_id=user_id)


# -- the turn -----------------------------------------------------------------
#
# The last link in the chain. Everything before this made a pod EXIST and be
# reachable; this is what lets a person's message reach the agent running on it.
#
# Non-streaming, matching `api/routes/one/pod_turn.py` on purpose. That route
# collects its events into one response precisely so a First Light failure is
# attributable to the agent running in a pod rather than to transport. Streaming
# through the relay is its own set of failure modes and changing two contracts at
# once would make the first real failure ambiguous, which is the whole thing this
# ordering exists to avoid.


class PodTurnRelayRequest(BaseModel):
    message: str = Field(..., min_length=1, max_length=8000)
    conversation_id: str = Field(default="pod-first-light", alias="conversationId", max_length=128)
    timezone: Optional[str] = Field(default=None, max_length=64)
    # The OWNER'S model key, carried through from the browser. The hub does not
    # hold it -- it lives in the person's own vault, decrypted client-side -- and
    # `exclude=True` keeps it out of every serialisation of this model, so it
    # cannot reach a log line by being part of a request dump.
    runtime_credential: Optional[str] = Field(
        default=None, alias="runtimeCredential", max_length=12000, exclude=True
    )
    runtime_credential_transport: str = Field(
        default="developer_api", alias="runtimeCredentialTransport", max_length=32
    )
    runtime_provider: Optional[str] = Field(default=None, alias="runtimeProvider", max_length=32)
    puppy_device_id: Optional[str] = Field(default=None, alias="puppyDeviceId", max_length=128)
    vertex_project: Optional[str] = Field(default=None, alias="vertexProject", max_length=30)
    vertex_location: Optional[str] = Field(default=None, alias="vertexLocation", max_length=64)
    # The owner's consented turn projection, decrypted client-side from their own
    # unlocked vault -- the SAME value the browser already computes and already
    # sends to the hub on every Agent Chat turn.
    #
    # This is what makes a pod turn grounded without the pod holding PKM or reaching
    # Postgres, and it preserves Zero Knowledge exactly: the projection is opened by
    # the owner's key on the owner's device, and the hub is a courier for a value it
    # could already see on the hub path.
    #
    # `exclude=True` for the same reason as the credential above: it is the person's
    # holdings, and a request dump must not be able to carry it into a log line.
    # 20000 matches the hub's own cap in agent_chat, so a projection the hub accepts
    # cannot be 422'd here and surface as an opaque relay refusal.
    pkm_context: Optional[str] = Field(
        default=None, alias="pkmContext", max_length=20000, exclude=True
    )
    # The recent conversation turns, carried from the browser so the pod has the
    # thread the hub would have had from its database. Without it the pod seeded
    # an empty history and lost within-conversation continuity (a follow-up could
    # forget the immediately-prior turn). Memory-only by the same discipline as
    # the projection above: `exclude=True` keeps it out of every serialisation so
    # a request dump cannot carry the person's conversation into a log, and the
    # pod caps it (last 20, user/assistant only, 4000 chars each) exactly as the
    # hub runner does. It is the person's own words, couriered, never stored here.
    history: Optional[list[dict[str, str]]] = Field(default=None, exclude=True)

    model_config = ConfigDict(populate_by_name=True)


_PUPPY_INFERENCE_GRANT_TTL_MS = 60 * 60 * 1000


async def _issue_puppy_inference_grant(
    *,
    user_id: str,
    device_id: str,
    issuer: Any = None,
    device_active: Any = None,
) -> str:
    """Mint the device-scoped Puppy grant at the owner relay boundary.

    A caller may select a registered device, but it cannot supply the token that
    authorizes that device. The hub verifies the active trusted-device row and
    mints the existing ``cap.puppy.inference`` grant bound to ``device:<id>``;
    the pod or hub relay then verifies that grant again before dispatch. This
    keeps the MCP/Puppy path on the existing authority rather than making the
    consumer task a second grant issuer.
    """
    clean_device = str(device_id or "").strip()
    if not clean_device:
        raise HTTPException(status_code=400, detail="Puppy device is required")

    if device_active is None:
        from hushh_mcp.services.trusted_device_service import (  # noqa: PLC0415
            TrustedDeviceService,
        )

        service = TrustedDeviceService()
        active = await run_in_threadpool(
            service.is_active_device,
            user_id=user_id,
            device_id=clean_device,
        )
    else:
        active = device_active(user_id=user_id, device_id=clean_device)
        if inspect.isawaitable(active):
            active = await active
    if not active:
        raise HTTPException(status_code=403, detail="Puppy device is not active")

    if issuer is None:
        from hushh_mcp.services.personal_agent_grant_service import (  # noqa: PLC0415
            PersonalAgentGrantService,
        )

        issuer = PersonalAgentGrantService().issue_or_reuse_standing_scope
    try:
        grant = await issuer(
            user_id,
            scope=ConsentScope.CAP_PUPPY_INFERENCE,
            grant_kind="puppy_inference",
            scope_description=(
                "Allow the linked Puppy One device to answer private-agent inference requests"
            ),
            pod_agent_id=f"device:{clean_device}",
            expires_in_ms=_PUPPY_INFERENCE_GRANT_TTL_MS,
        )
    except Exception as exc:  # noqa: BLE001 - authority failure fails closed
        logger.warning("pod_relay.puppy_grant_failed %s", type(exc).__name__)
        raise HTTPException(status_code=503, detail="Puppy inference grant unavailable") from None
    token = str((grant or {}).get("token") or "")
    if not token:
        raise HTTPException(status_code=503, detail="Puppy inference grant unavailable")
    return token


def _not_ready(status: str) -> HTTPException:
    """A typed refusal that says WHICH not-ready this is.

    The relay used to answer a bare 409 "pod is not reachable yet", and the primary
    surface rendered that as an opaque error frame -- during the exact window
    between a person connecting their AI key and their agent being finished, which
    is when they are most likely to think the product is broken.

    The code is stable for the client to branch on; the status is the real registry
    state, so the UI can say "starting up" rather than "something went wrong".
    """
    if status == "migrating":
        # Its own code and its own sentence, because this is the one not-ready
        # state that is GOING somewhere. "Starting up" would be false and would
        # invite a retry loop against a pod that is deliberately frozen while its
        # log is exported -- and the export's single-writer assumption is exactly
        # what the freeze makes true.
        return HTTPException(
            status_code=409,
            detail={
                "code": "AGENT_MIGRATING",
                "status": status,
                "message": "Your agent is moving to your cloud. This takes a minute or two.",
            },
        )
    return HTTPException(
        status_code=409,
        detail={
            "code": "AGENT_NOT_READY",
            "status": status or "unknown",
        },
    )


async def issue_pod_data_door_grants(user_id: str, *, door_grants: Any = None) -> dict[str, str]:
    """Separate invocation/read grants shared by text and Live pod transports."""
    data_door_grants: dict[str, str] = {}
    from hushh_mcp.services.personal_agent_grant_service import PersonalAgentGrantService

    try:
        invoke_grant = await PersonalAgentGrantService().issue_or_reuse_standing_scope(
            user_id,
            scope=ConsentScope.CAP_ONE_INVOKE,
            grant_kind="one_invoke",
            scope_description="Delegate your requests to the private agent's shared specialists",
        )
        invoke_token = str((invoke_grant or {}).get("token") or "")
        if invoke_token:
            data_door_grants["invoke"] = invoke_token
    except Exception as exc:
        logger.info("pod_relay.data_door_grant_skipped door=invoke %s", type(exc).__name__)
    if pod_data_door_enabled():
        try:
            marketplace_grant = await PersonalAgentGrantService().issue_or_reuse_standing_scope(
                user_id,
                scope=ConsentScope.CAP_PKM_MARKETPLACE_VIEW,
                grant_kind="marketplace_view",
                scope_description="Read publication metadata and potential marketplace earnings",
            )
            marketplace_token = str((marketplace_grant or {}).get("token") or "")
            if marketplace_token:
                data_door_grants["marketplace"] = marketplace_token
        except Exception as exc:
            logger.info("pod_relay.data_door_grant_skipped door=marketplace %s", type(exc).__name__)
        door_issuer = (
            door_grants or PersonalAgentGrantService().issue_or_reuse_standing_location_view
        )
        try:
            nav_grant = await PersonalAgentGrantService().issue_or_reuse_standing_scope(
                user_id,
                scope=ConsentScope.AGENT_NAV_REVIEW,
                grant_kind="nav_review",
                scope_description="Review your active and previous consent grants",
            )
            nav_token = str((nav_grant or {}).get("token") or "")
            if nav_token:
                data_door_grants["nav"] = nav_token
        except Exception as exc:
            logger.info("pod_relay.data_door_grant_skipped door=nav %s", type(exc).__name__)
        try:
            location_grant = await door_issuer(user_id)
            token = str((location_grant or {}).get("token") or "")
            if token:
                data_door_grants["location"] = token
        except Exception as exc:  # noqa: BLE001 - a door mint failure degrades the read, never the turn
            logger.info("pod_relay.data_door_grant_skipped %s", type(exc).__name__)

        # The email door grant (the next door in the staged plan). Minted
        # INDEPENDENTLY via the general standing-scope issuer and best-effort: a
        # failure here degrades only email's read to runtime_unavailable, never
        # the turn and never the location door. Same short-TTL, Nav-narrated,
        # owner-revocable shape as location; the scope is cap.email.inbox.view.
        try:
            email_grant = await PersonalAgentGrantService().issue_or_reuse_standing_scope(
                user_id,
                scope=ConsentScope.CAP_EMAIL_INBOX_VIEW,
                grant_kind="email_inbox_view",
                scope_description="Read a summary of your inbox to answer email questions",
            )
            email_token = str((email_grant or {}).get("token") or "")
            if email_token:
                data_door_grants["email"] = email_token
        except Exception as exc:  # noqa: BLE001 - a door mint failure degrades the read, never the turn
            logger.info("pod_relay.data_door_grant_skipped door=email %s", type(exc).__name__)
        # The calendar door grant (third door). Read-only upcoming events through
        # the broker; the pod still cannot propose or execute a change from a
        # keyless runtime, and the summary says where to do that. Independent and
        # best-effort exactly like email.
        try:
            calendar_grant = await PersonalAgentGrantService().issue_or_reuse_standing_scope(
                user_id,
                scope=ConsentScope.CAP_CALENDAR_EVENTS_VIEW,
                grant_kind="calendar_events_view",
                scope_description="Read your upcoming calendar events to answer schedule questions",
            )
            calendar_token = str((calendar_grant or {}).get("token") or "")
            if calendar_token:
                data_door_grants["calendar"] = calendar_token
        except Exception as exc:  # noqa: BLE001 - a door mint failure degrades the read, never the turn
            logger.info("pod_relay.data_door_grant_skipped door=calendar %s", type(exc).__name__)
        # The Location PROPOSAL path. A standing share scope lets the pod's own
        # Location service propose a public link with zero hub information
        # reads: the pod proposes, the browser shows the owner-confirmation card,
        # and nothing is created here. It is the first specialist path that can
        # earn `specialists-run-in-pod`. Keyed by scope name (not a door name)
        # because it is an authority to propose, not a door to read through;
        # the pod's Location service reads it under exactly that key. Same
        # short-TTL, Nav-narrated, owner-revocable shape, same best-effort rule.
        try:
            share_grant = await PersonalAgentGrantService().issue_or_reuse_standing_scope(
                user_id,
                scope=ConsentScope.CAP_LOCATION_LIVE_SHARE,
                grant_kind="location_live_share",
                scope_description="Propose a public location link for your confirmation",
            )
            share_token = str((share_grant or {}).get("token") or "")
            if share_token:
                data_door_grants[ConsentScope.CAP_LOCATION_LIVE_SHARE.value] = share_token
        except Exception as exc:  # noqa: BLE001 - a mint failure degrades the proposal, never the turn
            logger.info(
                "pod_relay.data_door_grant_skipped door=location_share %s", type(exc).__name__
            )

    return data_door_grants


async def relay_pod_turn(
    *,
    hushh_id: str,
    user_id: str,
    payload: PodTurnRelayRequest,
    registry: Optional[PersonalAgentRegistryRepo] = None,
    audit: Optional[PodAccessAuditService] = None,
    grants: Any = None,
    puppy_grants: Any = None,
    puppy_device_active: Any = None,
    door_grants: Any = None,
    correlation: Optional[dict[str, str]] = None,
    session: Any = None,
) -> dict:
    """Owner-authorized turn against a person's own pod."""
    _require_enabled()
    repo = registry or PersonalAgentRegistryRepo()
    auditor = audit or PodAccessAuditService(registry=repo)

    try:
        await auditor.authorize_owner_read(
            user_id=user_id,
            agent_id=PERSONAL_AGENT_ID,
            scope=ConsentScope.PKM_READ.value,
            hushh_id=hushh_id,
            request_id=f"relay-turn:{hushh_id}",
        )
    except PodAccessDenied as exc:
        # Same single shape as the info relay: never an oracle for which HusshIDs
        # exist, and never a hint about whose pod this is.
        logger.info("pod_relay.turn_denied reason=%s", str(exc))
        raise HTTPException(status_code=403, detail="not authorized for this pod") from exc
    except PersonalAgentDisabledError as exc:
        raise HTTPException(status_code=404, detail="personal agent is not available") from exc

    row = await repo.get(user_id) or {}
    # A frozen pod still HAS a url, so the url check below would happily serve a
    # turn into a log that is being exported. The freeze has to be read from the
    # status, and it has to be read before anything else touches the pod.
    if str(row.get("status") or "") == "migrating":
        raise _not_ready("migrating")
    url = _pod_url(row)
    if url is None:
        raise _not_ready(str(row.get("status") or ""))

    # The consent token is minted HERE, server-side, and is a `pkm.read` grant
    # bound to the personal-agent identity. It is never accepted from the caller:
    # a client-supplied token is a client-chosen authority, and the one token a
    # browser actually holds is `vault.owner` -- the master grant, which would give
    # the pod everything.
    issuer = grants
    if issuer is None:
        from hushh_mcp.services.personal_agent_grant_service import (  # noqa: PLC0415
            PersonalAgentGrantService,
        )

        issuer = PersonalAgentGrantService().issue_or_reuse_standing_pkm_read
    try:
        grant = await issuer(user_id)
    except PersonalAgentDisabledError as exc:
        raise HTTPException(status_code=404, detail="personal agent is not available") from exc
    except Exception as exc:  # noqa: BLE001 - no grant means no turn, and say so plainly
        logger.warning("pod_relay.grant_failed %s", type(exc).__name__)
        raise HTTPException(
            status_code=503, detail="could not authorize your agent to read for you"
        ) from exc

    # The data-door grants: standing, owner-visible, revocable scopes that let a
    # keyless pod READ a DB-backed specialist THROUGH the hub broker. Minted here,
    # server-side, exactly like the pkm.read grant and never accepted from the
    # caller. Best-effort by design: unlike pkm.read (no grant, no turn), a
    # location grant that cannot be minted just means the pod falls back to
    # runtime_unavailable for location -- today's DB-wall behaviour -- so a mint
    # failure must degrade the read, never fail the turn. Behind the flag: off,
    # no grant is couriered and the pod cannot reach the door at all.
    data_door_grants = await issue_pod_data_door_grants(user_id, door_grants=door_grants)

    # Puppy is an explicit device lane, never a caller-selected provider router.
    # Mint its short-lived device-bound authority here and ignore any credential
    # a caller placed in the request. BYOK credentials remain caller-carried for
    # the ordinary owner-model path; Puppy credentials are hub-issued only.
    puppy_token = None
    if str(payload.runtime_provider or "").strip().lower() == "puppy":
        puppy_token = await _issue_puppy_inference_grant(
            user_id=user_id,
            device_id=str(payload.puppy_device_id or ""),
            issuer=puppy_grants,
            device_active=puppy_device_active,
        )

    body: dict[str, Any] = {
        "message": payload.message,
        "conversationId": payload.conversation_id,
        "timezone": payload.timezone,
        "runtimeCredential": puppy_token or payload.runtime_credential,
        "runtimeCredentialTransport": payload.runtime_credential_transport,
        "runtimeProvider": payload.runtime_provider,
        "puppyDeviceId": payload.puppy_device_id,
        "vertexProject": payload.vertex_project,
        "vertexLocation": payload.vertex_location,
        "pkmContext": payload.pkm_context,
        # Forwarded memory-only, exactly as pkmContext is: the pod seeds it into
        # the turn and holds nothing after. Absent stays absent (an older webapp
        # sends none -> today's empty-history behaviour).
        "history": payload.history or [],
        # The per-specialist scope tokens the pod couriers back to the broker to
        # read. Empty unless the flag is on and a grant minted.
        "dataDoorGrants": data_door_grants,
    }
    status, answer = await _proxy_post(
        url,
        "/api/one/pod/turn",
        body=body,
        consent_token=str(grant.get("token") or ""),
        correlation=correlation,
        session=session,
    )
    if status == 503:
        raise HTTPException(status_code=503, detail="your agent is not answering right now")
    if status >= 400:
        # The pod's own refusal, forwarded with its shape intact. A pod that says
        # "connect an AI key first" (400) must not reach the person as a 500.
        raise HTTPException(status_code=status, detail=answer)

    # THE AUTHORITY HOP. The pod PROPOSED directives (intent, no id, no grant);
    # here -- and only here, on the DB-capable hub, for the authenticated owner --
    # they are superseded, re-validated, ledger-issued, and translated to the same
    # frames the hub chat route emits. Flag-gated: off, the pod's directives are
    # ignored exactly as today; on, the browser can act on them.
    from hushh_mcp.runtime_settings import pod_directive_transport_enabled  # noqa: PLC0415

    if isinstance(answer, dict):
        # The authority hop is the ONLY source of "frames". A compromised pod
        # could return its own "frames" array; strip it UNCONDITIONALLY (in both
        # flag states) so a forged card can never reach the browser, then set it
        # only from the authorized translation when the flag is on. Defense in
        # depth: the browser never renders a frame the relay did not mint.
        answer = {k: v for k, v in answer.items() if k != "frames"}
        if pod_directive_transport_enabled():
            answer["frames"] = await _authorize_and_frame_directives(
                user_id=user_id,
                conversation_id=payload.conversation_id,
                answer=answer,
            )
    return {"hushhId": hushh_id, **(answer if isinstance(answer, dict) else {"pod": answer})}


async def _authorize_and_frame_directives(
    *, user_id: str, conversation_id: Optional[str], answer: dict[str, Any]
) -> list[dict[str, Any]]:
    """Authorize the pod's PROPOSED directives into browser-ready SSE frames.

    The security spine of pod directive transport. A pod cannot reach this code;
    only the relay can, and only for the authenticated owner. For each directive
    the pod proposed:

      * prior proposals for this conversation are superseded first (the
        server-side disarm the hub performs and the relay lacked until now -- a
        pod directive used to linger to its TTL);
      * an ``action`` directive is re-validated against the gateway (an unknown
        id yields no card), issued as a SINGLE-USE ledger entry with
        ``trusted_activation_required=True`` forced on (no direct-execute bypass),
        capped at one per turn;
      * a delegate/prompt directive carries no ledger entry -- it is a screen
        hint the owner's own session acts on.

    A directive therefore grants nothing the pod did not already have: the pod's
    only standing grant is ``pkm.read``, which actions never consult, and every
    action still executes only through the vault-owner-token-gated
    confirm/consume/settle path the pod cannot touch. A failed issue drops the
    CARD, never the answer -- the owner's model already billed for the turn. Logs
    carry ``action_id`` and outcome only, never slots or payload (slots can be
    holdings-derived).
    """
    from hushh_mcp.one_adk.text_runtime import OneTextDirective  # noqa: PLC0415
    from hushh_mcp.services.action_directive_ledger import (  # noqa: PLC0415
        get_action_directive_store,
    )
    from hushh_mcp.services.action_gateway import get_action_gateway_action  # noqa: PLC0415
    from hushh_mcp.services.one_directive_frames import (  # noqa: PLC0415
        EXCLUDED_AGENT_CHAT_SPECIALISTS,
        one_directive_frames,
    )

    raw = answer.get("directives")
    if not isinstance(raw, list) or not raw:
        return []
    text = str(answer.get("text") or "")
    store = get_action_directive_store()

    if conversation_id:
        try:
            await store.cancel_open_for_conversation(
                user_id=user_id, conversation_id=conversation_id
            )
        except Exception:  # noqa: BLE001 - a failed supersede must not drop the answer
            logger.warning("pod_relay.directive_cancel_open_failed")

    frames: list[tuple[str, dict[str, Any]]] = []
    action_issued = False
    for item in raw:
        if not isinstance(item, dict):
            continue
        # kind is pod-supplied and untrusted; narrow it to the two the type
        # allows. Anything that is not an explicit "prompt" is treated as an
        # action (the only other path; a delegate directive renders as a
        # specialist regardless of kind, so the default never mis-routes it).
        kind: Literal["action", "prompt"] = "prompt" if item.get("kind") == "prompt" else "action"
        payload_value = item.get("payload")
        directive = OneTextDirective(
            kind=kind,
            payload=payload_value if isinstance(payload_value, dict) else {},
            delegate_agent_id=item.get("delegateAgentId"),
        )
        # A directive renders as a SPECIALIST card (no ledger) only when it names
        # a non-excluded delegate. The check must match how one_directive_frames
        # actually renders, not merely whether a delegate tag is present: the
        # translator renders an EXCLUDED delegate as an ACTION card, so a pod
        # tagging an action directive with an excluded delegate must NOT take the
        # ledger-free path. That was the hole -- it emitted a confirm-shaped card
        # with no directive_id, no ledger row, dodging the cap and the supersede.
        renders_as_specialist = bool(
            directive.delegate_agent_id
            and directive.delegate_agent_id not in EXCLUDED_AGENT_CHAT_SPECIALISTS
        )
        if renders_as_specialist or directive.kind != "action":
            frames.extend(one_directive_frames(directive, conversation_text=text))
            continue
        # Everything reaching here renders as an ACTION card and MUST carry a
        # single-use ledger entry, capped at one per turn.
        if action_issued:
            continue  # one action directive per turn, mirroring the hub cap
        action_id = str(directive.payload.get("actionId") or "").strip()
        action = get_action_gateway_action(action_id)
        if action is None or not conversation_id:
            logger.info(
                "pod_relay.directive_dropped action_id=%s outcome=unknown_action", action_id
            )
            continue
        try:
            issued = await store.issue(
                user_id=user_id,
                channel="typed_chat",
                conversation_id=conversation_id,
                action_id=action_id,
                context_revision=f"conversation:{conversation_id}",
                action_contract=action,
                slots=directive.payload.get("slots")
                if isinstance(directive.payload.get("slots"), dict)
                else {},
                trusted_activation_required=True,
            )
        except Exception:  # noqa: BLE001 - a failed issue drops the CARD, never the answer
            logger.warning(
                "pod_relay.directive_issue_failed action_id=%s outcome=dropped", action_id
            )
            continue
        action_issued = True
        frames.extend(
            one_directive_frames(
                directive,
                conversation_text=text,
                directive_id=issued.directive_id,
                conversation_id=conversation_id,
                context_revision=issued.context_revision,
                expires_at=issued.expires_at.isoformat(),
            )
        )
        logger.info("pod_relay.directive_issued action_id=%s outcome=issued", action_id)
    return [{"event": name, "data": data} for name, data in frames]


@router.post("/{hushh_id}/turn")
async def relay_pod_turn_route(
    request: Request,
    payload: PodTurnRelayRequest = Body(...),
    hushh_id: str = Path(..., min_length=1, max_length=128),
    user_id: str = Depends(require_firebase_auth),
) -> dict:
    """Run one turn on this person's own pod."""
    return await relay_pod_turn(
        hushh_id=hushh_id,
        user_id=user_id,
        payload=payload,
        # Only the route has the inbound request, and only the inbound request has
        # the ids the browser minted. Resolved here rather than inside the relay so
        # the testable core stays free of a framework object.
        correlation=_correlation_headers(request),
    )


# -- the learning loop's doors, beside the turn ----------------------------------
#
# Same three guards as the turn, same server-minted pkm.read grant, same URL
# from the registry row. A memory door is an OWNER door: nothing here is reachable
# without the Firebase identity that owns the HusshID, and every attempt is on
# the POD_ACCESS ledger through the audit service.


async def _owner_pod_target(
    *,
    hushh_id: str,
    user_id: str,
    request_id: str,
    registry: Optional[PersonalAgentRegistryRepo] = None,
    audit: Optional[PodAccessAuditService] = None,
    grants: Any = None,
) -> tuple[str, str]:
    """Authorize the owner, resolve their pod URL, mint the pkm.read grant."""
    _require_enabled()
    repo = registry or PersonalAgentRegistryRepo()
    auditor = audit or PodAccessAuditService(registry=repo)
    try:
        await auditor.authorize_owner_read(
            user_id=user_id,
            agent_id=PERSONAL_AGENT_ID,
            scope=ConsentScope.PKM_READ.value,
            hushh_id=hushh_id,
            request_id=request_id,
        )
    except PodAccessDenied as exc:
        logger.info("pod_relay.memory_denied reason=%s", str(exc))
        raise HTTPException(status_code=403, detail="not authorized for this pod") from exc
    except PersonalAgentDisabledError as exc:
        raise HTTPException(status_code=404, detail="personal agent is not available") from exc
    row = await repo.get(user_id) or {}
    if str(row.get("status") or "") == "migrating":
        raise _not_ready("migrating")
    url = _pod_url(row)
    if url is None:
        raise _not_ready(str(row.get("status") or ""))
    issuer = grants
    if issuer is None:
        from hushh_mcp.services.personal_agent_grant_service import (  # noqa: PLC0415
            PersonalAgentGrantService,
        )

        issuer = PersonalAgentGrantService().issue_or_reuse_standing_pkm_read
    try:
        grant = await issuer(user_id)
    except PersonalAgentDisabledError as exc:
        raise HTTPException(status_code=404, detail="personal agent is not available") from exc
    except Exception as exc:  # noqa: BLE001 - no grant means no door, and say so plainly
        logger.warning("pod_relay.grant_failed %s", type(exc).__name__)
        raise HTTPException(
            status_code=503, detail="could not authorize your agent to read for you"
        ) from exc
    return url, str(grant.get("token") or "")


# -- durable delegated tasks --------------------------------------------------------
#
# The task lane deliberately reuses the owner-pod target and pkm.read grant above.
# Its separate X-One-Invoke-Token is the already approved consumer delegation
# grant; the pod verifies both before it persists or starts any work.


async def relay_pod_task_start(
    *,
    hushh_id: str,
    user_id: str,
    agent_id: str,
    invoke_token: str,
    arguments: dict[str, Any],
    registry: Optional[PersonalAgentRegistryRepo] = None,
    audit: Optional[PodAccessAuditService] = None,
    grants: Any = None,
    session: Any = None,
) -> dict[str, Any]:
    url, pkm_token = await _owner_pod_target(
        hushh_id=hushh_id,
        user_id=user_id,
        request_id=f"relay-task-start:{hushh_id}",
        registry=registry,
        audit=audit,
        grants=grants,
    )
    body = {
        "ownerId": user_id,
        "agentId": agent_id,
        "message": arguments.get("message"),
        "conversationId": arguments.get("conversation_id", "consumer-mcp"),
        "timezone": arguments.get("timezone"),
        "runtimeProvider": arguments.get("runtime_provider"),
        "puppyDeviceId": arguments.get("puppy_device_id"),
        "idempotencyKey": arguments.get("idempotency_key", ""),
    }
    status, result = await _proxy_post(
        url,
        "/api/one/pod/tasks",
        body=body,
        consent_token=pkm_token,
        extra_headers={"X-One-Invoke-Token": invoke_token},
        session=session,
    )
    if status >= 400:
        raise HTTPException(status_code=status, detail="owner pod task unavailable")
    if not isinstance(result, dict) or str(result.get("execution_target") or "") != "owner_pod":
        raise HTTPException(status_code=502, detail="owner pod returned an invalid task")
    return {"hushhId": hushh_id, **result}


async def relay_pod_task_status(
    *,
    hushh_id: str,
    user_id: str,
    agent_id: str,
    task_id: str,
    invoke_token: str,
    registry: Optional[PersonalAgentRegistryRepo] = None,
    audit: Optional[PodAccessAuditService] = None,
    session: Any = None,
) -> dict[str, Any]:
    url, _ = await _owner_pod_target(
        hushh_id=hushh_id,
        user_id=user_id,
        request_id=f"relay-task-status:{hushh_id}",
        registry=registry,
        audit=audit,
    )
    from urllib.parse import urlencode  # noqa: PLC0415

    query = urlencode({"ownerId": user_id, "agentId": agent_id})
    status, result = await _proxy_get(
        url,
        f"/api/one/pod/tasks/{task_id}?{query}",
        extra_headers={"X-One-Invoke-Token": invoke_token},
        session=session,
    )
    if status >= 400:
        raise HTTPException(status_code=status, detail="owner pod task unavailable")
    if not isinstance(result, dict) or str(result.get("execution_target") or "") != "owner_pod":
        raise HTTPException(status_code=502, detail="owner pod returned an invalid task")
    return {"hushhId": hushh_id, **result}


async def relay_pod_task_cancel(
    *,
    hushh_id: str,
    user_id: str,
    agent_id: str,
    task_id: str,
    invoke_token: str,
    registry: Optional[PersonalAgentRegistryRepo] = None,
    audit: Optional[PodAccessAuditService] = None,
    session: Any = None,
) -> dict[str, Any]:
    url, _ = await _owner_pod_target(
        hushh_id=hushh_id,
        user_id=user_id,
        request_id=f"relay-task-cancel:{hushh_id}",
        registry=registry,
        audit=audit,
    )
    from urllib.parse import urlencode  # noqa: PLC0415

    query = urlencode({"ownerId": user_id, "agentId": agent_id})
    status, result = await _proxy_post(
        url,
        f"/api/one/pod/tasks/{task_id}/cancel?{query}",
        body={},
        consent_token="",
        extra_headers={"X-One-Invoke-Token": invoke_token},
        session=session,
    )
    if status >= 400:
        raise HTTPException(status_code=status, detail="owner pod task unavailable")
    if not isinstance(result, dict) or str(result.get("execution_target") or "") != "owner_pod":
        raise HTTPException(status_code=502, detail="owner pod returned an invalid task")
    return {"hushhId": hushh_id, **result}


class PodConversationCloseRelayRequest(BaseModel):
    """The runtime triple of the conversation being closed; excluded from dumps."""

    runtime_credential: Optional[str] = Field(
        default=None, alias="runtimeCredential", max_length=12000, exclude=True
    )
    runtime_credential_transport: str = Field(
        default="developer_api", alias="runtimeCredentialTransport", max_length=32
    )
    runtime_provider: Optional[str] = Field(default=None, alias="runtimeProvider", max_length=32)
    puppy_device_id: Optional[str] = Field(default=None, alias="puppyDeviceId", max_length=128)
    vertex_project: Optional[str] = Field(default=None, alias="vertexProject", max_length=30)
    vertex_location: Optional[str] = Field(default=None, alias="vertexLocation", max_length=64)

    model_config = ConfigDict(populate_by_name=True)


async def relay_pod_conversation_close(
    *,
    hushh_id: str,
    user_id: str,
    conversation_id: str,
    payload: PodConversationCloseRelayRequest,
    registry: Optional[PersonalAgentRegistryRepo] = None,
    audit: Optional[PodAccessAuditService] = None,
    grants: Any = None,
    correlation: Optional[dict[str, str]] = None,
    session: Any = None,
) -> dict:
    """Owner-authorized conversation close against their own pod."""
    url, token = await _owner_pod_target(
        hushh_id=hushh_id,
        user_id=user_id,
        request_id=f"relay-close:{hushh_id}",
        registry=registry,
        audit=audit,
        grants=grants,
    )
    body: dict[str, Any] = {
        "runtimeCredential": payload.runtime_credential,
        "runtimeCredentialTransport": payload.runtime_credential_transport,
        "runtimeProvider": payload.runtime_provider,
        "puppyDeviceId": payload.puppy_device_id,
        "vertexProject": payload.vertex_project,
        "vertexLocation": payload.vertex_location,
    }
    status, answer = await _proxy_post(
        url,
        f"/api/one/pod/conversation/{conversation_id}/close",
        body=body,
        consent_token=token,
        correlation=correlation,
        session=session,
    )
    if status == 503:
        raise HTTPException(status_code=503, detail="your agent is not answering right now")
    if status >= 400:
        raise HTTPException(status_code=status, detail=answer)
    if isinstance(answer, dict):
        # The pod PROPOSES; the relay never mints a frame from a close. Strip any
        # frames unconditionally, exactly as the turn relay does.
        answer = {k: v for k, v in answer.items() if k != "frames"}
    return {"hushhId": hushh_id, **(answer if isinstance(answer, dict) else {"pod": answer})}


@router.post("/{hushh_id}/conversation/{conversation_id}/close")
async def relay_pod_conversation_close_route(
    request: Request,
    payload: PodConversationCloseRelayRequest = Body(default=PodConversationCloseRelayRequest()),
    hushh_id: str = Path(..., min_length=1, max_length=128),
    conversation_id: str = Path(..., min_length=1, max_length=128),
    user_id: str = Depends(require_firebase_auth),
) -> dict:
    """The person left the chat: let their pod review it on the conversation's model."""
    return await relay_pod_conversation_close(
        hushh_id=hushh_id,
        user_id=user_id,
        conversation_id=conversation_id,
        payload=payload,
        correlation=_correlation_headers(request),
    )


_MEMORY_PROVIDER_CONSENT_TTL_MS = 5 * 60 * 1000


class PodMemoryRevokeRelayRequest(BaseModel):
    memory_ids: list[str] = Field(..., alias="memoryIds", min_length=1, max_length=50)
    reason_code: str = Field(default="owner_request", alias="reasonCode", max_length=32)

    model_config = ConfigDict(populate_by_name=True)


class PodMemoryProviderConsentRelayRequest(BaseModel):
    granted: bool

    model_config = ConfigDict(populate_by_name=True)


async def _relay_memory_post(
    *,
    hushh_id: str,
    user_id: str,
    path: str,
    body: dict[str, Any],
    request_id: str,
    registry: Optional[PersonalAgentRegistryRepo] = None,
    audit: Optional[PodAccessAuditService] = None,
    grants: Any = None,
    correlation: Optional[dict[str, str]] = None,
    session: Any = None,
) -> dict:
    url, token = await _owner_pod_target(
        hushh_id=hushh_id,
        user_id=user_id,
        request_id=request_id,
        registry=registry,
        audit=audit,
        grants=grants,
    )
    status, answer = await _proxy_post(
        url, path, body=body, consent_token=token, correlation=correlation, session=session
    )
    if status == 503:
        raise HTTPException(status_code=503, detail="your agent is not answering right now")
    if status >= 400:
        raise HTTPException(status_code=status, detail=answer)
    if isinstance(answer, dict):
        answer = {k: v for k, v in answer.items() if k != "frames"}
    return {"hushhId": hushh_id, **(answer if isinstance(answer, dict) else {"pod": answer})}


async def relay_pod_memory_revoke(
    *,
    hushh_id: str,
    user_id: str,
    payload: PodMemoryRevokeRelayRequest,
    registry: Optional[PersonalAgentRegistryRepo] = None,
    audit: Optional[PodAccessAuditService] = None,
    grants: Any = None,
    correlation: Optional[dict[str, str]] = None,
    session: Any = None,
) -> dict:
    """Owner-authorized revocation of named memories on their own pod."""
    return await _relay_memory_post(
        hushh_id=hushh_id,
        user_id=user_id,
        path="/api/one/pod/memory/revoke",
        body={"memoryIds": list(payload.memory_ids), "reasonCode": payload.reason_code},
        request_id=f"relay-memory-revoke:{hushh_id}",
        registry=registry,
        audit=audit,
        grants=grants,
        correlation=correlation,
        session=session,
    )


async def relay_pod_memory_provider_consent(
    *,
    hushh_id: str,
    user_id: str,
    payload: PodMemoryProviderConsentRelayRequest,
    registry: Optional[PersonalAgentRegistryRepo] = None,
    audit: Optional[PodAccessAuditService] = None,
    grants: Any = None,
    provider_grants: Any = None,
    correlation: Optional[dict[str, str]] = None,
    session: Any = None,
) -> dict:
    """Mint the five-minute ``cap.memory.provider.process`` grant and hand it to the pod.

    Mirrors the Puppy inference grant: minted HERE, server-side, for the
    authenticated owner, never accepted from the caller, and bound to the
    personal-agent identity. The pod re-verifies it against the same authority
    before recording the durable consent in its own log. A withdrawal mints nothing.
    """
    from hushh_mcp.services.personal_agent_grant_service import (  # noqa: PLC0415
        PersonalAgentGrantService,
    )

    body: dict[str, Any] = {"granted": bool(payload.granted)}
    if payload.granted:
        issue = provider_grants
        if issue is None:
            issue = PersonalAgentGrantService().issue_or_reuse_standing_scope
        try:
            grant = await issue(
                user_id,
                scope=ConsentScope.CAP_MEMORY_PROVIDER_PROCESS,
                grant_kind="memory_provider_process",
                scope_description=(
                    "Allow the memory service in your own cloud project to process what "
                    "your private agent remembers"
                ),
                expires_in_ms=_MEMORY_PROVIDER_CONSENT_TTL_MS,
            )
        except Exception as exc:  # noqa: BLE001 - authority unavailable fails closed
            logger.warning("pod_relay.provider_consent_grant_failed %s", type(exc).__name__)
            raise HTTPException(
                status_code=503, detail="memory provider consent grant unavailable"
            ) from None
        body["providerConsentToken"] = str(grant.get("token") or "")
        if not body["providerConsentToken"]:
            raise HTTPException(status_code=503, detail="memory provider consent grant unavailable")
    return await _relay_memory_post(
        hushh_id=hushh_id,
        user_id=user_id,
        path="/api/one/pod/memory/provider-consent",
        body=body,
        request_id=f"relay-memory-consent:{hushh_id}",
        registry=registry,
        audit=audit,
        grants=grants,
        correlation=correlation,
        session=session,
    )


async def relay_pod_memory_status(
    *,
    hushh_id: str,
    user_id: str,
    registry: Optional[PersonalAgentRegistryRepo] = None,
    audit: Optional[PodAccessAuditService] = None,
    grants: Any = None,
    session: Any = None,
) -> dict:
    """Owner inspection of their pod's memory: counts and words, never content."""
    url, token = await _owner_pod_target(
        hushh_id=hushh_id,
        user_id=user_id,
        request_id=f"relay-memory-status:{hushh_id}",
        registry=registry,
        audit=audit,
        grants=grants,
    )
    client: Any = session
    if client is None:
        import requests  # type: ignore[import-untyped]  # noqa: PLC0415

        client = requests
    identity = await run_in_threadpool(_identity_token, url)
    if not identity:
        raise HTTPException(status_code=503, detail="pod identity unavailable")
    try:
        response = await run_in_threadpool(
            lambda: client.get(
                f"{url}/api/one/pod/memory/status",
                headers={"Authorization": f"Bearer {identity}", "X-Consent-Token": token},
                timeout=_INFO_TIMEOUT_SECONDS,
                allow_redirects=False,
            )
        )
    except Exception as exc:  # noqa: BLE001
        logger.info("pod_relay.memory_status_unreachable %s", type(exc).__name__)
        raise HTTPException(
            status_code=503, detail="your agent is not answering right now"
        ) from None
    status = getattr(response, "status_code", 502)
    if 300 <= status < 400:
        raise HTTPException(status_code=502, detail="pod redirect refused")
    try:
        answer = response.json()
    except Exception:  # noqa: BLE001
        answer = {"detail": "pod returned a non-JSON body"}
    if status >= 400:
        raise HTTPException(status_code=status, detail=answer)
    return {"hushhId": hushh_id, "memory": answer}


@router.post("/{hushh_id}/memory/revoke")
async def relay_pod_memory_revoke_route(
    request: Request,
    payload: PodMemoryRevokeRelayRequest = Body(...),
    hushh_id: str = Path(..., min_length=1, max_length=128),
    user_id: str = Depends(require_firebase_auth),
) -> dict:
    return await relay_pod_memory_revoke(
        hushh_id=hushh_id,
        user_id=user_id,
        payload=payload,
        correlation=_correlation_headers(request),
    )


@router.post("/{hushh_id}/memory/provider-consent")
async def relay_pod_memory_provider_consent_route(
    request: Request,
    payload: PodMemoryProviderConsentRelayRequest = Body(...),
    hushh_id: str = Path(..., min_length=1, max_length=128),
    user_id: str = Depends(require_firebase_auth),
) -> dict:
    return await relay_pod_memory_provider_consent(
        hushh_id=hushh_id,
        user_id=user_id,
        payload=payload,
        correlation=_correlation_headers(request),
    )


@router.get("/{hushh_id}/memory/status")
async def relay_pod_memory_status_route(
    hushh_id: str = Path(..., min_length=1, max_length=128),
    user_id: str = Depends(require_firebase_auth),
) -> dict:
    return await relay_pod_memory_status(hushh_id=hushh_id, user_id=user_id)
