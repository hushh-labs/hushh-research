"""Real packet/index -> request reuse; provider and model outputs are synthetic."""

# ruff: noqa: F401,F811 -- isolated fixture dependency graph
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from sqlalchemy import text

from hushh_mcp.services.drive_bulk_share_store import DriveBulkShareStore
from hushh_mcp.services.drive_owner_search_service import DriveOwnerSearchService
from hushh_mcp.services.drive_owner_search_store import DriveOwnerSearchStore
from hushh_mcp.services.drive_packet_contract import PacketVerification
from hushh_mcp.services.drive_request_bulk_service import DriveRequestBulkService
from hushh_mcp.services.drive_request_package_service import DriveRequestPackageService
from hushh_mcp.services.drive_request_package_store import DriveRequestPackageStore
from hushh_mcp.services.drive_sharing_contract import ShareRequestPurpose
from hushh_mcp.services.google_drive_adapter import DriveReadError
from tests.services.test_drive_packet_catalog_postgres import (
    LISTING_DISCLOSURE,
    MIGRATIONS,
    catalog,
    collection,
    collection_pages,
    connector_postgres_url,
    documents,
    drive,
    drive_connect,
    ingestion,
    lifecycle,
    ready_packet,
    recipient,
    reusable,
    sharing,
)


def transport_for(manifest):
    rows = {meta["file_id"]: meta for meta in manifest["source_metadata"].values()}

    async def read(**kwargs):
        assert kwargs["tool_name"] == "get_file_metadata"
        item = rows[kwargs["arguments"]["fileId"]]
        return SimpleNamespace(
            is_error=False,
            truncated=False,
            payload={
                "file": {
                    "id": item["file_id"],
                    "title": item["name"],
                    "mimeType": item["mime_type"],
                    "version": item["version"],
                    "modifiedTime": item["modified_time"],
                    "capabilities": {
                        "canShare": True,
                        "canDownload": True,
                        "canAccessViaGenAi": True,
                    },
                }
            },
        )

    return SimpleNamespace(read_tool=AsyncMock(side_effect=read))


def mark_historical_agent_package_request(sharing, request_id):
    """Keep V2 index reuse covered without routing a new V1 live request through it."""
    with sharing.db.engine.begin() as connection:
        row = sharing._request(connection, "owner", request_id)
        private = sharing._open_request(row)
        assert private["agent_package_required"] is True
        assert private["v1_live_request"] is True
        private.pop("v1_live_request")
        envelope = sharing.sharing_cipher.seal(
            private, user_id="owner", resource_id=request_id, purpose="request"
        )
        connection.execute(
            text("""UPDATE drive_share_requests
                SET request_envelope=CAST(:envelope AS jsonb),v1_live_request=FALSE
                WHERE request_id=:request"""),
            {"envelope": json.dumps(envelope), "request": request_id},
        )


async def flow(catalog, reusable, sharing):
    service, packet = catalog
    request = await service.request_packet(
        user_id="recipient",
        recipient=recipient(),
        packet_id=packet["packetId"],
        version=1,
        client_request_id=str(uuid4()),
    )
    manifest = await reusable.packets.current_packet_manifest(
        owner_user_id="owner", packet_id=packet["packetId"], version=1
    )
    transport = transport_for(manifest)
    search = DriveOwnerSearchService(
        store=DriveOwnerSearchStore(db=sharing.db),
        transport=transport,
        sharing=sharing,
        facts=reusable.facts,
        packets=reusable.packets,
    )
    planner = AsyncMock(side_effect=AssertionError("Reusable packet must not be replanned"))
    bulk = DriveRequestBulkService(
        sharing=sharing, search=search, planner=planner, require_owner=AsyncMock()
    )
    found = await bulk.start_search(user_id="owner", request_id=request["requestId"])
    return request, found, search, planner, transport


async def test_exact_packet_preserves_membership_price_and_skips_content_model(
    catalog, reusable, sharing, monkeypatch
):
    monkeypatch.setattr(
        "hushh_mcp.services.drive_owner_search_service.wake_drive_work", AsyncMock()
    )
    request, found, search, planner, transport = await flow(catalog, reusable, sharing)
    assert found["status"] == "completed" and found["matched"] == 1
    assert found["coverage"]["retrievalSource"] == "reusable_packet"
    assert found["coverage"]["providerPagesExhausted"] is False
    planner.assert_not_awaited()
    store = DriveRequestPackageStore(db=sharing.db, sharing=sharing)
    model = AsyncMock(side_effect=AssertionError("Exact packet must reuse its verified assessment"))
    reader = AsyncMock(side_effect=AssertionError("Must not reread complete indexed bytes"))
    service = DriveRequestPackageService(
        store=store,
        facts=reusable.facts,
        packets=reusable.packets,
        reader_factory=reader,
        document_assessor=model,
        package_assessor=model,
        wake=AsyncMock(),
    )
    assert await service.run_one(user_id="owner", job_id=found["jobId"]) == "queued"
    assert await service.run_one(user_id="owner", job_id=found["jobId"]) == "ready"
    review = await store.package_review(user_id="owner", request_id=request["requestId"])
    assert review["selectedCount"] == 1 and review["suggestedPriceCents"] == 125
    assert review["canAllow"] is True and review["coverageStatus"] == "complete"
    model.assert_not_awaited()
    reader.assert_not_called()
    assert transport.read_tool.await_count == 1
    with sharing.db.engine.begin() as connection:
        row = sharing._request(connection, "owner", request["requestId"])
        private = sharing._open_request(row)
        validated = store.validate_ready_package(
            connection, row, private, review["revision"], review["digest"]
        )
        assert len(validated["selected_sources"]) == 1
        assert row["owner_allowed_at"] is None
        assert (
            connection.execute(
                text("SELECT count(*) FROM drive_request_payment_orders")
            ).scalar_one()
            == 0
        )

    await sharing.allow_request(
        user_id="owner",
        request_id=request["requestId"],
        revision=row["revision"],
        amount_cents=None,
        package_revision=review["revision"],
        package_digest=review["digest"],
    )
    prepared = await DriveRequestBulkService(
        sharing=sharing,
        search=search,
        bulk=DriveBulkShareStore(db=sharing.db),
        require_owner=AsyncMock(),
        recipient_identity=AsyncMock(return_value=recipient()),
        wake=AsyncMock(),
    ).prepare(user_id="owner", request_id=request["requestId"], positions=[1])
    assert prepared["status"] == "review_ready"


async def test_changed_source_invalidates_packet_before_reused_assessment(
    catalog, reusable, sharing, monkeypatch
):
    monkeypatch.setattr(
        "hushh_mcp.services.drive_owner_search_service.wake_drive_work", AsyncMock()
    )
    _, found, *_ = await flow(catalog, reusable, sharing)
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("UPDATE connected_documents SET source_version='2' WHERE source_profile='live'")
        )
    store = DriveRequestPackageStore(db=sharing.db, sharing=sharing)
    with pytest.raises(DriveReadError, match="packet_unavailable"):
        await store.claim_evaluation(user_id="owner", job_id=found["jobId"])


async def test_index_snapshot_accounts_for_pending_changed_and_old_profile_sources(
    catalog, reusable, sharing
):
    current = await reusable.facts.current_index_status(owner_user_id="owner")
    assert current["complete"] is True and current["indexed"] == current["discovered"] == 1
    page = await reusable.facts.current_documents_page(owner_user_id="owner")
    source = page["documents"][0]
    exact = await reusable.facts.current_document(
        owner_user_id="owner",
        **{key: source[key] for key in ("document_id", "source_version", "facts_version")},
    )
    assert exact["complete"] and exact["facts"] == source["facts"]
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text(
                "UPDATE connected_documents SET source_version='2',active_version=NULL,status='queued' WHERE source_profile='live'"
            )
        )
    changed = await reusable.facts.current_index_status(owner_user_id="owner")
    assert changed["complete"] is False and changed["pending"] == 1 and changed["indexed"] == 0
    assert changed["signature"] != current["signature"]
    with pytest.raises(DriveReadError, match="source_changed"):
        await reusable.facts.current_document(
            owner_user_id="owner",
            **{key: source[key] for key in ("document_id", "source_version", "facts_version")},
        )


async def test_finished_owner_no_longer_consumes_background_work_slot(catalog, reusable):
    assert await reusable.facts.due_owners() == []


async def test_natural_request_prefers_index_and_preserves_selected_dates(
    catalog, reusable, sharing, monkeypatch
):
    monkeypatch.setattr(
        "hushh_mcp.services.drive_owner_search_service.wake_drive_work", AsyncMock()
    )
    _, packet = catalog
    manifest = await reusable.packets.current_packet_manifest(
        owner_user_id="owner", packet_id=packet["packetId"], version=1
    )
    request = await sharing.create_request(
        recipient=recipient(),
        owner_user_id="owner",
        client_request_id=str(uuid4()),
        purpose=ShareRequestPurpose(
            # Explicit statement requests now take the deterministic V1 Drive
            # search; this request exercises the separate indexed packet path.
            purpose="Schwab account records from 2026",
            periodStart="2026-09-01",
            periodEnd="2026-10-09",
        ),
    )
    mark_historical_agent_package_request(sharing, request["requestId"])
    search = DriveOwnerSearchService(
        store=DriveOwnerSearchStore(db=sharing.db),
        transport=transport_for(manifest),
        sharing=sharing,
        facts=reusable.facts,
        packets=reusable.packets,
        packet_matcher=AsyncMock(
            return_value=SimpleNamespace(decision="derive", packet_id=packet["packetId"], version=1)
        ),
    )
    planner = AsyncMock(
        side_effect=AssertionError("Index semantics must not become a filename query")
    )
    service = DriveRequestBulkService(
        sharing=sharing, search=search, planner=planner, require_owner=AsyncMock()
    )
    found = await service.start_search(user_id="owner", request_id=request["requestId"])
    assert (
        found["status"] == "completed" and found["coverage"]["retrievalSource"] == "document_index"
    )
    assert found["coverage"]["requestedPeriod"] == {"start": "2026-09-01", "end": "2026-10-09"}
    job = await DriveRequestPackageStore(db=sharing.db, sharing=sharing).claim_evaluation(
        user_id="owner", job_id=found["jobId"]
    )
    assert (
        job["purpose"]["periodStart"] == "2026-09-01"
        and job["purpose"]["periodEnd"] == "2026-10-09"
    )
    assert job["candidates"][0]["metadata"]["indexedEvidence"]["facts_version"]
    planner.assert_not_awaited()


async def test_equivalent_request_reuses_unlisted_packet_with_owner_approval_still_required(
    catalog, reusable, sharing, monkeypatch
):
    monkeypatch.setattr(
        "hushh_mcp.services.drive_owner_search_service.wake_drive_work", AsyncMock()
    )
    _, packet = catalog
    await reusable.packets.set_listing(
        user_id="owner",
        packet_id=packet["packetId"],
        version=1,
        decision="deny",
        price_cents=125,
        expected_revision=1,
        disclosure=LISTING_DISCLOSURE,
    )
    manifest = await reusable.packets.current_packet_manifest(
        owner_user_id="owner", packet_id=packet["packetId"], version=1
    )
    request = await sharing.create_request(
        recipient=recipient(),
        owner_user_id="owner",
        client_request_id=str(uuid4()),
        purpose=ShareRequestPurpose(
            purpose="Please send the same statements",
            periodStart="2026-09-01",
            periodEnd="2026-10-09",
        ),
    )
    mark_historical_agent_package_request(sharing, request["requestId"])
    matcher = AsyncMock(
        return_value=SimpleNamespace(decision="exact", packet_id=packet["packetId"], version=1)
    )
    search = DriveOwnerSearchService(
        store=DriveOwnerSearchStore(db=sharing.db),
        transport=transport_for(manifest),
        sharing=sharing,
        facts=reusable.facts,
        packets=reusable.packets,
        packet_matcher=matcher,
        packet_checker=AsyncMock(
            return_value=PacketVerification(
                state="ready",
                correct_subject_and_account=True,
                correct_issuer_and_type=True,
                correct_record_status=True,
                correct_coverage=True,
                no_unrelated_inclusions=True,
                no_unexplained_omissions=True,
                issues=[],
            )
        ),
    )
    planner = AsyncMock(
        side_effect=AssertionError("Exact canonical reuse must skip Google query planning")
    )
    bulk = DriveRequestBulkService(
        sharing=sharing, search=search, planner=planner, require_owner=AsyncMock()
    )
    found = await bulk.start_search(user_id="owner", request_id=request["requestId"])
    assert found["coverage"]["retrievalSource"] == "reusable_packet"
    store = DriveRequestPackageStore(db=sharing.db, sharing=sharing)
    model = AsyncMock(side_effect=AssertionError("Exact packet must not be reassembled"))
    service = DriveRequestPackageService(
        store=store,
        facts=reusable.facts,
        packets=reusable.packets,
        document_assessor=model,
        package_assessor=model,
        wake=AsyncMock(),
    )
    assert await service.run_one(user_id="owner", job_id=found["jobId"]) == "queued"
    assert await service.run_one(user_id="owner", job_id=found["jobId"]) == "ready"
    with sharing.db.engine.connect() as connection:
        row = sharing._request(connection, "owner", request["requestId"])
        assert row["owner_allowed_at"] is None
        assert sharing._open_request(row).get("reusable_packet") is None
    assert matcher.await_count == 1
    matched_source = matcher.call_args.kwargs["packets"][0]["current_source_facts"][0]
    assert matched_source["document_type"] == "statement"
    assert matched_source["evidence_complete"] is True and matched_source["facts_version"]
    assert (
        "account" in matched_source
        and "issuer" in matched_source
        and "content_periods" in matched_source
    )
    model.assert_not_awaited()
    planner.assert_not_awaited()
