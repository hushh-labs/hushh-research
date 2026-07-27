# consent-protocol/api/routes/pwm.py
"""
Personal World Model (PWM) API routes.

The server-side home of the person's own preference document behind
``/api/pwm`` — the cross-device "your private agent already knows you" loop for
the PCHP RFC-002 Preference Subscription Fabric. This replaces the frontend's
interim Stripe-metadata store; the client contract is unchanged.

Contract
--------
    GET    /api/pwm  -> the caller's stored doc as JSON, or 404 if none.
    PUT    /api/pwm  -> merge a partial doc into the caller's doc
                        (section-level last-writer-wins by ``updatedAt``);
                        an empty body ({} or no body) wipes it.
    DELETE /api/pwm  -> wipe the caller's doc.

Security
--------
    - Auth required; the uid is taken ONLY from the verified Firebase token,
      never from the body (any uid/user_id field in the body is dropped).
    - Storage is keyed by uid; a document is returned only to its owner and is
      fully wipeable. Consent-first: this is the person's own data.
"""

import logging
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, status

from api.middleware import require_firebase_auth
from hushh_mcp.services.pwm_service import (
    PWM_MAX_TOP_LEVEL_KEYS,
    PwmDocumentTooLargeError,
    get_pwm_service,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/pwm", tags=["pwm"])

# Identity is asserted by the verified token alone; a body must never carry it.
_RESERVED_BODY_KEYS = {"uid", "user_id", "userId"}


def _sanitize_partial(body: Any) -> dict[str, Any]:
    """Validate the PUT body and strip any identity-asserting keys."""
    if not isinstance(body, dict):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "PWM_BODY_INVALID", "message": "Body must be a JSON object."},
        )
    if len(body) > PWM_MAX_TOP_LEVEL_KEYS:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail={
                "code": "PWM_BODY_TOO_LARGE",
                "message": f"Body exceeds {PWM_MAX_TOP_LEVEL_KEYS} top-level keys.",
            },
        )
    return {key: value for key, value in body.items() if key not in _RESERVED_BODY_KEYS}


@router.get("")
async def get_pwm_document(
    firebase_uid: str = Depends(require_firebase_auth),
) -> dict[str, Any]:
    doc: dict[str, Any] | None = await get_pwm_service().get_document(firebase_uid)
    if doc is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "PWM_NOT_FOUND", "message": "No world model for this user."},
        )
    return doc


@router.put("")
async def put_pwm_document(
    body: dict[str, Any] | None = Body(default=None),
    firebase_uid: str = Depends(require_firebase_auth),
) -> dict[str, Any]:
    partial = _sanitize_partial(body if body is not None else {})
    service = get_pwm_service()
    # An empty PUT clears the document (part of the contract).
    if not partial:
        await service.delete_document(firebase_uid)
        return {}
    try:
        merged: dict[str, Any] = await service.merge_document(firebase_uid, partial)
        return merged
    except PwmDocumentTooLargeError as exc:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail={"code": "PWM_DOC_TOO_LARGE", "message": str(exc)},
        ) from exc


@router.delete("")
async def delete_pwm_document(
    firebase_uid: str = Depends(require_firebase_auth),
) -> dict[str, Any]:
    existed = await get_pwm_service().delete_document(firebase_uid)
    return {"deleted": True, "existed": existed}
