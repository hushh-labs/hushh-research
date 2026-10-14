"""Real PostgreSQL authority/version tests; synthetic model outputs, no provider I/O."""

# ruff: noqa: F401,F811 -- shared isolated PostgreSQL fixture dependency graph
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import text

from hushh_mcp.services.drive_document_facts_store import DriveDocumentFactsStore
from hushh_mcp.services.drive_packet_store import LISTING_DISCLOSURE, DrivePacketStore
from hushh_mcp.services.drive_packet_worker import DrivePacketWorker
from hushh_mcp.services.drive_sharing_contract import DriveSharingError
from hushh_mcp.services.google_drive_adapter import DriveReadError
from tests.services.test_drive_ingestion import (
    collection,
    collection_pages,
    connector_postgres_url,
    documents,
    drive,
    drive_connect,
    ingestion,
    lifecycle,
    seed_collection,
    source,
)
from tests.services.test_drive_sharing_store import request, sharing

MIGRATIONS = Path(__file__).resolve().parents[2] / "db/migrations"
POLICY = "test-document-facts-v1"


def page_facts(pages):
    return {
        "pages": [page["page"] for page in pages],
        "document_type": {
            "value": "statement",
            "citations": [
                {
                    "page": pages[0]["page"],
                    "quote": "Synthetic statement evidence",
                    "unit_kind": pages[0].get("unit_kind", "page"),
                }
            ],
        },
        "issuer": None,
        "subject": None,
        "account": None,
        "periods": [],
        "topics": [],
        "facts": [],
        "missing_information": [],
        "ambiguous": False,
    }


def document_facts(pages, complete=True):
    return {key: value for key, value in page_facts(pages).items() if key != "pages"} | {
        "canonical_packets": [
            {
                "key": "synthetic-statement-account",
                "title": "Synthetic statements",
                "description": "Synthetic test account statements",
            }
        ]
        if complete
        else []
    }


async def assess_pages(**kwargs):
    return page_facts(kwargs["pages"])


async def fold(**kwargs):
    return {key: value for key, value in kwargs["page_facts"][0].items() if key != "pages"} | {
        "canonical_packets": [
            {
                "key": "synthetic-statement-account",
                "title": "Synthetic statements",
                "description": "Synthetic test account statements",
            }
        ]
        if kwargs["complete"]
        else []
    }


async def construct(**kwargs):
    selected = (kwargs.get("previous") or {}).get("selected_document_ids", []) + [
        item["document_id"] for item in kwargs["documents"]
    ]
    complete = kwargs["complete"]
    return {
        "title": "Synthetic statements",
        "description": "A test packet",
        "state": "ready" if complete else "incomplete",
        "selected_document_ids": selected,
        "coverage_summary": "Synthetic complete evidence" if complete else "More evidence remains",
        "periods": [],
        "gaps": [] if complete else ["More evidence remains"],
        "assessment_score": 91,
        "importance": 120,
        "pricing": {
            "rubric_version": "drive-packet-price-v1",
            "useful_scope": "collection",
            "coverage": "complete" if complete else "partial",
            "quality": "verified",
            "rationale": "Synthetic independent test fixture",
            "suggested_price_cents": 125,
        },
    }


async def check(**kwargs):
    return {
        "state": "ready" if kwargs["complete"] else "incomplete",
        "correct_subject_and_account": True,
        "correct_issuer_and_type": True,
        "correct_coverage": kwargs["complete"],
        "no_unrelated_inclusions": True,
        "no_unexplained_omissions": True,
        "issues": [] if kwargs["complete"] else ["Evidence incomplete"],
    }


@pytest.fixture
async def reusable(sharing, collection, ingestion, monkeypatch):
    monkeypatch.setattr(
        "hushh_mcp.services.drive_packet_intelligence.facts_policy_version", lambda: POLICY
    )
    with collection.db.engine.connect() as connection:
        connection.exec_driver_sql(
            (MIGRATIONS / "334_drive_reusable_packets.sql").read_text(),
            execution_options={"no_parameters": True},
        )
    facts = DriveDocumentFactsStore(db=collection.db, cipher=collection.cipher)
    packets = DrivePacketStore(db=collection.db, cipher=collection.cipher)
    worker = DrivePacketWorker(
        facts_store=facts,
        packet_store=packets,
        page_assessor=assess_pages,
        consolidator=fold,
        constructor=construct,
        checker=check,
        policy=lambda: POLICY,
        wake=AsyncMock(),
    )
    return SimpleNamespace(
        facts=facts, packets=packets, worker=worker, collection=collection, ingestion=ingestion
    )


async def originals(reusable, count=1):
    files = [source(f"synthetic-source-{i}") for i in range(count)]
    await seed_collection(reusable.collection, files=files)
    for _ in files:
        job = await reusable.ingestion.claim(user_id="owner", generation=1)
        metadata = next(
            item
            for item in files
            if reusable.collection.cipher.fingerprint("owner", item.file_id)
            == job["source_fingerprint"]
        )
        await reusable.ingestion.publish_pages(job, metadata=metadata, batch=collection_pages())
    return files


async def ready_packet(reusable, count=1):
    await originals(reusable, count)
    for _ in range(count):
        assert await reusable.worker.run_facts_one(user_id="owner") == "facts_complete"
    for _ in range(2 * ((count + 3) // 4) + 1):
        result = await reusable.worker.run_packet_one(user_id="owner")
    assert result == "ready"
    listing = (await reusable.packets.list_packets(user_id="owner"))["packets"]
    assert len(listing) == 1
    return listing[0]


async def test_fact_leases_and_pause_reject_late_model_output(reusable):
    await originals(reusable)
    assert await reusable.facts.enqueue(user_id="owner", policy_version=POLICY) == 1
    claims = await asyncio.gather(
        *[reusable.facts.claim(user_id="owner", policy_version=POLICY) for _ in range(3)]
    )
    assert sum(job is not None for job in claims) == 1
    job = next(job for job in claims if job)
    await reusable.collection.set_processing(user_id="owner", enabled=False)
    pages = [{"page": 1, "text": "Synthetic statement evidence", "unit_kind": "page"}]
    with pytest.raises(DriveReadError, match="collection_processing_required"):
        await reusable.facts.commit_batch(
            job, page_facts=page_facts(pages), document_facts=document_facts(pages)
        )
    with reusable.facts.db.engine.connect() as connection:
        assert (
            connection.execute(text("SELECT count(*) FROM drive_document_fact_pages")).scalar_one()
            == 0
        )


async def test_exact_version_reuse_and_summary_listing_need_separate_allow(reusable):
    packet = await ready_packet(reusable)
    assert packet["canList"] and not packet["listingEnabled"]
    assert (await reusable.packets.list_packets(user_id="recipient", owner_user_id="owner"))[
        "packets"
    ] == []
    assert await reusable.facts.enqueue(user_id="owner", policy_version=POLICY) == 0
    assert await reusable.worker.run_facts_one(user_id="owner") == "idle"
    assert await reusable.worker.run_packet_one(user_id="owner") == "idle"
    with pytest.raises(DriveReadError, match="listing_disclosure_required"):
        await reusable.packets.set_listing(
            user_id="owner",
            packet_id=packet["packetId"],
            version=1,
            decision="allow",
            price_cents=51,
            expected_revision=0,
            disclosure="wrong",
        )
    allowed = await reusable.packets.set_listing(
        user_id="owner",
        packet_id=packet["packetId"],
        version=1,
        decision="allow",
        price_cents=51,
        expected_revision=0,
        disclosure=LISTING_DISCLOSURE,
    )
    assert allowed["priceCents"] == 51
    buyer = (await reusable.packets.list_packets(user_id="recipient", owner_user_id="owner"))[
        "packets"
    ][0]
    assert buyer["canRequest"] and buyer["priceCents"] == 51
    assert "sources" not in buyer and "facts" not in buyer and "source_metadata" not in buyer
    manifest = await reusable.packets.current_packet_manifest(
        owner_user_id="owner", packet_id=packet["packetId"], version=1, viewer_user_id="recipient"
    )
    assert manifest["price_cents"] == 51 and len(manifest["sources"]) == 1
    assert len(manifest["source_metadata"]) == 1
    with reusable.facts.db.engine.connect() as connection:
        stored = str(
            connection.execute(text("SELECT facts_envelope FROM drive_document_facts")).scalar_one()
        )
        assert "Synthetic statement evidence" not in stored
        assert (
            connection.execute(
                text("SELECT count(*) FROM drive_request_payment_orders")
            ).scalar_one()
            == 0
        )
    with pytest.raises((DriveReadError, DriveSharingError)):
        await reusable.packets.list_packets(user_id="unrelated", owner_user_id="owner")


async def test_source_change_invalidates_listing_without_rewriting_history(reusable):
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
    with reusable.facts.db.engine.begin() as connection:
        before = (
            connection.execute(text("SELECT manifest_envelope,digest FROM drive_packet_versions"))
            .mappings()
            .one()
        )
        connection.execute(
            text(
                "UPDATE connected_documents SET source_version='2',active_version=NULL,status='queued'"
            )
        )
        after = (
            connection.execute(
                text("SELECT manifest_envelope,digest,available FROM drive_packet_versions")
            )
            .mappings()
            .one()
        )
    assert (
        after["manifest_envelope"] == before["manifest_envelope"]
        and after["digest"] == before["digest"]
    )
    assert not after["available"]
    buyer = (await reusable.packets.list_packets(user_id="recipient", owner_user_id="owner"))[
        "packets"
    ][0]
    assert not buyer["canRequest"] and buyer["freshness"] == "stale"
    with pytest.raises(DriveReadError, match="packet_unavailable"):
        await reusable.packets.current_packet_manifest(
            owner_user_id="owner",
            packet_id=packet["packetId"],
            version=1,
            viewer_user_id="recipient",
        )


async def test_refresh_status_does_not_dirty_unchanged_packet(reusable):
    await ready_packet(reusable)
    with reusable.facts.db.engine.begin() as connection:
        before = connection.execute(text("SELECT revision FROM drive_packet_heads")).scalar_one()
        connection.execute(text("UPDATE connected_documents SET status='fetching'"))
        connection.execute(text("UPDATE connected_documents SET status='ready'"))
        row = (
            connection.execute(text("SELECT revision,dirty FROM drive_packet_heads"))
            .mappings()
            .one()
        )
    assert row["revision"] == before and not row["dirty"]


async def test_stale_collection_disables_listing_and_manifest_until_sync_recovers(reusable):
    packet = await ready_packet(reusable)
    with reusable.facts.db.engine.begin() as connection:
        connection.execute(
            text(
                "UPDATE drive_collection_sync SET last_synced_at=clock_timestamp()-interval '901 seconds'"
            )
        )
    view = (await reusable.packets.list_packets(user_id="owner"))["packets"][0]
    assert view["freshness"] == "stale" and not view["canList"]
    with pytest.raises(DriveReadError, match="packet_unavailable"):
        await reusable.packets.current_packet_manifest(
            owner_user_id="owner", packet_id=packet["packetId"], version=1
        )
    with reusable.facts.db.engine.begin() as connection:
        connection.execute(
            text("UPDATE drive_collection_sync SET last_synced_at=clock_timestamp()")
        )
    recovered = (await reusable.packets.list_packets(user_id="owner"))["packets"][0]
    assert recovered["freshness"] == "current" and recovered["canList"]


async def test_verified_packet_scope_can_be_ready_with_other_unreadable_sources(reusable):
    await originals(reusable, 2)
    with reusable.facts.db.engine.begin() as connection:
        connection.execute(
            text(
                "UPDATE connected_documents SET status='unsupported' WHERE document_id=(SELECT document_id FROM connected_documents ORDER BY document_id LIMIT 1)"
            )
        )
    assert await reusable.worker.run_facts_one(user_id="owner") == "facts_complete"
    for _ in range(3):
        outcome = await reusable.worker.run_packet_one(user_id="owner")
    assert outcome == "ready"
    view = (await reusable.packets.list_packets(user_id="owner"))["packets"][0]
    assert view["documentCount"] == 1 and view["canList"]
    assert "Other Drive files remain unverified" in view["description"]
    manifest = await reusable.packets.current_packet_manifest(
        owner_user_id="owner", packet_id=view["packetId"], version=1
    )
    assert not manifest["collection_complete"]
    assert manifest["coverage_scope"] == "verified_observed_span"
    assert len(manifest["sources"]) == 1
    index = await reusable.facts.current_index_status(owner_user_id="owner", policy_version=POLICY)
    assert not index["complete"] and index["discovered"] == 2 and index["indexed"] == 1


async def test_all_46_members_construct_and_verify_before_ready(reusable):
    packet = await ready_packet(reusable, 46)
    assert packet["documentCount"] == 46 and packet["state"] == "ready"
    with reusable.facts.db.engine.connect() as connection:
        assert (
            connection.execute(
                text("SELECT count(*) FROM drive_document_facts WHERE status='complete'")
            ).scalar_one()
            == 46
        )
        assert (
            connection.execute(
                text("SELECT count(*) FROM drive_packet_version_sources")
            ).scalar_one()
            == 46
        )
        assert (
            connection.execute(text("SELECT count(*) FROM drive_packet_listings")).scalar_one() == 0
        )
    assert not packet["listingEnabled"]


async def test_independent_checker_failure_prevents_ready_and_listing(reusable):
    await originals(reusable)
    await reusable.worker.run_facts_one(user_id="owner")

    async def negative(**kwargs):
        return (await check(**kwargs)) | {
            "state": "incomplete",
            "no_unrelated_inclusions": False,
            "issues": ["Unrelated member"],
        }

    reusable.worker.checker = negative
    for _ in range(3):
        result = await reusable.worker.run_packet_one(user_id="owner")
    assert result == "incomplete"
    packet = (await reusable.packets.list_packets(user_id="owner"))["packets"][0]
    assert not packet["canList"]
    with pytest.raises(DriveReadError, match="packet_unavailable"):
        await reusable.packets.set_listing(
            user_id="owner",
            packet_id=packet["packetId"],
            version=1,
            decision="allow",
            price_cents=125,
            expected_revision=0,
            disclosure=LISTING_DISCLOSURE,
        )


async def test_reference_fk_does_not_block_connector_deletion_or_mutate_request_terms(
    reusable, sharing
):
    packet = await ready_packet(reusable)
    created = await request(sharing)
    with reusable.facts.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_share_requests SET reusable_packet_id=:packet,
          reusable_packet_version=1 WHERE request_id=:request"""),
            {"packet": packet["packetId"], "request": created["requestId"]},
        )
        before = connection.execute(
            text("SELECT request_envelope FROM drive_share_requests WHERE request_id=:id"),
            {"id": created["requestId"]},
        ).scalar_one()
        connection.execute(
            text(
                "DELETE FROM user_external_connector_connections WHERE user_id='owner' AND connector_id='google_drive'"
            )
        )
        row = (
            connection.execute(
                text(
                    "SELECT request_envelope,reusable_packet_id,reusable_packet_version FROM drive_share_requests WHERE request_id=:id"
                ),
                {"id": created["requestId"]},
            )
            .mappings()
            .one()
        )
    assert row["request_envelope"] == before
    assert row["reusable_packet_id"] is None and row["reusable_packet_version"] is None


async def test_account_reset_erases_packet_evidence_while_retaining_generation_fence(reusable):
    from hushh_mcp.services.connection_graph_service import lock_connection_graph_users
    from hushh_mcp.services.drive_sharing_retention import erase_drive_account_in_transaction

    packet = await ready_packet(reusable)
    await reusable.packets.set_listing(
        user_id="owner",
        packet_id=packet["packetId"],
        version=1,
        decision="allow",
        price_cents=51,
        expected_revision=0,
        disclosure=LISTING_DISCLOSURE,
    )
    with reusable.facts.db.engine.begin() as connection:
        before = connection.execute(
            text("""SELECT connection_generation
            FROM user_external_connector_connections
            WHERE user_id='owner' AND connector_id='google_drive'""")
        ).scalar_one()
        assert (
            connection.execute(text("SELECT count(*) FROM drive_packet_versions")).scalar_one() > 0
        )
        lock_connection_graph_users(connection, user_ids=["owner"])
        erase_drive_account_in_transaction(connection, user_id="owner", permanent=False)
        for table in (
            "drive_packet_heads",
            "drive_packet_members",
            "drive_packet_versions",
            "drive_packet_version_sources",
            "drive_packet_listings",
        ):
            assert connection.exec_driver_sql(f"SELECT count(*) FROM {table}").scalar_one() == 0
        row = (
            connection.execute(
                text("""SELECT status,connection_generation
            FROM user_external_connector_connections
            WHERE user_id='owner' AND connector_id='google_drive'""")
            )
            .mappings()
            .one()
        )
        assert row["status"] == "revoked" and row["connection_generation"] == before + 1


async def test_expired_fact_lease_cannot_commit_after_reclaim(reusable):
    await originals(reusable)
    await reusable.facts.enqueue(user_id="owner", policy_version=POLICY)
    old = await reusable.facts.claim(user_id="owner", policy_version=POLICY)
    with reusable.facts.db.engine.begin() as connection:
        connection.execute(
            text(
                "UPDATE drive_document_facts SET lease_expires_at=clock_timestamp()-interval '1 second'"
            )
        )
    new = await reusable.facts.claim(user_id="owner", policy_version=POLICY)
    assert old["lease_id"] != new["lease_id"]
    pages = [{"page": 1, "text": "Synthetic statement evidence"}]
    with pytest.raises(DriveReadError, match="facts_superseded"):
        await reusable.facts.commit_batch(
            old, page_facts=page_facts(pages), document_facts=document_facts(pages)
        )
    await reusable.facts.commit_batch(
        new, page_facts=page_facts(pages), document_facts=document_facts(pages)
    )


async def test_listing_deny_and_connection_revocation_remove_buyer_access(reusable):
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
    await reusable.packets.set_listing(
        user_id="owner",
        packet_id=packet["packetId"],
        version=1,
        decision="deny",
        price_cents=125,
        expected_revision=1,
        disclosure=None,
    )
    assert (await reusable.packets.list_packets(user_id="recipient", owner_user_id="owner"))[
        "packets"
    ] == []
    with reusable.facts.db.engine.begin() as connection:
        connection.execute(text("UPDATE connections SET status='revoked'"))
    with pytest.raises(DriveSharingError, match="connection_required"):
        await reusable.packets.list_packets(user_id="recipient", owner_user_id="owner")


@pytest.mark.parametrize("change", ["pause", "generation"])
async def test_packet_lease_fences_late_construction_after_authority_change(reusable, change):
    await originals(reusable)
    await reusable.worker.run_facts_one(user_id="owner")
    job = await reusable.packets.claim_packet(user_id="owner", policy_version=POLICY)
    assert job
    if change == "pause":
        await reusable.collection.set_processing(user_id="owner", enabled=False)
    else:
        with reusable.facts.db.engine.begin() as connection:
            connection.execute(
                text(
                    "UPDATE user_external_connector_connections SET connection_generation=connection_generation+1 WHERE user_id='owner'"
                )
            )
    with pytest.raises(DriveReadError):
        await reusable.packets.commit_build(
            job, build={"assessment": {}}, after_document_id=None, phase="verify"
        )
    with reusable.facts.db.engine.connect() as connection:
        assert (
            connection.execute(text("SELECT count(*) FROM drive_packet_versions")).scalar_one() == 0
        )


async def test_migration_replay_and_rollback_preserve_frozen_manifest(reusable):
    packet = await ready_packet(reusable)
    with reusable.facts.db.engine.connect() as connection:
        before = (
            connection.execute(text("SELECT manifest_envelope,digest FROM drive_packet_versions"))
            .mappings()
            .one()
        )
        connection.exec_driver_sql(
            (MIGRATIONS / "334_drive_reusable_packets.sql").read_text(),
            execution_options={"no_parameters": True},
        )
        connection.exec_driver_sql(
            (MIGRATIONS / "rollback/334_drive_reusable_packets.rollback.sql").read_text(),
            execution_options={"no_parameters": True},
        )
        after = (
            connection.execute(
                text("SELECT manifest_envelope,digest,available FROM drive_packet_versions")
            )
            .mappings()
            .one()
        )
    assert (
        after["manifest_envelope"] == before["manifest_envelope"]
        and after["digest"] == before["digest"]
    )
    assert not after["available"]
    assert packet["version"] == 1


async def test_catalog_collection_rejects_facts_for_prior_extraction_version(reusable):
    await ready_packet(reusable)
    with reusable.facts.db.engine.begin() as connection:
        assert reusable.packets._collection_complete(connection, "owner", 1, POLICY)
        assert reusable.packets._collection_settled(connection, "owner", 1, POLICY)
        connection.execute(text("UPDATE connected_documents SET active_version='new-extraction'"))
        assert not reusable.packets._collection_complete(connection, "owner", 1, POLICY)
        assert not reusable.packets._collection_settled(connection, "owner", 1, POLICY)
