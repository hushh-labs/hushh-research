"""Owner-only list of the files One shared for one request, and per-file removal.

GET  /api/connectors/google_drive/sharing/requests/{request_id}/shared-files
POST /api/connectors/google_drive/sharing/requests/{request_id}/shared-files/remove
POST /api/connectors/google_drive/sharing/requests/{request_id}/shared-files/restore

Vault-owner authorized and never cached. Only the request's owner gets an
answer; the requester and anyone else get request_unavailable. Remove queues a
durable removal that the scheduled Drive drain carries out after a short undo
window, so no Drive call and no wake runs in the API process and the operator
kill switch stays authoritative. Restore cancels a removal no worker claimed.
"""

from __future__ import annotations

import re
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from pydantic import Field

from api.routes.drive_sharing import (
    Owner,
    PrivateSharingRoute,
    StrictRequest,
    _call,
    _content_owner,
    _service,
)
from hushh_mcp.services.drive_owner_shared_files import DriveOwnerSharedFilesStore

router = APIRouter(
    prefix="/api/connectors/google_drive/sharing",
    tags=["drive-sharing"],
    route_class=PrivateSharingRoute,
)

_FILE_REF_PATTERN = r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:\d{1,5}$"


class SharedFileAction(StrictRequest):
    fileRef: str = Field(pattern=_FILE_REF_PATTERN, max_length=48)


class _SharedFilesFacade:
    """Adapts the store to drive_sharing._call's owner-authority wrapper."""

    def __init__(self) -> None:
        self.store = DriveOwnerSharedFilesStore(db=_service().store.db)
        self.require_owner = None

    async def shared_files(self, **kwargs: Any) -> Any:
        return await self.store.shared_files(**kwargs)

    async def remove_file(self, **kwargs: Any) -> Any:
        return await self.store.remove_file(**kwargs)

    async def restore_file(self, **kwargs: Any) -> Any:
        return await self.store.restore_file(**kwargs)


def _facade() -> _SharedFilesFacade:
    return _SharedFilesFacade()


@router.get("/requests/{request_id}/shared-files")
async def shared_files(
    request_id: UUID,
    cursor: str | None = Query(default=None, max_length=48),
    owner: Owner = Depends(_content_owner),
):
    if cursor is not None and not re.fullmatch(_FILE_REF_PATTERN, cursor):
        cursor = "invalid"  # The store rejects it as invalid_argument.
    return await _call(
        "shared_files", owner=owner, factory=_facade, request_id=str(request_id), cursor=cursor
    )


@router.post("/requests/{request_id}/shared-files/remove", status_code=202)
async def remove_shared_file(
    request_id: UUID, body: SharedFileAction, owner: Owner = Depends(_content_owner)
):
    return await _call(
        "remove_file",
        owner=owner,
        factory=_facade,
        request_id=str(request_id),
        file_ref=body.fileRef,
    )


@router.post("/requests/{request_id}/shared-files/restore")
async def restore_shared_file(
    request_id: UUID, body: SharedFileAction, owner: Owner = Depends(_content_owner)
):
    return await _call(
        "restore_file",
        owner=owner,
        factory=_facade,
        request_id=str(request_id),
        file_ref=body.fileRef,
    )
