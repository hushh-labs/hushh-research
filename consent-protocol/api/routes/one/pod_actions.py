"""The owner confirms a change their own agent prepared: Calendar, Gmail, Drive.

``POST /api/one/pod/actions/{proposal_id}/confirm`` runs one prepared change, once:

* ``gcal_...`` a Calendar create, reschedule or cancel (``GoogleCalendarService``
  on the agent's own login, ``pod_google_connections``);
* ``gmod_...`` a reviewed Gmail mailbox change (``pod_gmail_mailbox``);
* ``gdrv_...`` a reviewed Drive share or trash (``pod_drive``).

Only the owner's own door opens it (``pod_owner_door``): this agent's app-role session
with scope ``pod.act`` and a held incarnation. A hub-relayed consent token is refused
with 403 ``OWNER_SESSION_REQUIRED`` even when valid, because a change the hub could
confirm is a change the hub could make. Only an agent in its owner's own cloud has
this door (404 anywhere else), and the session's owner must be the agent's owner.
The proposal is claimed in the owner's own log before anything is sent, so a second
confirmation of the same id gets 409 and nothing runs twice. Answers carry authored
codes only, never a provider body.
"""

from __future__ import annotations

import logging
import re
from typing import Any, Literal, Optional

from fastapi import APIRouter, Header, HTTPException, Request
from pydantic import BaseModel, ConfigDict, ValidationError

from api.routes.one.pod_owner_door import admit_owner_local, owner_local_door
from hushh_mcp.services.pod_session_authority import SCOPE_POD_ACT

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/one/pod", tags=["personal-agent"])

_PROPOSAL_ID = re.compile(r"^(?:gcal|gmod|gdrv)_[A-Za-z0-9_-]{16,64}$")


class GmailProposalRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    action: Literal["save_draft", "send_email"]
    draft: dict[str, Any]


async def run_gmail_proposal(
    payload: GmailProposalRequest,
    *,
    consent_token: str,
    verifier: Any = None,
    session: Optional[dict] = None,
    mailbox: Any = None,
) -> dict:
    """Keep exact email terms in the owner's log; preparation sends nothing."""
    from hushh_mcp.services.pod_gmail_mailbox import PodGmailMailboxActions
    from hushh_mcp.services.pod_owner_cloud import owner_cloud_agent, pod_owner_user_id

    if not owner_cloud_agent():
        raise HTTPException(404, detail="not found")

    async def require_access() -> dict:
        claims = await admit_owner_local(
            consent_token, verifier=verifier, session=session, scope=SCOPE_POD_ACT
        )
        if not claims.get("user_id") or claims["user_id"] != pod_owner_user_id():
            raise _refused(403, "OWNER_MISMATCH")
        return claims

    owner = str((await require_access())["user_id"])
    service = mailbox if mailbox is not None else PodGmailMailboxActions(owner)
    try:
        return await service.propose_email(
            user_id=owner,
            action=payload.action,
            draft_payload=payload.draft,
            require_access=require_access,
        )
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001 - no provider or email content in failures
        raise _explain(exc) from None


@router.post("/actions/gmail/proposals")
async def pod_gmail_proposal_route(
    request: Request,
    x_consent_token: Optional[str] = Header(default=None, alias="X-Consent-Token"),
    authorization: Optional[str] = Header(default=None),
) -> dict:
    from hushh_mcp.services.pod_owner_cloud import owner_cloud_agent

    if not owner_cloud_agent():
        raise HTTPException(404, detail="not found")
    # Settle authority before reading content. Explicit byte bound before JSON parsing.
    door = await owner_local_door(x_consent_token, authorization, scope=SCOPE_POD_ACT, held=True)
    await admit_owner_local(**door, scope=SCOPE_POD_ACT)
    raw = bytearray()
    async for chunk in request.stream():
        if len(raw) + len(chunk) > 256 * 1024:
            raise _refused(413, "GMAIL_DRAFT_TOO_LARGE")
        raw.extend(chunk)
    try:
        payload = GmailProposalRequest.model_validate_json(raw)
    except ValidationError:
        raise _refused(422, "GMAIL_DELIVERY_INVALID") from None
    return await run_gmail_proposal(payload, **door)


def _refused(status: int, code: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code})


async def _run(kind: str, owner: str, proposal_id: str, ports: dict[str, Any]) -> Any:
    if kind == "calendar":
        from hushh_mcp.services.pod_google_connections import pod_calendar_service

        calendar = ports.get("calendar") or pod_calendar_service()
        return await calendar.execute(user_id=owner, proposal_id=proposal_id)
    if kind == "gmail_mailbox":
        from hushh_mcp.services.pod_gmail_mailbox import PodGmailMailboxActions

        mailbox = ports.get("mailbox") or PodGmailMailboxActions(owner)
        return await mailbox.execute(user_id=owner, proposal_id=proposal_id)
    from hushh_mcp.services.pod_drive import execute_drive_review

    return await execute_drive_review(
        owner_id=owner, proposal_id=proposal_id, transport=ports.get("drive")
    )


def _explain(exc: Exception) -> HTTPException:
    """One authored status and code per failure. Nothing from a provider rides along."""
    from hushh_mcp.services.external_connector_google_oauth import DriveOAuthError
    from hushh_mcp.services.gmail_receipts_service import GmailApiError
    from hushh_mcp.services.google_connection_service import GoogleConnectionError
    from hushh_mcp.services.google_drive_write_adapter import DriveWriteError
    from hushh_mcp.services.pod_action_proposals import ProposalStoreUnavailable

    if isinstance(exc, ProposalStoreUnavailable):
        return _refused(503, "ACTION_STORE_UNAVAILABLE")
    if isinstance(exc, GoogleConnectionError):
        status = exc.status_code if exc.status_code in {401, 403, 404, 409, 422} else 502
        return _refused(status, "CALENDAR_ACTION_REFUSED" if status != 502 else "PROVIDER_FAILED")
    if isinstance(exc, GmailApiError):
        status = exc.status_code if exc.status_code in {401, 403, 409, 422} else 502
        return _refused(status, str(exc.code or "GMAIL_ACTION_REFUSED"))
    if isinstance(exc, DriveWriteError):
        if exc.outcome_unknown:
            return _refused(502, "DRIVE_OUTCOME_UNKNOWN")
        return _refused(409, "DRIVE_ACTION_REFUSED")
    if isinstance(exc, DriveOAuthError):
        status = exc.status_code if exc.status_code in {401, 403, 409} else 502
        return _refused(status, "DRIVE_ACTION_REFUSED")
    return _refused(502, "ACTION_FAILED")


async def run_action_confirm(
    proposal_id: str,
    *,
    consent_token: str,
    verifier: Any = None,
    session: Optional[dict] = None,
    ports: Optional[dict[str, Any]] = None,
) -> dict:
    """Admit the owner's own session, then claim and run the one prepared change."""
    from hushh_mcp.services.pod_action_proposals import kind_of
    from hushh_mcp.services.pod_owner_cloud import owner_cloud_agent, pod_owner_user_id

    if not owner_cloud_agent():  # before admission: no other pod reveals the door exists
        raise HTTPException(status_code=404, detail="not found")
    claims = await admit_owner_local(
        consent_token, verifier=verifier, session=session, scope=SCOPE_POD_ACT
    )
    owner = str(claims.get("user_id") or "")
    if not owner or owner != pod_owner_user_id():
        raise _refused(403, "OWNER_MISMATCH")
    kind = kind_of(proposal_id) if _PROPOSAL_ID.fullmatch(proposal_id or "") else None
    if kind is None:
        raise _refused(404, "ACTION_UNKNOWN")
    try:
        result = await _run(kind, owner, proposal_id, ports or {})
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001 - every failure becomes one authored answer
        refused = _explain(exc)
        logger.info("pod_actions.refused kind=%s code=%s", kind, refused.detail)
        raise refused from None
    logger.info("pod_actions.confirmed kind=%s", kind)
    return {"proposalId": proposal_id, "kind": kind, "result": result}


@router.post("/actions/{proposal_id}/confirm")
async def pod_action_confirm_route(
    proposal_id: str,
    x_consent_token: Optional[str] = Header(default=None, alias="X-Consent-Token"),
    authorization: Optional[str] = Header(default=None),
) -> dict:
    from hushh_mcp.services.pod_owner_cloud import owner_cloud_agent

    if not owner_cloud_agent():  # before any session check: other pods never reveal the door
        raise HTTPException(status_code=404, detail="not found")
    door = await owner_local_door(x_consent_token, authorization, scope=SCOPE_POD_ACT, held=True)
    return await run_action_confirm(proposal_id, **door)


__all__ = ["SCOPE_POD_ACT", "router", "run_action_confirm"]
