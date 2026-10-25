"""Authenticated summary discovery and explicit vault-owner publication."""

from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Response
from pydantic import Field, StrictBool

from api.middleware import require_firebase_auth
from api.routes.drive_sharing import PrivateSharingRoute, StrictRequest, _call, _error
from api.routes.drive_sharing_owner import Owner, _owner
from hushh_mcp.services.drive_packet_public_summary import DrivePacketPublicSummaryService

router = APIRouter(
    prefix="/api/connectors/google_drive/sharing",
    tags=["drive-sharing"],
    route_class=PrivateSharingRoute,
)
people_router = APIRouter(
    prefix="/api/one/people", tags=["People"], route_class=PrivateSharingRoute
)


class PublicSummaryRequest(StrictRequest):
    enabled: StrictBool
    version: int = Field(ge=0, strict=True)
    expectedRevision: int = Field(ge=0, strict=True)
    disclosure: Literal["drive-packet-public-summary-v1"]


def _service():
    return DrivePacketPublicSummaryService()


@router.get("/packet-publications")
async def packet_publications(
    cursor: UUID | None = Query(default=None), owner: Owner = Depends(_owner)
):
    return await _call(
        "list_publications",
        owner=owner,
        factory=_service,
        cursor=str(cursor) if cursor else None,
    )


@router.put("/packets/{packet_id}/public-summary")
async def set_public_summary(
    packet_id: UUID, body: PublicSummaryRequest, owner: Owner = Depends(_owner)
):
    return await _call(
        "set_public_summary",
        owner=owner,
        factory=_service,
        packet_id=str(packet_id),
        enabled=body.enabled,
        version=body.version,
        expected_revision=body.expectedRevision,
        disclosure=body.disclosure,
    )


@people_router.get("/{person_ref}/financial-packets")
async def public_financial_packets(
    person_ref: UUID,
    response: Response,
    cursor: UUID | None = Query(default=None),
    viewer: str = Depends(require_firebase_auth),
):
    response.headers.update({"Cache-Control": "private, no-store", "Pragma": "no-cache"})
    try:
        return await _service().list_public_summaries(
            viewer_user_id=viewer,
            person_ref=str(person_ref),
            cursor=str(cursor) if cursor else None,
        )
    except Exception as error:
        raise _error(error) from None
