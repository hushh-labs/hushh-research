"""Calendar-only callback completion for existing Google service-grant attempts."""

import logging
from typing import Literal

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
    client_profile: Literal["hussh_ios", "hussh_android"]
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
