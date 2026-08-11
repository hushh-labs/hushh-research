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
hub wrote -- so there is nothing for a caller to point the proxy at.

Flag-gated: 404 while ``PERSONAL_AGENT_ENABLED`` is off, the same posture as
every other personal-agent surface.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Path, Request
from pydantic import BaseModel, ConfigDict, Field
from starlette.concurrency import run_in_threadpool

from api.middleware import require_firebase_auth
from hushh_mcp.constants import ConsentScope
from hushh_mcp.runtime_settings import personal_agent_enabled
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
_TURN_TIMEOUT_SECONDS = 120.0


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


async def _proxy_get(url: str, path: str, *, session: Any = None) -> tuple[int, Any]:
    client: Any = session
    if client is None:
        import requests  # type: ignore[import-untyped]  # noqa: PLC0415 - deferred so tests can inject

        client = requests
    token = await run_in_threadpool(_identity_token, url)
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    try:
        response = await run_in_threadpool(
            lambda: client.get(f"{url}{path}", headers=headers, timeout=_INFO_TIMEOUT_SECONDS)
        )
    except Exception as exc:  # noqa: BLE001 - a pod that is not up is a 503, not a 500
        logger.info("pod_relay.unreachable %s", type(exc).__name__)
        return 503, {"detail": "pod unreachable"}
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
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if consent_token:
        headers["X-Consent-Token"] = consent_token
    headers.update(correlation or {})
    try:
        response = await run_in_threadpool(
            lambda: client.post(
                f"{url}{path}", json=body, headers=headers, timeout=_TURN_TIMEOUT_SECONDS
            )
        )
    except Exception as exc:  # noqa: BLE001 - a pod that is not up is a 503, not a 500
        logger.info("pod_relay.turn_unreachable %s", type(exc).__name__)
        return 503, {"detail": "pod unreachable"}
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

    model_config = ConfigDict(populate_by_name=True)


def _not_ready(status: str) -> HTTPException:
    """A typed refusal that says WHICH not-ready this is.

    The relay used to answer a bare 409 "pod is not reachable yet", and the primary
    surface rendered that as an opaque error frame -- during the exact window
    between a person connecting their AI key and their agent being finished, which
    is when they are most likely to think the product is broken.

    The code is stable for the client to branch on; the status is the real registry
    state, so the UI can say "starting up" rather than "something went wrong".
    """
    return HTTPException(
        status_code=409,
        detail={
            "code": "AGENT_NOT_READY",
            "status": status or "unknown",
        },
    )


async def relay_pod_turn(
    *,
    hushh_id: str,
    user_id: str,
    payload: PodTurnRelayRequest,
    registry: Optional[PersonalAgentRegistryRepo] = None,
    audit: Optional[PodAccessAuditService] = None,
    grants: Any = None,
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

    body: dict[str, Any] = {
        "message": payload.message,
        "conversationId": payload.conversation_id,
        "timezone": payload.timezone,
        "runtimeCredential": payload.runtime_credential,
        "runtimeCredentialTransport": payload.runtime_credential_transport,
        "vertexProject": payload.vertex_project,
        "vertexLocation": payload.vertex_location,
        "pkmContext": payload.pkm_context,
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
    return {"hushhId": hushh_id, **(answer if isinstance(answer, dict) else {"pod": answer})}


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
