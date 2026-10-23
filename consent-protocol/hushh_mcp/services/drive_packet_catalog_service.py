"""Authorized packet listings feed the existing exact-file purchase workflow."""

from hushh_mcp.services.drive_packet_store import DrivePacketStore
from hushh_mcp.services.drive_sharing_contract import DriveSharingError, ShareRequestPurpose
from hushh_mcp.services.drive_sharing_service import DriveSharingService
from hushh_mcp.services.drive_work_wake import wake_drive_work_stages
from hushh_mcp.services.owner_placement_guard import admit_hub_content


class DrivePacketCatalogService:
    def __init__(self, *, sharing=None, packets=None, require_owner=None):
        self.sharing = sharing or DriveSharingService()
        self.packets = packets or DrivePacketStore(db=self.sharing.store.db)
        self.require_owner = require_owner

    async def _current(self):
        if self.require_owner is None:
            raise DriveSharingError("owner_authority_required")
        await self.require_owner()

    async def list_packets(self, *, user_id, owner_user_id=None, cursor=None):
        await self._current()
        own_information = owner_user_id is None or owner_user_id == user_id
        if own_information:
            await admit_hub_content(user_id, "drive_packet_catalog")
        # The owner's own list says what is inside each packet; the store
        # withholds it from every other viewer.
        result = await self.packets.list_packets(
            user_id=user_id, owner_user_id=owner_user_id, cursor=cursor, owner_contents=True
        )
        await self._current()
        if own_information:
            await admit_hub_content(user_id, "drive_packet_catalog")
        from os import getenv

        from hushh_mcp.services.connector_feature_admission import connector_feature_enabled

        if (
            connector_feature_enabled("drive_period_packets", owner_user_id or user_id)
            and getenv("DRIVE_AGENT_PACKAGES_ENABLED", "").strip().lower() != "true"
        ):
            result["packets"] = [
                item for item in result["packets"] if item.get("kind") == "provider_discovery"
            ]
        return result

    async def require_period_packet(self, *, user_id, packet_id, version):
        from hushh_mcp.services.google_drive_adapter import DriveReadError

        await self._current()
        owner = await self.packets.packet_owner_for_viewer(
            user_id=user_id, packet_id=packet_id, version=version
        )
        manifest = await self.packets.current_packet_manifest(
            owner_user_id=owner, packet_id=packet_id, version=version, viewer_user_id=user_id
        )
        if manifest.get("kind") != "provider_discovery":
            raise DriveReadError("packet_unavailable")
        from hushh_mcp.services.drive_period_packet_reader import require_period_purchase

        require_period_purchase()
        await self._current()
        return manifest

    async def set_listing(self, **kwargs):
        await self._current()
        result = await self.packets.set_listing(**kwargs)
        await self._current()
        return result

    async def request_packet(self, *, user_id, recipient, packet_id, version, client_request_id):
        await self._current()
        if recipient.user_id != user_id:
            raise DriveSharingError("request_unavailable")
        owner_user_id = await self.packets.packet_owner_for_viewer(
            user_id=user_id, packet_id=packet_id, version=version
        )
        manifest = await self.packets.current_packet_manifest(
            owner_user_id=owner_user_id,
            packet_id=packet_id,
            version=version,
            viewer_user_id=user_id,
        )
        if manifest.get("kind") == "provider_discovery":
            from hushh_mcp.services.drive_period_packet_reader import require_period_purchase

            require_period_purchase()
        # Derive only from the verified server version. The transaction rechecks
        # its digest, listing revision and price before sealing the request.
        assessment = manifest["assessment"]
        periods = assessment["periods"]
        purpose = ShareRequestPurpose(
            purpose=f"{assessment['title']}: {assessment['coverage_summary']}",
            periodStart=min((period["start"] for period in periods), default=None),
            periodEnd=max((period["end"] for period in periods), default=None),
        )
        reference = {
            "packetId": str(packet_id),
            "version": version,
            "manifestDigest": manifest["digest"],
            "listingRevision": manifest["listing_revision"],
            "priceCents": manifest["price_cents"],
            "ownerUserId": owner_user_id,
        }
        await self._current()
        result = await self.sharing.store.create_request(
            recipient=recipient,
            owner_user_id=owner_user_id,
            client_request_id=client_request_id,
            purpose=purpose,
            reusable_packet=reference,
        )
        await self._current()
        await wake_drive_work_stages("suggestions", "sharing")
        return {
            "requestId": result["requestId"],
            "existingAccess": result.get("existingAccess", result.get("status") == "completed"),
        }
