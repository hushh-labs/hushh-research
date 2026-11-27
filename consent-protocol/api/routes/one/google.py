"""Calendar-only callback completion and signed Confidential Sandbox token bridge."""

import asyncio
import hashlib
import logging
from typing import Any, Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from api.middleware import require_vault_owner_token, verify_user_id_match
from hushh_mcp.services.google_connection_service import (
    GoogleConnectionError,
    get_google_connection_service,
)
from hushh_mcp.services.owner_placement_guard import hub_content_firebase

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/one/google", tags=["One Google"])


class GoogleTransitionPrepare(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    user_id: str = Field(min_length=1, max_length=256)
    client_profile: Literal["hussh_ios", "hussh_android", "hussh_web", "hussh_uat_mail_web"]
    confirmed: bool = False


@router.post("/connect/transition/prepare")
async def prepare_transition(
    payload: GoogleTransitionPrepare, owner: dict = Depends(require_vault_owner_token)
):
    from hushh_mcp.services.google_connector_transition import (  # noqa: PLC0415
        TransitionRefused,
        get_google_connector_transition_service,
    )

    verify_user_id_match(str(owner.get("user_id") or ""), payload.user_id)
    try:
        return await get_google_connector_transition_service().prepare(
            owner=payload.user_id, profile=payload.client_profile, confirmed=payload.confirmed
        )
    except TransitionRefused as error:
        raise HTTPException(status_code=error.status, detail={"code": error.code}) from None
    except Exception:
        raise HTTPException(
            status_code=503, detail={"code": "GOOGLE_TRANSITION_UNAVAILABLE"}
        ) from None


@router.post("/connect/transition/complete")
async def complete_transition(request: Request, authorization: str | None = Header(default=None)):
    from api.routes.one.pod_identity_auth import verify_pod_request  # noqa: PLC0415
    from hushh_mcp.services.google_connector_transition import (  # noqa: PLC0415
        TransitionMutation,
        TransitionRefused,
        get_google_connector_transition_service,
    )

    principal = await verify_pod_request(request, authorization, owner_bound=True)
    if principal is None or not principal.signed or principal.standby:
        raise HTTPException(status_code=403, detail={"code": "GOOGLE_TRANSITION_POD_MISMATCH"})
    try:
        raw = await request.body()
        if len(raw) > 8192:
            raise ValueError
        payload = TransitionMutation.model_validate_json(raw)
    except ValueError:
        raise HTTPException(status_code=422, detail={"code": "GOOGLE_TRANSITION_INVALID"}) from None
    try:
        return await get_google_connector_transition_service().mutate(principal, payload)
    except TransitionRefused as error:
        raise HTTPException(status_code=error.status, detail={"code": error.code}) from None
    except Exception:
        raise HTTPException(
            status_code=503, detail={"code": "GOOGLE_TRANSITION_UNAVAILABLE"}
        ) from None


class GoogleConnectComplete(BaseModel):
    model_config = ConfigDict(extra="forbid")
    user_id: str = Field(min_length=1, max_length=256)
    code: str = Field(min_length=1, max_length=2048)
    state: str = Field(min_length=1, max_length=1024)
    redirect_uri: str | None = Field(default=None, max_length=2048)


@router.post("/connect/complete")
async def complete_connect(
    payload: GoogleConnectComplete, owner: str = Depends(hub_content_firebase)
):
    verify_user_id_match(owner, payload.user_id)
    try:
        return await get_google_connection_service().complete(
            user_id=owner,
            code=payload.code,
            state=payload.state,
            redirect_uri=payload.redirect_uri,
            # The generic Drive route is retired. Bind this compatibility
            # callback to Calendar before a provider code can be exchanged.
            expected_service="calendar",
        )
    except GoogleConnectionError as error:
        raise HTTPException(
            status_code=error.status_code,
            detail={"code": "GOOGLE_CONNECTION_ERROR", "message": str(error)},
        ) from None
    except Exception:
        logger.warning("one.google.completion_unavailable")
        raise HTTPException(
            status_code=503,
            detail={
                "code": "GOOGLE_CONNECTION_UNAVAILABLE",
                "message": "Google connection could not be completed. Please try again.",
            },
        ) from None


class PodGoogleAccessTokenRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, populate_by_name=True)
    action: Literal["grant", "access_token"] = "access_token"
    service: Literal["calendar", "gmail", "drive"]
    level: Literal["read", "manage", "read_calendar_list"] = "read"
    account_id: str = Field(default="default", alias="accountId", max_length=128)
    force_refresh: bool = Field(default=False, alias="forceRefresh")


def _normalize_calendar_scopes(raw_scopes: list[str]) -> list[str]:
    expanded = set(raw_scopes)
    if "https://www.googleapis.com/auth/calendar" in expanded:
        expanded.update(
            {
                "https://www.googleapis.com/auth/calendar.events",
                "https://www.googleapis.com/auth/calendar.freebusy",
                "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
            }
        )
    if "https://www.googleapis.com/auth/calendar.readonly" in expanded:
        expanded.update(
            {
                "https://www.googleapis.com/auth/calendar.events.readonly",
                "https://www.googleapis.com/auth/calendar.freebusy",
                "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
            }
        )
    return sorted(expanded)


@router.post("/pod-access-token")
async def broker_pod_google_access_token(
    request: Request,
    authorization: str | None = Header(default=None),
) -> dict[str, Any]:
    """Mint short-lived Google access tokens strictly for signed `hussh_pods` sandboxes."""
    from api.routes.one.pod_identity_auth import verify_pod_request  # noqa: PLC0415
    from hushh_mcp.services.personal_agent_hosting import get_owner_hosting_mode  # noqa: PLC0415
    from hushh_mcp.services.personal_agent_registry_repo import (  # noqa: PLC0415
        PersonalAgentRegistryRepo,
    )
    from hushh_mcp.services.pod_access_audit import (  # noqa: PLC0415
        resolve_serving_owner_hushh_id,
    )

    principal = await verify_pod_request(request, authorization, owner_bound=True)
    if principal is None or not principal.signed or principal.standby:
        raise HTTPException(status_code=403, detail={"code": "GOOGLE_POD_TOKEN_REFUSED"})

    try:
        raw = await request.body()
        if len(raw) > 4096:
            raise ValueError
        payload = PodGoogleAccessTokenRequest.model_validate_json(raw)
    except ValueError:
        raise HTTPException(status_code=422, detail={"code": "GOOGLE_POD_TOKEN_INVALID"}) from None

    registry = PersonalAgentRegistryRepo()
    try:
        reg_row = await registry.get_by_hushh_id(principal.hushh_id)
        owner_id = str((reg_row or {}).get("user_id") or "").strip()
        serving_id = (
            await resolve_serving_owner_hushh_id(owner_id, registry=registry) if owner_id else ""
        )
        mode = await get_owner_hosting_mode(owner_id) if owner_id else ""
    except Exception:
        raise HTTPException(
            status_code=503, detail={"code": "GOOGLE_POD_AUTHORITY_UNAVAILABLE"}
        ) from None

    if not owner_id or serving_id != principal.hushh_id or mode != "hussh_pods":
        raise HTTPException(status_code=403, detail={"code": "GOOGLE_POD_TOKEN_REFUSED"})

    acct = (payload.account_id or "default").strip() or "default"

    if payload.service == "calendar":
        svc = get_google_connection_service()
        try:
            st = await svc.status(user_id=owner_id, service="calendar", account_id=acct)
        except GoogleConnectionError as exc:
            raise HTTPException(
                status_code=exc.status_code,
                detail={"code": exc.reason_code or "GOOGLE_CONNECTION_ERROR"},
            ) from None
        if not st.get("connected"):
            raw_status = str(st.get("status") or "disconnected")
            if raw_status == "needs_reauth":
                return {
                    "status": "needs_reauth",
                    "connected": False,
                    "credentialId": f"hub-calendar:{acct}:reauth",
                    "generation": 1,
                    "accountSubject": str(st.get("google_email") or owner_id),
                    "accountEmail": str(st.get("google_email") or ""),
                    "grantedScopes": [],
                    "connectedAtMs": 0,
                }
            return {"status": "absent", "connected": False}
        scopes = _normalize_calendar_scopes(
            [s for s in str(st.get("scope_csv") or "").split() if s]
        )
        email = str(st.get("google_email") or "")
        digest = hashlib.sha256(f"{email}|{' '.join(scopes)}".encode()).hexdigest()[:16]
        base = {
            "status": "connected",
            "connected": True,
            "credentialId": f"hub-calendar:{acct}:{digest}",
            "generation": 1,
            "accountSubject": email or owner_id,
            "accountEmail": email,
            "grantedScopes": scopes,
            "connectedAtMs": 1,
        }
        if payload.action == "grant":
            return base
        try:
            if payload.level == "read_calendar_list":
                token = await svc.calendar_list_access_token(user_id=owner_id)
            else:
                token = await svc.access_token(
                    user_id=owner_id,
                    service="calendar",
                    access_level="manage" if payload.level == "manage" else "read",
                    account_id=acct,
                    force_refresh=payload.force_refresh,
                )
        except GoogleConnectionError as exc:
            raise HTTPException(
                status_code=exc.status_code,
                detail={"code": exc.reason_code or "GOOGLE_CONNECTION_ERROR"},
            ) from None
        return {**base, "accessToken": token, "expiresInS": 900}

    if payload.service == "gmail":
        from hushh_mcp.services.gmail_receipts_service import (  # noqa: PLC0415
            GmailApiError,
            get_gmail_receipts_service,
        )

        gsvc = get_gmail_receipts_service()
        grow = await asyncio.to_thread(gsvc._fetch_connection_row, user_id=owner_id)
        if not grow:
            return {"status": "absent", "connected": False}
        gstatus = str(grow.get("status") or "").strip()
        if grow.get("revoked") or gstatus != "connected":
            if gstatus == "needs_reauth":
                return {
                    "status": "needs_reauth",
                    "connected": False,
                    "credentialId": f"hub-gmail:{grow.get('google_sub') or owner_id}",
                    "generation": 1,
                    "accountSubject": str(grow.get("google_sub") or owner_id),
                    "accountEmail": str(grow.get("google_email") or ""),
                    "grantedScopes": [],
                    "connectedAtMs": 0,
                }
            return {"status": "absent", "connected": False}
        scopes_set = {s for s in str(grow.get("scope_csv") or "").split() if s}
        if not scopes_set or "https://www.googleapis.com/auth/gmail.modify" in scopes_set:
            scopes_set.add("https://www.googleapis.com/auth/gmail.readonly")
        scopes = sorted(scopes_set)
        sub = str(grow.get("google_sub") or grow.get("google_email") or owner_id)
        email = str(grow.get("google_email") or "")
        digest = hashlib.sha256(f"{sub}|{' '.join(scopes)}".encode()).hexdigest()[:16]
        base = {
            "status": "connected",
            "connected": True,
            "credentialId": f"hub-gmail:{digest}",
            "generation": 1,
            "accountSubject": sub,
            "accountEmail": email,
            "grantedScopes": scopes,
            "connectedAtMs": 1,
        }
        if payload.action == "grant":
            return base
        if (
            payload.level == "manage"
            and "https://www.googleapis.com/auth/gmail.modify" not in scopes_set
        ):
            raise HTTPException(status_code=403, detail={"code": "SCOPE_NOT_GRANTED"})
        try:
            token, _ = await gsvc._ensure_access_token(
                user_id=owner_id, force_refresh=payload.force_refresh
            )
        except GmailApiError as exc:
            raise HTTPException(
                status_code=exc.status_code, detail={"code": exc.code or "GMAIL_ERROR"}
            ) from None
        return {**base, "accessToken": token, "expiresInS": 900}

    from hushh_mcp.services.external_connector_google_oauth import (  # noqa: PLC0415
        LIVE_SCOPES,
        DriveOAuthError,
    )
    from hushh_mcp.services.external_connector_oauth_service import (  # noqa: PLC0415
        get_external_connector_oauth_service,
    )

    dsvc = get_external_connector_oauth_service().drive()
    try:
        drow, dcred = await dsvc.current_credential(
            user_id=owner_id,
            refresh=(payload.action == "access_token"),
        )
    except DriveOAuthError as derr:
        if str(derr) in {"reconnect_required", "token_expired"}:
            return {"status": "absent", "connected": False}
        raise HTTPException(status_code=derr.status_code, detail={"code": str(derr)}) from None
    raw_scope = str(dcred.get("scope") or " ".join(LIVE_SCOPES))
    scopes_set = {s for s in raw_scope.split() if s.startswith("https://www.googleapis.com/auth/")}
    if not scopes_set:
        scopes_set.add("https://www.googleapis.com/auth/drive.readonly")
    scopes = sorted(scopes_set)
    gen = int(drow.get("connection_generation") or 1)
    sub = str(dcred.get("subject") or drow.get("account_subject") or owner_id)
    email = str(dcred.get("email") or "")
    base = {
        "status": "connected",
        "connected": True,
        "credentialId": f"hub-drive:{gen}",
        "generation": gen,
        "accountSubject": sub,
        "accountEmail": email,
        "grantedScopes": scopes,
        "connectedAtMs": 1,
    }
    if payload.action == "grant":
        return base
    if payload.level == "manage" and "https://www.googleapis.com/auth/drive" not in scopes_set:
        raise HTTPException(status_code=403, detail={"code": "SCOPE_NOT_GRANTED"})
    return {**base, "accessToken": str(dcred.get("accessToken") or ""), "expiresInS": 900}
