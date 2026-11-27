"""Read-only Feed filename search with existing Drive authority and receipts."""

from uuid import UUID

from fastapi import APIRouter, Depends
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field

from api.routes.drive_sharing import PrivateSharingRoute, _call, _person_target
from api.routes.drive_sharing_owner import (
    ContentOwner,
    Owner,
    _content_owner,
    _owner,
    sharing_error,
)
from hushh_mcp.services.drive_sharing_contract import DriveSharingError
from hushh_mcp.services.feed_file_search import FeedFileSearch

router = APIRouter(prefix="/api/one/feed/files", tags=["Feed"], route_class=PrivateSharingRoute)


class FileSearchBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    query: str = Field(default="", max_length=120)
    cursor: str | None = Field(default=None, min_length=1, max_length=4096)
    personRef: UUID | None = None
    fromAt: AwareDatetime | None = None
    beforeAt: AwareDatetime | None = None


class FileOpenBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    requestId: UUID
    fileRef: str = Field(pattern=r"^(bulk|legacy):[0-9a-f-]{36}:[0-9]{1,5}$")


async def _search(body, owner, audience):
    if body.fromAt and body.beforeAt and body.fromAt >= body.beforeAt:
        raise sharing_error(DriveSharingError("invalid_argument"))
    person = await _person_target(owner, body.personRef) if body.personRef else None
    return await _call(
        "search",
        owner=owner,
        factory=FeedFileSearch,
        audience=audience,
        query=body.query,
        cursor=body.cursor,
        person=person,
        from_at=body.fromAt,
        before_at=body.beforeAt,
    )


async def _open(body, owner, audience):
    result = await _call(
        "search",
        owner=owner,
        factory=FeedFileSearch,
        audience=audience,
        exact={"fileRef": body.fileRef, "requestId": str(body.requestId)},
    )
    if len(result["files"]) != 1:
        raise sharing_error(DriveSharingError("request_unavailable"))
    return result["files"][0]


@router.post("/owner/search")
async def search_owner_files(body: FileSearchBody, owner: ContentOwner = Depends(_content_owner)):
    return await _search(body, owner, "owner")


@router.post("/requester/search")
async def search_requester_files(body: FileSearchBody, owner: Owner = Depends(_owner)):
    return await _search(body, owner, "requester")


@router.post("/owner/file")
async def open_owner_file(body: FileOpenBody, owner: ContentOwner = Depends(_content_owner)):
    return await _open(body, owner, "owner")


@router.post("/requester/file")
async def open_requester_file(body: FileOpenBody, owner: Owner = Depends(_owner)):
    return await _open(body, owner, "requester")
