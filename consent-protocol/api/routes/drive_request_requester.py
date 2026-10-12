"""Requester-only Drive request endpoints.

GET  /api/connectors/google_drive/sharing/recipient-identity
POST /api/connectors/google_drive/sharing/requests/{request_id}/review-request

Requester-scoped, vault-owner authorized and never cached. They return only the
caller's own data and never owner coverage, fees or provider identifiers.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from typing import Any, cast
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException

from api.middleware import require_firebase_auth_read_only
from api.routes.drive_sharing import (
    NO_STORE,
    Owner,
    PrivateSharingRoute,
    _error,
    _owner,
    _recipient,
    _service,
)
from hushh_mcp.services import drive_request_requester_store as requester_store
from hushh_mcp.services.drive_work_wake import wake_drive_work
from hushh_mcp.services.google_drive_adapter import DriveReadError

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/api/connectors/google_drive/sharing",
    tags=["drive-sharing"],
    route_class=PrivateSharingRoute,
)

# This router's own codes; every other code keeps drive_sharing's mapping.
_REQUESTER_ERRORS = {
    "review_not_available": (409, "There's nothing to review on this request right now."),
    "review_limit_reached": (409, "You've already asked for a review three times."),
    "identity_verification_unavailable": (503, "Couldn't check your Google account. Try again."),
}


def _requester_error(error: Exception) -> HTTPException:
    code = str(error) if isinstance(error, DriveReadError) else ""
    if code not in _REQUESTER_ERRORS:
        return cast(HTTPException, _error(error))
    status, message = _REQUESTER_ERRORS[code]
    return HTTPException(status, {"code": code, "message": message}, headers=NO_STORE)


async def _verified_recipient(
    owner: Owner = Depends(_owner),
    firebase_uid: str = Depends(require_firebase_auth_read_only),
    authorization: str = Header(),
):
    """The same Google identity check as sending a request, with its own 503 code.

    _recipient requires the Firebase uid to match the vault owner and exactly
    one linked google.com provider, so this returns only the caller's own email.
    """
    try:
        return await _recipient(owner=owner, firebase_uid=firebase_uid, authorization=authorization)
    except HTTPException as error:
        detail: dict[str, Any] = error.detail if isinstance(error.detail, dict) else {}
        if error.status_code == 503 and detail.get("code") == "sharing_unavailable":
            raise _requester_error(DriveReadError("identity_verification_unavailable")) from None
        raise


@router.get("/recipient-identity")
async def recipient_identity(recipient=Depends(_verified_recipient)):
    """The Google account a new request's files would be shared with."""
    return {"email": recipient.email, "provider": "google.com"}


async def _requester_call(owner: Owner, action: Callable[[], Awaitable[Any]]) -> Any:
    try:
        await owner.require_current()
        result = await action()
        await owner.require_current()
        return result
    except HTTPException as error:
        error.headers = {**(error.headers or {}), **NO_STORE}
        raise
    except Exception as error:
        raise _requester_error(error) from None


@router.post("/requests/{request_id}/review-request")
async def request_review(request_id: UUID, owner: Owner = Depends(_owner)):
    """Ask the owner to review files that were not shared (at most three times)."""
    result = await _requester_call(
        owner,
        lambda: requester_store.request_review(
            _service().store, user_id=owner.user_id, request_id=str(request_id)
        ),
    )
    try:
        # The owner's push is queued with the ask; this only shortens the wait.
        await wake_drive_work("sharing")
    except Exception as error:  # noqa: BLE001 - the ask already committed.
        logger.warning("drive_review_request.wake_failed %s", type(error).__name__)
    return result
