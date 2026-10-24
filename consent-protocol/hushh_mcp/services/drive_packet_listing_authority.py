"""Current authority for exact packet listings; mutation remains in the existing store."""

from hushh_mcp.services.google_drive_adapter import DriveReadError


def require_listing(store, connection, row, user_id, decision, price_cents):
    from hushh_mcp.services.drive_packet_intelligence import facts_policy_version

    provider_packet = bool(row and row.get("packet_kind") == "provider_discovery")
    if decision == "allow" and provider_packet:
        from hushh_mcp.services.drive_period_packet_reader import require_period_purchase
        from hushh_mcp.services.drive_period_packet_store import DrivePeriodPacketStore

        require_period_purchase()
        if price_cents != 500:
            raise DriveReadError("invalid_argument")
        DrivePeriodPacketStore(db=store.db).period_manifest_locked(
            connection,
            owner_user_id=user_id,
            packet_id=str(row["packet_id"]),
            version=row["version"],
        )
    elif decision == "allow":
        store._access(connection, viewer=user_id, owner=user_id)
    if (
        not row
        or decision == "allow"
        and (
            row["current_version"] != row["version"]
            or not 0 < row["document_count"] <= 120
            or not provider_packet
            and not store._available(connection, row, facts_policy_version())
        )
    ):
        raise DriveReadError("packet_unavailable")
