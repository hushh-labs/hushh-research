"""Packet selection and pricing are bound atomically before request workers wake."""

# ruff: noqa: F401,F811 -- shared isolated PostgreSQL fixtures
import asyncio
import json
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from fastapi import HTTPException
from sqlalchemy import text

from hushh_mcp.runtime_settings import clear_runtime_settings_caches
from hushh_mcp.services import owner_placement_guard
from hushh_mcp.services.drive_packet_catalog_service import DrivePacketCatalogService
from hushh_mcp.services.drive_sharing_contract import (
    DriveSharingError,
    ShareRequestPurpose,
    VerifiedGoogleRecipient,
)
from hushh_mcp.services.drive_sharing_service import DriveSharingService
from hushh_mcp.services.google_drive_adapter import DriveReadError
from tests.services.test_drive_reusable_packets_postgres import (
    LISTING_DISCLOSURE,
    MIGRATIONS,
    collection,
    collection_pages,
    connector_postgres_url,
    documents,
    drive,
    drive_connect,
    ingestion,
    lifecycle,
    ready_packet,
    reusable,
    sharing,
)


@pytest.mark.parametrize(
    "mode,code",
    [("byoc", "AGENT_PRIVATE_RUNTIME_REQUIRED"), ("unknown", "AGENT_HOSTING_UNAVAILABLE")],
)
async def test_private_packet_catalog_refuses_owner_plaintext_before_store_read(
    monkeypatch, mode, code
):
    monkeypatch.setattr(owner_placement_guard, "pod_mode", lambda: False)
    monkeypatch.setattr(
        owner_placement_guard, "get_owner_hosting_mode", AsyncMock(return_value=mode)
    )
    packets = SimpleNamespace(list_packets=AsyncMock(return_value={"packets": []}))
    service = DrivePacketCatalogService(
        sharing=SimpleNamespace(), packets=packets, require_owner=AsyncMock()
    )
    with pytest.raises(HTTPException) as failure:
        await service.list_packets(user_id="private-owner")
    assert failure.value.detail["code"] == code
    packets.list_packets.assert_not_awaited()
    # Cross-owner listing authority remains in the existing relationship/listing store.
    assert await service.list_packets(user_id="buyer", owner_user_id="private-owner") == {
        "packets": []
    }
    packets.list_packets.assert_awaited_once_with(
        user_id="buyer", owner_user_id="private-owner", cursor=None, owner_contents=True
    )


@pytest.fixture
async def catalog(reusable, sharing, monkeypatch):
    monkeypatch.setenv("DRIVE_AGENT_PACKAGES_ENABLED", "true")
    monkeypatch.setenv("DRIVE_REQUEST_PAYMENTS_ENABLED", "false")
    clear_runtime_settings_caches()
    monkeypatch.setattr(
        "hushh_mcp.services.drive_packet_catalog_service.wake_drive_work_stages", AsyncMock()
    )
    with sharing.db.engine.begin() as connection:
        connection.execute(text((MIGRATIONS / "329_drive_request_cent_prices.sql").read_text()))
    packet = await ready_packet(reusable)
    await reusable.packets.set_listing(
        user_id="owner",
        packet_id=packet["packetId"],
        version=1,
        decision="allow",
        price_cents=125,
        expected_revision=0,
        disclosure=LISTING_DISCLOSURE,
    )
    service = DrivePacketCatalogService(
        sharing=DriveSharingService(store=sharing),
        packets=reusable.packets,
        require_owner=AsyncMock(),
    )
    return service, packet


def recipient():
    return VerifiedGoogleRecipient("recipient", "1234567", "b@example.invalid", datetime.now(UTC))


async def test_catalog_shows_the_owner_their_files_and_a_buyer_none(catalog):
    service, _ = catalog
    owner = (await service.list_packets(user_id="owner"))["packets"][0]
    assert [item["name"] for item in owner["contents"]["documents"]] == [
        "Private synthetic filename"
    ]
    buyer = await service.list_packets(user_id="recipient", owner_user_id="owner")
    assert buyer["packets"] and all("contents" not in item for item in buyer["packets"])
    assert "Private synthetic filename" not in json.dumps(buyer)


async def test_repeated_packet_requests_reuse_one_bound_request(catalog, sharing):
    service, packet = catalog
    results = await asyncio.gather(
        *[
            service.request_packet(
                user_id="recipient",
                recipient=recipient(),
                packet_id=packet["packetId"],
                version=1,
                client_request_id=str(uuid4()),
            )
            for _ in range(3)
        ]
    )
    assert len({row["requestId"] for row in results}) == 1
    assert all(row["existingAccess"] is False for row in results)
    with sharing.db.engine.connect() as connection:
        row = connection.execute(text("SELECT * FROM drive_share_requests")).mappings().one()
        private = sharing._open_request(row)
        assert row["status"] == "pending" and row["agent_package_required"]
        assert row["owner_allowed_at"] is None
        assert str(row["reusable_packet_id"]) == packet["packetId"]
        assert private["reusable_packet"]["version"] == 1
        assert private["reusable_packet"]["priceCents"] == 125
        assert (
            connection.execute(
                text("SELECT count(*) FROM drive_request_payment_orders")
            ).scalar_one()
            == 0
        )
    context = await sharing.request_bulk_context(
        user_id="owner", request_id=results[0]["requestId"]
    )
    assert context["reusablePacket"]["packetId"] == packet["packetId"]


async def test_listing_changed_between_read_and_create_cannot_bind_old_price(
    catalog, reusable, sharing
):
    _, packet = catalog
    manifest = await reusable.packets.current_packet_manifest(
        owner_user_id="owner", packet_id=packet["packetId"], version=1, viewer_user_id="recipient"
    )
    reference = {
        "packetId": packet["packetId"],
        "version": 1,
        "manifestDigest": manifest["digest"],
        "listingRevision": manifest["listing_revision"],
        "priceCents": 125,
        "ownerUserId": "owner",
    }
    await reusable.packets.set_listing(
        user_id="owner",
        packet_id=packet["packetId"],
        version=1,
        decision="allow",
        price_cents=250,
        expected_revision=1,
        disclosure=LISTING_DISCLOSURE,
    )
    with pytest.raises(DriveReadError, match="packet_changed"):
        await sharing.create_request(
            recipient=recipient(),
            owner_user_id="owner",
            client_request_id=str(uuid4()),
            purpose=ShareRequestPurpose(purpose="Synthetic statements"),
            reusable_packet=reference,
        )
    with sharing.db.engine.connect() as connection:
        assert (
            connection.execute(text("SELECT count(*) FROM drive_share_requests")).scalar_one() == 0
        )
