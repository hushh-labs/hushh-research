"""Compose period catalog projections with the unchanged legacy packet page."""

from hushh_mcp.services.google_drive_adapter import DriveReadError


async def catalog_packets(
    store, *, user_id, owner_user_id=None, cursor=None, limit=25, owner_contents=False
):
    from hushh_mcp.services.connector_feature_admission import connector_feature_enabled
    from hushh_mcp.services.drive_packet_store import DrivePacketStore

    if not isinstance(store, DrivePacketStore):
        return await store.list_packets(
            user_id=user_id,
            owner_user_id=owner_user_id,
            cursor=cursor,
            owner_contents=owner_contents,
        )

    if not connector_feature_enabled("drive_period_packets", owner_user_id or user_id):
        return await DrivePacketStore.list_packets(
            store,
            user_id=user_id,
            owner_user_id=owner_user_id,
            cursor=cursor,
            limit=limit,
            owner_contents=owner_contents,
        )
    from hushh_mcp.services.drive_period_packet_reader import list_packets
    from hushh_mcp.services.drive_period_packet_store import DrivePeriodPacketStore

    period_store = DrivePeriodPacketStore(db=store.db)
    if owner_user_id is None or owner_user_id == user_id:
        try:
            await period_store.ensure_owner(user_id=user_id)
        except DriveReadError as error:
            if str(error) != "background_preparation_required":
                raise
    try:
        periods = await list_packets(
            period_store,
            user_id=user_id,
            owner_user_id=owner_user_id,
            cursor=cursor,
            limit=limit,
            owner_contents=owner_contents,
        )
    except DriveReadError as error:
        if str(error) != "background_preparation_required":
            raise
        periods = []
    try:
        legacy = await DrivePacketStore.list_packets(
            store,
            user_id=user_id,
            owner_user_id=owner_user_id,
            cursor=cursor,
            limit=limit,
            owner_contents=owner_contents,
        )
    except DriveReadError as error:
        if str(error) != "collection_processing_required":
            raise
        legacy = {"packets": [], "nextCursor": None}
    count = max(1, min(100, limit))
    combined = sorted([*periods, *legacy["packets"]], key=lambda item: item["packetId"])
    result = combined[:count]
    return {
        "packets": result,
        "nextCursor": result[-1]["packetId"]
        if len(combined) > count or legacy["nextCursor"]
        else None,
    }
