"""Own-account packet discovery, independent of packet commerce."""

from uuid import UUID

from fastapi import APIRouter, Depends, Query
from pydantic import StrictBool

from api.routes.drive_sharing import PrivateSharingRoute, StrictRequest, _call
from api.routes.drive_sharing_owner import ContentOwner as Owner
from api.routes.drive_sharing_owner import _content_owner as _owner

router = APIRouter(
    prefix="/api/connectors/google_drive/sharing",
    tags=["drive-sharing"],
    route_class=PrivateSharingRoute,
)


class PacketPreviewRequest(StrictRequest):
    refresh: StrictBool = False


def _period_packet_service():
    from hushh_mcp.services.drive_period_packet_service import DrivePeriodPacketService

    return DrivePeriodPacketService()


@router.get("/packets/{packet_id}/preview")
async def packet_preview(
    packet_id: UUID,
    cursor: str | None = Query(default=None, min_length=1, max_length=2048),
    owner: Owner = Depends(_owner),
):
    return await _call(
        "preview",
        owner=owner,
        factory=_period_packet_service,
        packet_id=str(packet_id),
        cursor=cursor,
    )


@router.post("/packets/{packet_id}/preview")
async def prepare_packet_preview(
    packet_id: UUID, body: PacketPreviewRequest, owner: Owner = Depends(_owner)
):
    return await _call(
        "prepare_preview",
        owner=owner,
        factory=_period_packet_service,
        packet_id=str(packet_id),
        refresh=body.refresh,
    )
