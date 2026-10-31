"""Participant-gated encrypted copies; legacy Drive wire remains unchanged."""

import asyncio
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from fastapi.responses import JSONResponse, Response
from pydantic import Field

from api.middleware import require_firebase_auth_read_only
from api.routes.drive_sharing import (
    CreateRequest,
    PrivateSharingRoute,
    _error,
    _owner_target,
    _recipient,
)
from api.routes.drive_sharing_owner import ContentOwner, Owner, _content_owner, _owner
from hushh_mcp.services.document_delivery.contracts import (
    Activity,
    Approval,
    Challenge,
    DeliveryError,
    Package,
    RecoveryAmendment,
    Revoke,
    StrictWire,
    Upload,
)
from hushh_mcp.services.document_delivery.service import DocumentDeliveryService
from hushh_mcp.services.drive_telemetry import drive_logger, drive_stage
from hushh_mcp.services.external_connector_google_oauth import DriveOAuthError
from hushh_mcp.services.google_drive_adapter import DriveReadError

_logger = drive_logger(__name__)
_TRANSITIONS = {
    "approve": "document_preparation",
    "stage_package": "document_staging",
    "upload": "document_upload",
    "finalize": "document_upload",
    "challenge": "document_key_proof",
    "release": "document_release",
    "artifact": "document_release",
    "revoke": "document_revoke",
    "recovery_amendment": "document_key_proof",
}


class BoundedDeliveryRoute(PrivateSharingRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def bounded(request):
            if request.method == "POST":
                chunks, length = [], 0
                try:
                    async with asyncio.timeout(45):
                        async for chunk in request.stream():
                            length += len(chunk)
                            if length > 262144:
                                return JSONResponse(
                                    {"detail": {"code": "delivery_body_limit"}},
                                    status_code=413,
                                    headers={
                                        "Cache-Control": "private, no-store",
                                        "Pragma": "no-cache",
                                    },
                                )
                            chunks.append(chunk)
                except TimeoutError:
                    return JSONResponse(
                        {"detail": {"code": "delivery_body_timeout"}},
                        status_code=408,
                        headers={"Cache-Control": "private, no-store", "Pragma": "no-cache"},
                    )
                request._body = b"".join(chunks)
            response = await handler(request)
            if response.headers.get("content-type", "").split(";")[0] == "application/octet-stream":
                response.headers["Cache-Control"] = "private, no-store, no-transform"
            return response

        return bounded


router = APIRouter(
    prefix="/api/connectors/google_drive/sharing",
    tags=["document-delivery"],
    route_class=BoundedDeliveryRoute,
)


class CreateDelivery(CreateRequest):
    version: Literal[1]
    receiveThrough: Literal["one", "both"]
    activityDisclosureVersion: Literal["one-document-activity-v1"]
    activityAccepted: Literal[True]
    recipientKeyId: str = Field(pattern=r"^[A-Za-z0-9._:-]{3,120}$")
    recipientKeyFingerprint: str = Field(pattern=r"^[0-9a-f]{64}$")
    accessDays: int = Field(default=30, ge=1, le=90, strict=True)


class SourceSession(StrictWire):
    expectedRevision: int = Field(ge=1)


def _service():
    return DocumentDeliveryService()


async def _call(method, *, owner, **kwargs):
    await owner.require_current()
    try:
        service = _service()
        target = getattr(service, method, None) or getattr(service.store, method)
        stage = _TRANSITIONS.get(method)
        if stage:
            from opentelemetry import trace

            trace.get_current_span().set_attributes(
                {"hushh.feature": "protected_document_delivery", "hushh.document.stage": stage}
            )
            with drive_stage(_logger, stage):
                result = await target(actor=owner.user_id, **kwargs)
        else:
            result = await target(actor=owner.user_id, **kwargs)
        await owner.require_current()
        return result
    except DeliveryError as error:
        raise HTTPException(
            error.status,
            {"code": error.code, "message": "The document delivery could not be completed."},
        ) from None
    except (DriveReadError, DriveOAuthError) as error:
        raise _error(error) from None


@router.get("/delivery-readiness")
async def readiness(owner: Owner = Depends(_owner)):
    return await _call("readiness", owner=owner)


@router.post("/delivery-requests", status_code=202)
async def create(
    body: CreateDelivery,
    owner: Owner = Depends(_owner),
    firebase_uid: str = Depends(require_firebase_auth_read_only),
    authorization: str = Header(),
):
    await owner.require_current()
    if firebase_uid != owner.user_id:
        raise HTTPException(403, {"code": "identity_mismatch"})
    target = await _owner_target(owner, body)
    google_recipient = (
        await _recipient(owner, firebase_uid, authorization)
        if body.receiveThrough == "both"
        else None
    )
    # The existing RIA route is the authority for verified RIA roles. This
    # narrow first-copy facade does not silently grant a caller-asserted role.
    if body.requesterActorType != "person":
        raise HTTPException(409, {"code": "delivery_actor_not_supported"})
    try:
        with drive_stage(_logger, "document_request"):
            return await _service().create(
                requester=owner.user_id,
                owner=target,
                body=body.model_dump(mode="json"),
                google_recipient=google_recipient,
            )
    except DeliveryError as error:
        raise HTTPException(error.status, {"code": error.code}) from None
    except (DriveReadError, DriveOAuthError) as error:
        raise _error(error) from None


@router.get("/requests/{request_id}/delivery/terms")
async def terms(request_id: UUID, owner: Owner = Depends(_owner)):
    return await _call("projection", owner=owner, request_id=str(request_id))


@router.get("/requests/{request_id}/delivery/source-selection")
async def source_selection(request_id: UUID, owner: ContentOwner = Depends(_content_owner)):
    return await _call("source_selection", owner=owner, request_id=str(request_id))


@router.post("/requests/{request_id}/delivery/approve")
async def approve(request_id: UUID, body: Approval, owner: ContentOwner = Depends(_content_owner)):
    return await _call("approve", owner=owner, request_id=str(request_id), body=body)


@router.post("/requests/{request_id}/delivery/source-session")
async def source_session(
    request_id: UUID, body: SourceSession, owner: ContentOwner = Depends(_content_owner)
):
    return await _call(
        "source_session",
        owner=owner,
        request_id=str(request_id),
        expected_revision=body.expectedRevision,
    )


@router.get("/requests/{request_id}/delivery/recipient-key")
async def recipient_key(
    request_id: UUID,
    purpose: Literal["delivery", "recovery"] = "delivery",
    owner: Owner = Depends(_owner),
):
    return await _call("recipient_key", owner=owner, request_id=str(request_id), purpose=purpose)


@router.get("/requests/{request_id}/delivery/owner-package")
async def owner_package(request_id: UUID, owner: Owner = Depends(_owner)):
    return await _call("owner_package", owner=owner, request_id=str(request_id))


@router.post("/requests/{request_id}/delivery/recovery-amendment")
async def recovery_amendment(
    request_id: UUID, body: RecoveryAmendment, owner: Owner = Depends(_owner)
):
    return await _call("recovery_amendment", owner=owner, request_id=str(request_id), body=body)


@router.post("/requests/{request_id}/delivery/key-challenge")
async def challenge(request_id: UUID, body: Challenge, owner: Owner = Depends(_owner)):
    return await _call("challenge", owner=owner, request_id=str(request_id), body=body)


@router.post("/requests/{request_id}/delivery/uploads")
async def reserve_upload(
    request_id: UUID, body: Upload, owner: ContentOwner = Depends(_content_owner)
):
    return await _call("reserve_upload", owner=owner, request_id=str(request_id), body=body)


@router.put("/requests/{request_id}/delivery/uploads/{upload_id}")
async def upload(
    request_id: UUID,
    upload_id: UUID,
    request: Request,
    owner: ContentOwner = Depends(_content_owner),
):
    if request.headers.get("content-type", "").split(";")[0] != "application/octet-stream":
        raise HTTPException(415, {"code": "ciphertext_content_type_required"})
    chunks, length = [], 0
    async for chunk in request.stream():
        length += len(chunk)
        if length > 4_325_376:
            raise HTTPException(413, {"code": "artifact_size_limit"})
        chunks.append(chunk)
    return await _call(
        "upload",
        owner=owner,
        request_id=str(request_id),
        upload_id=str(upload_id),
        ciphertext=b"".join(chunks),
    )


@router.post("/requests/{request_id}/delivery/uploads/{upload_id}/finalize")
async def finalize(
    request_id: UUID, upload_id: UUID, owner: ContentOwner = Depends(_content_owner)
):
    return await _call(
        "finalize", owner=owner, request_id=str(request_id), upload_id=str(upload_id)
    )


@router.post("/requests/{request_id}/delivery/package")
async def stage(request_id: UUID, body: Package, owner: ContentOwner = Depends(_content_owner)):
    return await _call("stage_package", owner=owner, request_id=str(request_id), body=body)


@router.get("/requests/{request_id}/delivery/package")
async def package(request_id: UUID, owner: Owner = Depends(_owner)):
    return await _call("release", owner=owner, request_id=str(request_id))


@router.get("/requests/{request_id}/delivery/artifacts/{artifact_id}")
async def artifact(request_id: UUID, artifact_id: UUID, owner: Owner = Depends(_owner)):
    ciphertext = await _call(
        "artifact", owner=owner, request_id=str(request_id), artifact_id=str(artifact_id)
    )
    return Response(
        ciphertext,
        media_type="application/octet-stream",
        headers={
            "Cache-Control": "private, no-store, no-transform",
            "X-Content-Type-Options": "nosniff",
            "Content-Disposition": "attachment; filename=encrypted-document.bin",
        },
    )


@router.post("/requests/{request_id}/delivery/activity")
async def activity(request_id: UUID, body: Activity, owner: Owner = Depends(_owner)):
    return await _call("record_activity", owner=owner, request_id=str(request_id), body=body)


@router.get("/requests/{request_id}/delivery/activity")
async def activities(
    request_id: UUID, cursor: int = Query(default=0, ge=0), owner: Owner = Depends(_owner)
):
    return await _call("activities", owner=owner, request_id=str(request_id), cursor=cursor)


@router.post("/requests/{request_id}/delivery/revoke")
async def revoke(request_id: UUID, body: Revoke, owner: Owner = Depends(_owner)):
    return await _call("revoke", owner=owner, request_id=str(request_id), body=body)
