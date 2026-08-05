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

from fastapi import APIRouter, Depends, HTTPException, Path
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
