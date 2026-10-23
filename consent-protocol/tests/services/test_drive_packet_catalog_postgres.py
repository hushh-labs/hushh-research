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
from tests.services.test_drive_request_bulk_postgres import request_bulk
from tests.services.test_drive_reusable_packets_postgres import (
    LISTING_DISCLOSURE,
    MIGRATIONS,
    collection,
    collection_pages,
    connector_postgres_url,
    documents,
    drive,
    drive_connect,
    frozen_provider_period,
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


async def test_provider_packet_real_catalog_search_finalizer_and_owner_allow(
    reusable, sharing, request_bulk, monkeypatch
):
    from hushh_mcp.services.drive_owner_search_service import DriveOwnerSearchService
    from hushh_mcp.services.drive_owner_search_store import DriveOwnerSearchStore
    from hushh_mcp.services.drive_request_bulk_service import DriveRequestBulkService
    from hushh_mcp.services.drive_request_package_store import DriveRequestPackageStore

    period, head, _, manifest, file = await frozen_provider_period(reusable, monkeypatch)
    monkeypatch.setenv("DRIVE_AGENT_PACKAGES_ENABLED", "false")
    clear_runtime_settings_caches()
    monkeypatch.setattr(
        "hushh_mcp.services.drive_packet_catalog_service.wake_drive_work_stages", AsyncMock()
    )
    monkeypatch.setattr(
        "hushh_mcp.services.drive_owner_search_service.wake_drive_work", AsyncMock()
    )
    await period.set_listing(
        user_id="owner",
        packet_id=str(head["packet_id"]),
        version=1,
        decision="allow",
        price_cents=500,
        expected_revision=0,
        disclosure=LISTING_DISCLOSURE,
    )
    catalog = DrivePacketCatalogService(
        sharing=DriveSharingService(store=sharing),
        packets=reusable.packets,
        require_owner=AsyncMock(),
    )
    buyer = await catalog.list_packets(user_id="recipient", owner_user_id="owner")
    assert len(buyer["packets"]) == 1 and "contents" not in buyer["packets"][0]
    created = await catalog.request_packet(
        user_id="recipient",
        recipient=recipient(),
        packet_id=str(head["packet_id"]),
        version=1,
        client_request_id=str(uuid4()),
    )
    request_id = created["requestId"]
    raw = {
        "id": file["id"],
        "title": file["name"],
        "mimeType": file["mimeType"],
        "version": file["sourceVersion"],
        "modifiedTime": file["modifiedTime"],
        "capabilities": {"canShare": True},
    }
    transport = SimpleNamespace(
        read_tool=AsyncMock(
            return_value=SimpleNamespace(payload={"file": raw}, is_error=False, truncated=False)
        )
    )
    search = DriveOwnerSearchService(
        store=DriveOwnerSearchStore(db=sharing.db), transport=transport, packets=reusable.packets
    )
    bulk = DriveRequestBulkService(
        sharing=sharing,
        search=search,
        bulk=request_bulk,
        require_owner=AsyncMock(),
        wake=AsyncMock(),
        semantic_planner=AsyncMock(side_effect=AssertionError("replanned")),
    )
    found = await bulk.start_search(user_id="owner", request_id=request_id)
    assert found["status"] == "completed" and found["matched"] == 1, (
        found.get("errorCode"),
        transport.read_tool.await_count,
    )
    transport.read_tool.assert_awaited_once_with(
        user_id="owner", tool_name="get_file_metadata", arguments={"fileId": file["id"]}
    )
    packages = DriveRequestPackageStore(db=sharing.db, sharing=sharing)
    work = await packages.claim_evaluation(user_id="owner", job_id=found["jobId"])
    package = await packages.finalize_provider_packet(work)
    assert package["confidenceBasis"] == "provider_search" and package["canAllow"]
    with sharing.db.engine.connect() as connection:
        row = sharing._request(connection, "owner", request_id)
        revision = row["revision"]
        assert (
            connection.execute(
                text("SELECT count(*) FROM drive_request_payment_orders")
            ).scalar_one()
            == 0
        )
    with pytest.raises(DriveSharingError, match="invalid_payment_amount"):
        await sharing.allow_request(
            user_id="owner",
            request_id=request_id,
            revision=revision,
            amount_cents=600,
            package_revision=package["revision"],
            package_digest=package["digest"],
        )
    await sharing.allow_request(
        user_id="owner",
        request_id=request_id,
        revision=revision,
        amount_cents=500,
        package_revision=package["revision"],
        package_digest=package["digest"],
    )
    buyer = await catalog.list_packets(user_id="recipient", owner_user_id="owner")
    assert buyer["packets"][0]["requestId"] == request_id
    assert buyer["packets"][0]["purchaseState"] == "pending"
    with sharing.db.engine.connect() as connection:
        allowed = sharing._request(connection, "owner", request_id)
        assert allowed["owner_allowed_at"] is not None and allowed["quoted_amount_cents"] == 500
        assert (
            connection.execute(
                text("SELECT count(*) FROM drive_request_payment_orders")
            ).scalar_one()
            == 0
        )
        assert (
            connection.execute(text("SELECT count(*) FROM drive_bulk_share_effects")).scalar_one()
            == 0
        )


async def test_period_packets_never_become_free_when_payments_are_disabled(
    reusable, sharing, monkeypatch
):
    period, head, _, _, _ = await frozen_provider_period(reusable, monkeypatch)
    monkeypatch.setenv("DRIVE_REQUEST_PAYMENTS_ENABLED", "true")
    await period.set_listing(
        user_id="owner",
        packet_id=str(head["packet_id"]),
        version=1,
        decision="allow",
        price_cents=500,
        expected_revision=0,
        disclosure=LISTING_DISCLOSURE,
    )
    monkeypatch.setenv("DRIVE_REQUEST_PAYMENTS_ENABLED", "false")
    catalog = DrivePacketCatalogService(
        sharing=DriveSharingService(store=sharing),
        packets=reusable.packets,
        require_owner=AsyncMock(),
    )
    owner = await reusable.packets.list_packets(user_id="owner", owner_contents=True, limit=100)
    item = next(item for item in owner["packets"] if item["packetId"] == str(head["packet_id"]))
    assert item["contents"]["documents"] and item["canList"] is False
    buyer = await catalog.list_packets(user_id="recipient", owner_user_id="owner")
    assert buyer["packets"][0]["canRequest"] is False
    with pytest.raises(DriveReadError, match="packet_unavailable"):
        await period.set_listing(
            user_id="owner",
            packet_id=str(head["packet_id"]),
            version=1,
            decision="allow",
            price_cents=500,
            expected_revision=1,
            disclosure=LISTING_DISCLOSURE,
        )
    with pytest.raises(DriveReadError, match="packet_unavailable"):
        await catalog.request_packet(
            user_id="recipient",
            recipient=recipient(),
            packet_id=str(head["packet_id"]),
            version=1,
            client_request_id=str(uuid4()),
        )
    manifest = await period.current_packet_manifest(
        owner_user_id="owner",
        packet_id=str(head["packet_id"]),
        version=1,
        viewer_user_id="recipient",
    )
    reference = {
        "packetId": str(head["packet_id"]),
        "version": 1,
        "ownerUserId": "owner",
        "manifestDigest": manifest["digest"],
        "listingRevision": manifest["listing_revision"],
        "priceCents": 500,
    }
    with pytest.raises(DriveSharingError, match="packet_unavailable"):
        await sharing.create_request(
            recipient=recipient(),
            owner_user_id="owner",
            client_request_id=str(uuid4()),
            purpose=ShareRequestPurpose(
                purpose="Synthetic packet",
                periodStart=manifest["periodStart"],
                periodEnd=manifest["periodEnd"],
            ),
            reusable_packet=reference,
        )
    with sharing.db.engine.connect() as connection:
        assert (
            connection.execute(text("SELECT count(*) FROM drive_share_requests")).scalar_one() == 0
        )
