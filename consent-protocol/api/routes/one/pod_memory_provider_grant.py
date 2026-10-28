"""Owner-authorized processing grants; no pod invocation or private memory transport."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Path, Response

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
router = APIRouter()
_MEMORY_PROVIDER_CONSENT_TTL_MS = 5 * 60 * 1000


def _require_enabled() -> None:
    if not personal_agent_enabled():
        raise HTTPException(404, detail="personal agent is not available")


async def _issue_memory_provider_grant(user_id: str, issuer: Any = None) -> dict:
    from hushh_mcp.services.personal_agent_grant_service import PersonalAgentGrantService

    issue = issuer or PersonalAgentGrantService().issue_or_reuse_standing_scope
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
    except Exception as exc:  # noqa: BLE001 - unavailable authority grants nothing
        logger.warning("pod_relay.provider_consent_grant_failed %s", type(exc).__name__)
        raise HTTPException(503, detail="memory provider consent grant unavailable") from None
    if not isinstance(grant, dict) or not str(grant.get("token") or "").strip():
        raise HTTPException(503, detail="memory provider consent grant unavailable")
    return grant


async def issue_memory_provider_grant(
    *,
    hushh_id: str,
    user_id: str,
    registry: Any = None,
    audit: Any = None,
    provider_grants: Any = None,
) -> dict:
    """Owner metadata only: mint consent, never invoke or read the private pod."""
    _require_enabled()
    auditor = audit or PodAccessAuditService(registry=registry or PersonalAgentRegistryRepo())
    try:
        await auditor.authorize_owner_read(
            user_id=user_id,
            agent_id=PERSONAL_AGENT_ID,
            scope=ConsentScope.PKM_READ.value,
            hushh_id=hushh_id,
            request_id=f"memory-provider-grant:{hushh_id}",
        )
    except PodAccessDenied:
        raise HTTPException(403, detail="not authorized for this pod") from None
    except PersonalAgentDisabledError:
        raise HTTPException(404, detail="personal agent is not available") from None
    grant = await _issue_memory_provider_grant(user_id, provider_grants)
    return {
        "hushhId": hushh_id,
        "providerConsentToken": grant["token"],
        "expiresAt": grant.get("expiresAt"),
    }


@router.post("/{hushh_id}/memory/provider-grant")
async def memory_provider_grant_route(
    response: Response,
    hushh_id: str = Path(..., min_length=1, max_length=128),
    user_id: str = Depends(require_firebase_auth),
) -> dict:
    response.headers["Cache-Control"] = "no-store"
    return await issue_memory_provider_grant(hushh_id=hushh_id, user_id=user_id)
