"""Server-readable One copies attached to the original paid Drive request."""

from urllib.parse import quote
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse

from api.routes.drive_sharing import PrivateSharingRoute
from api.routes.drive_sharing_owner import (
    ContentOwner,
    Owner,
    _content_owner,
    _owner,
    sharing_error,
)
from hushh_mcp.services.document_delivery import background_access, background_activity
from hushh_mcp.services.document_delivery.background_service import BackgroundCopyService
from hushh_mcp.services.document_delivery.contracts import DeliveryError
from hushh_mcp.services.drive_sharing_contract import DriveSharingError
from hushh_mcp.services.drive_work_wake import wake_drive_work

router = APIRouter(
    prefix="/api/connectors/google_drive/sharing",
    tags=["document-delivery"],
    route_class=PrivateSharingRoute,
)


def _service():
    return BackgroundCopyService()


async def _call(operation, owner, **kwargs):
    await owner.require_current()
    try:
        result = await operation(_service(), actor=owner.user_id, **kwargs)
    except DeliveryError as error:
        raise HTTPException(status_code=error.status, detail={"code": error.code}) from None
    except DriveSharingError as error:
        raise sharing_error(error) from None
    await owner.require_current()
    return result


@router.get("/requests/{request_id}/one-copy")
async def status(request_id: UUID, owner: Owner = Depends(_owner)):
    return await _call(background_access.status, owner, request_id=str(request_id))


@router.get("/requests/{request_id}/one-copy/files/{file_ref}/content")
async def content(
    request_id: UUID,
    file_ref: UUID,
    disposition: str = Query(default="download", pattern="^(preview|download)$"),
    owner: ContentOwner = Depends(_content_owner),
):
    service = _service()

    async def authority(svc, **kwargs):
        return await background_access.content(service, **kwargs)

    row, source, result = await _call(
        authority,
        owner,
        request_id=str(request_id),
        file_ref=str(file_ref),
        disposition=disposition,
    )

    async def body():
        async for chunk in service.stream(row=row, actor=owner.user_id):
            await owner.require_current()
            yield chunk

    # Untrusted types are downloads, never active content in the application origin.
    mime = "application/pdf" if disposition == "preview" else "application/octet-stream"
    name = quote(source["name"], safe="")
    return StreamingResponse(
        body(),
        media_type=mime,
        headers={
            "Content-Disposition": f"{'inline' if disposition == 'preview' else 'attachment'}; filename*=UTF-8''{name}",
            "Content-Length": str(result["bytes"]),
            "Cache-Control": "private, no-store, no-transform",
            "Pragma": "no-cache",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "sandbox; default-src 'none'",
            "X-One-Content-SHA256": result["sha256"],
        },
    )


@router.post("/requests/{request_id}/one-copy/revoke")
async def revoke(request_id: UUID, owner: Owner = Depends(_owner)):
    result = await _call(background_access.revoke, owner, request_id=str(request_id))
    await wake_drive_work("sharing")
    return result


@router.get("/requests/{request_id}/one-copy/activity")
async def activity(
    request_id: UUID,
    cursor: str | None = Query(default=None, max_length=2048),
    limit: int = Query(default=25, ge=1, le=50),
    owner: Owner = Depends(_owner),
):
    return await _call(
        background_activity.history, owner, request_id=str(request_id), cursor=cursor, limit=limit
    )
