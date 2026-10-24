"""Real PostgreSQL provider packet lifecycle; only external systems are synthetic."""

# ruff: noqa: F401,F811 -- shared disposable fixture dependency graph
from __future__ import annotations

import json
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from sqlalchemy import text

from hushh_mcp.runtime_settings import clear_runtime_settings_caches
from hushh_mcp.services.drive_packet_catalog_service import DrivePacketCatalogService
from hushh_mcp.services.drive_sharing_contract import DriveSharingError, ShareRequestPurpose
from hushh_mcp.services.drive_sharing_service import DriveSharingService
from hushh_mcp.services.google_drive_adapter import DriveReadError
from tests.services.test_drive_packet_catalog_postgres import recipient
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
    ingestion,
    lifecycle,
    reusable,
    sharing,
)


async def frozen_provider_period(reusable, monkeypatch):
    monkeypatch.setenv("DRIVE_PERIOD_PACKETS_ENABLED", "true")
    from datetime import UTC, datetime

    from hushh_mcp.services.drive_owner_search_service import DriveOwnerSearchService
    from hushh_mcp.services.drive_owner_search_store import DriveOwnerSearchStore
    from hushh_mcp.services.drive_period_packet_service import DrivePeriodPacketService
    from hushh_mcp.services.drive_period_packet_store import DrivePeriodPacketStore
    from hushh_mcp.services.drive_request_discovery import discovery_evidence
    from tests.services.test_drive_period_packets import semantic

    monkeypatch.setattr(
        "hushh_mcp.services.drive_request_package_assessment.validate_semantic_model_binding",
        lambda value: value,
    )
    period = DrivePeriodPacketStore(db=reusable.collection.db, cipher=reusable.collection.cipher)
    await period.ensure_owner(user_id="owner", now=datetime(2020, 3, 1, tzinfo=UTC))
    with period.db.engine.begin() as connection:
        connection.execute(
            text("UPDATE drive_collection_sync SET processing_enabled=FALSE WHERE user_id='owner'")
        )
    job = await period.claim_build(user_id="owner")
    assert job and job["period_start"].year == 2020
    plan = {"file_kind": "any", "semantic_query": semantic()}
    binding = {
        "provider": "azure_openai",
        "deployment": "synthetic",
        "config_fingerprint": "synthetic",
        "approval_generation": None,
    }
    search = DriveOwnerSearchStore(db=period.db)
    authored = {
        **plan,
        "subject_scope": "specific_records",
        "subject_complete": True,
        "semantic_intent": "other",
        "discovery_clues": ["statement"],
        "required_entities": [],
        "expected_document_anatomy": "Provider search membership only.",
    }
    planner = AsyncMock(return_value=authored)
    monkeypatch.setattr(
        "hushh_mcp.services.drive_period_packet_service.semantic_request_model_binding",
        lambda: binding,
    )
    service = DrivePeriodPacketService(
        store=period, search=DriveOwnerSearchService(store=search), planner=planner
    )
    plan, binding = await service._plan(job, AsyncMock())
    planner.assert_not_awaited()
    assert binding is None and plan["semantic_query"]["date_basis"] == "title_created_modified"
    state = await service._search_job(job, plan, binding)
    claimed = await search.claim(user_id="owner", job_id=state["jobId"])
    checkpoint = claimed["checkpoint"]
    file = {
        "id": "synthetic-file",
        "name": "Synthetic statement",
        "mimeType": "application/pdf",
        "modifiedTime": f"{job['period_start'].isoformat()}T00:00:00Z",
        "sourceVersion": "1",
        "shareable": True,
    }
    file["discoveryEvidence"] = discovery_evidence(
        checkpoint, user_id="owner", generation=1, metadata=file
    )
    await search.commit_page(claimed, checkpoint=checkpoint, files=[file], done=True)
    job["build"] = {"plan": plan, "model_binding": binding}
    manifest = await period.freeze(job, search_job_id=state["jobId"])
    return period, job, state, manifest, file


async def test_provider_period_freezes_metadata_once_without_facts_or_collection(
    reusable, monkeypatch
):
    period, job, state, manifest, file = await frozen_provider_period(reusable, monkeypatch)
    plan = job["build"]["plan"]
    assert manifest["state"] == "ready" and manifest["kind"] == "provider_discovery"
    assert len(manifest["sources"]) == 1 and manifest["search"]["authored_plan"] == plan
    assert "assessment_score" not in manifest["assessment"]
    assert manifest["search"]["model_binding"] is None
    assert manifest["search"]["query_source"]["kind"] == "predefined"
    assert manifest["search"]["query_source"]["planner_executed"] is False
    with pytest.raises(DriveReadError, match="packet_superseded"):
        await period.freeze(job, search_job_id=state["jobId"])
    current = await reusable.packets.current_packet_manifest(
        owner_user_id="owner", packet_id=str(job["packet_id"]), version=1
    )
    assert current["digest"] and current["price_cents"] == 500
    page = await period.list_packets(user_id="owner", owner_contents=True, limit=100)
    assert await period.due_owners(limit=1) == ["owner"]
    item = next(item for item in page["packets"] if item["packetId"] == str(job["packet_id"]))
    assert item["contents"]["documents"][0]["name"] == file["name"]
    assert item["contents"]["documents"][0]["type"] is None
    with period.db.engine.begin() as connection:
        assert (
            connection.execute(
                text("SELECT count(*) FROM drive_packet_members WHERE packet_id=:id"),
                {"id": job["packet_id"]},
            ).scalar_one()
            == 0
        )
        connection.exec_driver_sql(
            (MIGRATIONS / "411_drive_period_packets.sql").read_text(),
            execution_options={"no_parameters": True},
        )
        connection.exec_driver_sql(
            (MIGRATIONS / "rollback/411_drive_period_packets.rollback.sql").read_text(),
            execution_options={"no_parameters": True},
        )
    assert (
        await reusable.packets.current_packet_manifest(
            owner_user_id="owner", packet_id=str(job["packet_id"]), version=1
        )
    )["digest"] == current["digest"]


@pytest.mark.parametrize("state", ["reclaimed", "expired"])
async def test_period_provider_call_fence_rejects_lost_head_lease(reusable, monkeypatch, state):
    from datetime import UTC, datetime

    from hushh_mcp.services.drive_period_packet_store import DrivePeriodPacketStore

    monkeypatch.setenv("DRIVE_PERIOD_PACKETS_ENABLED", "true")
    period = DrivePeriodPacketStore(db=reusable.collection.db, cipher=reusable.collection.cipher)
    await period.ensure_owner(user_id="owner", now=datetime(2020, 3, 1, tzinfo=UTC))
    job = await period.claim_build(user_id="owner")
    arguments = {
        "user_id": "owner",
        "packet_id": str(job["packet_id"]),
        "revision": job["revision"],
        "lease_id": job["lease_id"],
    }
    await period.require_build_current(**arguments)
    change = (
        "lease_id=gen_random_uuid()"
        if state == "reclaimed"
        else "lease_expires_at=clock_timestamp()-INTERVAL '1 second'"
    )
    with period.db.engine.begin() as connection:
        connection.execute(
            text("UPDATE drive_packet_heads SET " + change + " WHERE packet_id=:id"),
            {"id": job["packet_id"]},
        )
    with pytest.raises(DriveReadError, match="packet_superseded"):
        await period.require_build_current(**arguments)


async def prepared_provider_purchase(reusable, sharing, request_bulk, monkeypatch):
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
    return catalog, request_id, packages, package


async def test_provider_packet_real_catalog_search_finalizer_and_owner_allow(
    reusable, sharing, request_bulk, monkeypatch
):
    catalog, request_id, packages, package = await prepared_provider_purchase(
        reusable, sharing, request_bulk, monkeypatch
    )
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
    owner = await period.list_packets(user_id="owner", owner_contents=True, limit=100)
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


async def test_financial_enrollment_is_current_year_idempotent_and_financial_only(
    reusable, monkeypatch
):
    from hushh_mcp.services.drive_period_packet_store import DrivePeriodPacketStore

    monkeypatch.setenv("DRIVE_PERIOD_PACKETS_ENABLED", "true")
    store = DrivePeriodPacketStore(db=reusable.collection.db, cipher=reusable.collection.cipher)
    instant = datetime(2026, 10, 24, tzinfo=UTC)
    assert await store.ensure_owner(user_id="owner", now=instant) == 5
    assert await store.ensure_owner(user_id="owner", now=instant) == 5
    with store.db.engine.connect() as connection:
        rows = list(
            connection.execute(
                text("""SELECT category,period_start,period_end,period_timezone
          FROM drive_packet_heads WHERE user_id='owner' AND packet_kind='provider_discovery'
          ORDER BY period_start""")
            ).mappings()
        )
    assert [(r["category"], r["period_start"].month, r["period_end"].month) for r in rows] == [
        ("financial", 1, 2),
        ("financial", 3, 4),
        ("financial", 5, 6),
        ("financial", 7, 8),
        ("financial", 9, 10),
    ]
    assert all(r["period_start"].year == 2026 and r["period_timezone"] == "UTC" for r in rows)
