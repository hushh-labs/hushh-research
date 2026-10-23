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
from hushh_mcp.services.drive_sharing_retention import erase_drive_account_in_transaction
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
        "temporal_scope": "no_period_claim",
        "gaps": [] if complete else ["More evidence remains"],
        "assessment_score": 91,
        "importance": 120,
        "standalone_value": "supported",
        "utility_rationale": "A standalone synthetic statement packet for test recipients",
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
        "correct_record_status": True,
        "correct_standalone_value": True,
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
        connection.exec_driver_sql(
            (MIGRATIONS / "411_drive_period_packets.sql").read_text(),
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


async def owner_originals(reusable, user_id, count):
    """Extracted synthetic originals for one more connected live-Drive owner."""
    from hushh_mcp.services.drive_collection_store import COLLECTION_DISCLOSURE

    with reusable.collection.db.engine.begin() as connection:
        connection.execute(
            text("""INSERT INTO user_external_connector_connections
              (user_id,connector_id,connection_generation,status,validation_state,verified_policy_hash)
              SELECT :user,'google_drive',1,'connected','verified',verified_policy_hash
              FROM user_external_connector_connections
              WHERE user_id='owner' AND connector_id='google_drive'
              ON CONFLICT DO NOTHING"""),
            {"user": user_id},
        )
    await reusable.collection.set_processing(
        user_id=user_id, enabled=True, disclosure=COLLECTION_DISCLOSURE
    )
    sync = await reusable.collection.claim(user_id=user_id)
    files = [source(f"{user_id}-synthetic-source-{n}") for n in range(count)]
    await reusable.collection.commit_page(
        sync,
        checkpoint={"changes_token": "synthetic-start"},
        files=files,
        phase="changes",
        caught_up=True,
    )
    for _ in files:
        job = await reusable.ingestion.claim(user_id=user_id, generation=1)
        metadata = next(
            item
            for item in files
            if reusable.collection.cipher.fingerprint(user_id, item.file_id)
            == job["source_fingerprint"]
        )
        await reusable.ingestion.publish_pages(job, metadata=metadata, batch=collection_pages())


def facts_done(reusable):
    with reusable.facts.db.engine.connect() as connection:
        return dict(
            connection.execute(
                text("""SELECT user_id,count(*) FROM drive_document_facts
                  WHERE status='complete' GROUP BY user_id""")
            ).all()
        )


def held_pages(reusable, expected, leases, after=None):
    """Hold page facts until `expected` jobs run at once, then record their leases."""
    all_running = asyncio.Event()
    state = {"in_flight": 0, "peak": 0}

    async def assess(**kwargs):
        state["in_flight"] += 1
        state["peak"] = max(state["peak"], state["in_flight"])
        if state["in_flight"] == expected:
            with reusable.facts.db.engine.connect() as connection:
                leases.extend(
                    connection.execute(
                        text("""SELECT user_id,document_id FROM drive_document_facts
                          WHERE status='running' AND lease_expires_at>clock_timestamp()""")
                    ).all()
                )
            all_running.set()
        try:
            # A schedule that never reaches `expected` proceeds after the wait.
            # The wait ends as soon as it is reached, so a loaded runner only
            # needs the headroom, never pays for it.
            await asyncio.wait_for(all_running.wait(), timeout=10)
            if after is not None:
                await asyncio.wait_for(after.wait(), timeout=10)
        except TimeoutError:
            pass
        state["in_flight"] -= 1
        return await assess_pages(**kwargs)

    return assess, state


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


async def test_owner_list_names_its_own_files_and_buyers_never_receive_them(reusable, monkeypatch):
    packet = await ready_packet(reusable)
    # Internal callers (request matching) never pay for or carry file names.
    assert "contents" not in packet
    listing = await reusable.packets.list_packets(user_id="owner", owner_contents=True)
    packet = listing["packets"][0]
    assert packet["contents"] == {
        "period": None,
        "documents": [
            {"name": "Private synthetic filename", "type": "statement", "pages": 1, "period": None}
        ],
    }
    await reusable.packets.set_listing(
        user_id="owner",
        packet_id=packet["packetId"],
        version=1,
        decision="allow",
        price_cents=125,
        expected_revision=0,
        disclosure=LISTING_DISCLOSURE,
    )
    # Even when asked, a buyer's list never carries the owner's files.
    buyer = await reusable.packets.list_packets(
        user_id="recipient", owner_user_id="owner", owner_contents=True
    )
    assert buyer["packets"] and all("contents" not in item for item in buyer["packets"])
    assert "Private synthetic filename" not in json.dumps(buyer)
    # Waiting for a policy recheck: its own file names stay, stale model readings do not.
    monkeypatch.setattr(
        "hushh_mcp.services.drive_packet_intelligence.facts_policy_version",
        lambda: "new-facts-policy",
    )
    listing = await reusable.packets.list_packets(user_id="owner", owner_contents=True)
    owner = listing["packets"][0]
    assert owner["title"] == "Packet being checked"
    assert owner["contents"] == {
        "period": None,
        "documents": [
            {"name": "Private synthetic filename", "type": None, "pages": 1, "period": None}
        ],
    }


def test_owner_contents_text_and_dates_are_plain():
    from hushh_mcp.services.drive_packet_store import _plain, _span

    assert _plain(" Example\x00 Bank\n statement.pdf ", 120) == "Example Bank statement.pdf"
    assert _plain("x" * 200, 120) == "x" * 120 and _plain("\x07 ", 120) is None
    assert _plain(None, 120) is None
    assert _span(
        [
            {"start": "20260201", "end": "2026-02-28"},
            {"start": "2026-01-01", "end": "2026-01-31"},
            {"start": "Jan", "end": "2026-03-01"},
        ]
    ) == {"start": "2026-01-01", "end": "2026-02-28"}
    assert _span([]) is None and _span(None) is None


async def test_extraction_profile_upgrade_fences_old_packet_before_reprocessing(
    reusable, monkeypatch
):
    packet = await ready_packet(reusable)
    assert packet["canList"]
    monkeypatch.setattr(
        "hushh_mcp.services.drive_packet_store.EXTRACTION_PROFILE", "future-extraction-profile"
    )
    owner = (await reusable.packets.list_packets(user_id="owner"))["packets"][0]
    assert owner["state"] == "ready" and not owner["canList"]
    with pytest.raises(DriveReadError, match="packet_unavailable"):
        await reusable.packets.current_packet_manifest(
            owner_user_id="owner", packet_id=packet["packetId"], version=packet["version"]
        )


async def test_new_facts_policy_hides_prior_ready_listing_until_rechecked(reusable, monkeypatch):
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
    assert (await reusable.packets.list_packets(user_id="recipient", owner_user_id="owner"))[
        "packets"
    ]
    with reusable.facts.db.engine.connect() as connection:
        saved_version = dict(
            connection.execute(
                text("SELECT manifest_envelope,digest,available FROM drive_packet_versions")
            )
            .mappings()
            .one()
        )
    monkeypatch.setattr(
        "hushh_mcp.services.drive_packet_intelligence.facts_policy_version",
        lambda: "new-facts-policy",
    )
    owner = (await reusable.packets.list_packets(user_id="owner"))["packets"][0]
    assert owner["state"] == "incomplete" and not owner["canList"]
    assert owner["title"] == "Packet being checked"
    assert owner["coverageSummary"] == "Coverage is being checked."
    assert owner["description"] == "Current source evidence is being checked."
    assert owner["verifiedAt"] is None and not owner["listingEnabled"]
    assert (await reusable.packets.list_packets(user_id="recipient", owner_user_id="owner"))[
        "packets"
    ] == []
    with reusable.facts.db.engine.connect() as connection:
        assert (
            dict(
                connection.execute(
                    text("SELECT manifest_envelope,digest,available FROM drive_packet_versions")
                )
                .mappings()
                .one()
            )
            == saved_version
        )
    with pytest.raises(DriveReadError, match="packet_unavailable"):
        await reusable.packets.current_packet_manifest(
            owner_user_id="owner", packet_id=packet["packetId"], version=1
        )


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


@pytest.mark.parametrize("discovering", [False, True])
async def test_progressive_packets_do_not_wait_for_unrelated_indexing(reusable, discovering):
    await originals(reusable, 2)
    assert await reusable.worker.run_facts_one(user_id="owner") == "facts_complete"
    if discovering:
        with reusable.facts.db.engine.begin() as connection:
            connection.execute(
                text("""UPDATE drive_collection_sync SET phase='bootstrap',
                  initial_completed_at=NULL,last_synced_at=NULL""")
            )

    # One current document can produce a packet while another still lacks facts.
    # The old collection-settled gate returned idle for every attempt here.
    for _ in range(3):
        result = await reusable.worker.run_packet_one(user_id="owner")
    assert result == "ready"
    view = (await reusable.packets.list_packets(user_id="owner"))["packets"][0]
    assert view["state"] == "ready" and view["documentCount"] == 1
    assert view["canList"] is not discovering
    assert not view["listingEnabled"]
    assert view["freshness"] == ("stale" if discovering else "current")
    with reusable.facts.db.engine.connect() as connection:
        row = connection.execute(text("SELECT * FROM drive_packet_versions")).mappings().one()
        manifest = reusable.packets._manifest(row)
    assert not manifest["collection_complete"]
    assert manifest["coverage_scope"] == "verified_observed_span"
    assert len(manifest["sources"]) == 1

    if discovering:
        with pytest.raises(DriveReadError, match="packet_unavailable"):
            await reusable.packets.current_packet_manifest(
                owner_user_id="owner", packet_id=view["packetId"], version=1
            )
        with reusable.facts.db.engine.begin() as connection:
            connection.execute(
                text("""UPDATE drive_collection_sync SET phase='changes',
                  initial_completed_at=clock_timestamp(),last_synced_at=clock_timestamp()""")
            )
        recovered = (await reusable.packets.list_packets(user_id="owner"))["packets"][0]
        assert recovered["canList"] and recovered["version"] == 1


@pytest.mark.parametrize(
    "change", ["stale", "revoked", "paused", "incomplete", "provider_error", "bootstrap"]
)
async def test_ready_packet_listing_uses_provider_freshness_while_extraction_pending(
    reusable, change
):
    files = [source("verified-source"), source("unrelated-pending-source")]
    await seed_collection(reusable.collection, files=files)
    job = await reusable.ingestion.claim(user_id="owner", generation=1)
    metadata = next(
        item
        for item in files
        if reusable.collection.cipher.fingerprint("owner", item.file_id)
        == job["source_fingerprint"]
    )
    await reusable.ingestion.publish_pages(job, metadata=metadata, batch=collection_pages())
    with reusable.facts.db.engine.connect() as connection:
        sync = connection.execute(text("SELECT * FROM drive_collection_sync")).mappings().one()
        assert sync["initial_completed_at"] is None
        assert sync["phase"] == "changes" and sync["last_synced_at"] is not None
        assert (
            connection.execute(
                text("SELECT count(*) FROM connected_documents WHERE status='queued'")
            ).scalar_one()
            == 1
        )
    assert await reusable.worker.run_facts_one(user_id="owner") == "facts_complete"
    for _ in range(3):
        result = await reusable.worker.run_packet_one(user_id="owner")
    assert result == "ready"
    view = (await reusable.packets.list_packets(user_id="owner"))["packets"][0]
    assert view["canList"] and view["freshness"] == "current" and view["documentCount"] == 1
    assert "Other Drive files remain unverified" in view["description"]
    manifest = await reusable.packets.current_packet_manifest(
        owner_user_id="owner", packet_id=view["packetId"], version=1
    )
    assert not manifest["collection_complete"]
    assert manifest["coverage_scope"] == "verified_observed_span"
    assert len(manifest["sources"]) == 1
    await reusable.packets.set_listing(
        user_id="owner",
        packet_id=view["packetId"],
        version=1,
        decision="allow",
        price_cents=125,
        expected_revision=0,
        disclosure=LISTING_DISCLOSURE,
    )

    if change == "paused":
        await reusable.collection.set_processing(user_id="owner", enabled=False)
    else:
        statements = {
            "stale": "UPDATE drive_collection_sync SET last_synced_at=clock_timestamp()-interval '901 seconds'",
            "revoked": """UPDATE connected_documents SET active_version=NULL,status='unsupported',
                last_error_code='source_unavailable',processing_enabled=false
                WHERE document_id=:id""",
            "incomplete": "UPDATE drive_collection_sync SET incomplete_search=true",
            "provider_error": "UPDATE drive_collection_sync SET last_error_code='provider_unavailable'",
            "bootstrap": "UPDATE drive_collection_sync SET phase='bootstrap'",
        }
        with reusable.facts.db.engine.begin() as connection:
            connection.execute(text(statements[change]), {"id": job["document_id"]})
    blocked = (await reusable.packets.list_packets(user_id="owner"))["packets"][0]
    assert not blocked["canList"]
    assert blocked["freshness"] == ("paused" if change == "paused" else "stale")
    with pytest.raises(DriveReadError):
        await reusable.packets.current_packet_manifest(
            owner_user_id="owner", packet_id=view["packetId"], version=1
        )
    with pytest.raises(DriveReadError):
        await reusable.packets.set_listing(
            user_id="owner",
            packet_id=view["packetId"],
            version=1,
            decision="allow",
            price_cents=125,
            expected_revision=1,
            disclosure=LISTING_DISCLOSURE,
        )


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


@pytest.mark.parametrize("failed_check", ["no_unrelated_inclusions", "correct_record_status"])
async def test_independent_checker_failure_prevents_ready_and_listing(reusable, failed_check):
    await originals(reusable)
    await reusable.worker.run_facts_one(user_id="owner")

    async def negative(**kwargs):
        return (await check(**kwargs)) | {
            "state": "incomplete",
            failed_check: False,
            "issues": ["Independent evidence check failed"],
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


@pytest.mark.parametrize("erasure", ["connector", "reset"])
async def test_reference_fk_does_not_block_connector_deletion_or_mutate_request_terms(
    reusable, sharing, erasure
):
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
        generation = connection.execute(
            text(
                "SELECT connection_generation FROM user_external_connector_connections WHERE user_id='owner' AND connector_id='google_drive'"
            )
        ).scalar_one()
        connection.execute(text("UPDATE drive_packet_heads SET dirty=TRUE WHERE user_id='owner'"))
    late_job = await reusable.packets.claim_packet(user_id="owner", policy_version=POLICY)
    assert late_job
    with reusable.facts.db.engine.begin() as connection:
        if erasure == "reset":
            erase_drive_account_in_transaction(
                connection, user_id="owner", permanent=False, cipher=sharing.cipher
            )
        else:
            connection.execute(
                text(
                    "DELETE FROM user_external_connector_connections WHERE user_id='owner' AND connector_id='google_drive'"
                )
            )
        for table in (
            "drive_packet_heads",
            "drive_packet_members",
            "drive_packet_versions",
            "drive_packet_version_sources",
            "drive_packet_listings",
        ):
            assert connection.execute(text(f"SELECT count(*) FROM {table}")).scalar_one() == 0
        if erasure == "reset":
            state = connection.execute(
                text(
                    "SELECT status, connection_generation FROM user_external_connector_connections WHERE user_id='owner' AND connector_id='google_drive'"
                )
            ).one()
            assert state.status == "revoked" and state.connection_generation == generation + 1
        row = (
            connection.execute(
                text(
                    "SELECT request_envelope,reusable_packet_id,reusable_packet_version FROM drive_share_requests WHERE request_id=:id"
                ),
                {"id": created["requestId"]},
            )
            .mappings()
            .one_or_none()
        )
    if erasure == "connector":
        assert row["request_envelope"] == before
        assert row["reusable_packet_id"] is None and row["reusable_packet_version"] is None
    else:
        assert row is None
    with pytest.raises(DriveReadError):
        await reusable.packets.commit_build(
            late_job, build={"assessment": {}}, after_document_id=None, phase="verify"
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


async def test_semantic_worker_uses_default_on_preference_but_preserves_explicit_off(reusable):
    await originals(reusable)
    with reusable.facts.db.engine.begin() as connection:
        connection.execute(text("DELETE FROM drive_live_preferences WHERE user_id='owner'"))
    assert await reusable.facts.due_owners() == ["owner"]
    assert await reusable.worker.run_facts_one(user_id="owner") == "facts_complete"
    with reusable.facts.db.engine.begin() as connection:
        connection.execute(
            text(
                "INSERT INTO drive_live_preferences(user_id,connection_generation,background_enabled) VALUES('owner',1,false)"
            )
        )
    assert await reusable.facts.due_owners() == []


async def test_rejected_model_evidence_retries_with_backoff_then_fails_without_publishing(
    reusable,
):
    from hushh_mcp.services.drive_document_facts_store import FACTS_MAX_ATTEMPTS
    from hushh_mcp.services.drive_packet_intelligence import EvidenceValidationError

    await originals(reusable)
    reusable.worker.page_assessor = AsyncMock(
        side_effect=EvidenceValidationError("model_citation_invalid")
    )
    delays = []
    for attempt in range(1, FACTS_MAX_ATTEMPTS + 1):
        assert await reusable.worker.run_facts_one(user_id="owner") == "facts_unavailable"
        with reusable.facts.db.engine.begin() as connection:
            row = connection.execute(
                text("""SELECT status,error_code,facts_envelope,lease_id,
                  extract(epoch FROM next_at-updated_at) AS delay FROM drive_document_facts""")
            ).one()
            # A sampled model answer can differ next time; host-rejected
            # evidence is never stored, and retries stay bounded.
            assert row.status == ("failed" if attempt == FACTS_MAX_ATTEMPTS else "pending")
            assert row.error_code == "model_citation_invalid"
            assert row.facts_envelope is None and row.lease_id is None
            delays.append(round(row.delay))
            connection.execute(text("UPDATE drive_document_facts SET next_at=clock_timestamp()"))
    assert delays[:2] == [60, 120]
    assert await reusable.worker.run_facts_one(user_id="owner") == "idle"
    assert reusable.worker.page_assessor.await_count == FACTS_MAX_ATTEMPTS
    with reusable.facts.db.engine.connect() as connection:
        assert connection.execute(text("SELECT count(*) FROM drive_packet_heads")).scalar_one() == 0


async def test_deterministic_facts_integrity_failure_is_terminal_at_once(reusable):
    await originals(reusable)
    reusable.worker.page_assessor = AsyncMock(side_effect=ValueError("private detail"))
    assert await reusable.worker.run_facts_one(user_id="owner") == "facts_unavailable"
    with reusable.facts.db.engine.connect() as connection:
        failure = connection.execute(
            text("SELECT status,error_code FROM drive_document_facts")
        ).one()
    assert (failure.status, failure.error_code) == ("failed", "facts_integrity_invalid")


@pytest.mark.parametrize(
    "failure,code,stage",
    [
        ("citation", "model_citation_invalid", "construct_packet"),
        ("membership", "model_membership_invalid", "verify_members"),
        ("source", "packet_source_changed", "load_member_evidence"),
        ("timeout", "model_timeout", "construct_packet"),
        ("storage", "connector_storage_unavailable", "persist_packet_build"),
        ("unexpected", "packet_unavailable", "construct_packet"),
        ("unsafe_model", "packet_unavailable", "construct_packet"),
        ("unsafe_source", "packet_unavailable", "construct_packet"),
        ("invalid", "packet_integrity_invalid", "construct_packet"),
    ],
)
async def test_packet_failures_keep_safe_diagnostics_and_retry_behavior(
    reusable, caplog, failure, code, stage
):
    from hushh_mcp.services.drive_packet_intelligence import EvidenceValidationError
    from hushh_mcp.services.external_connector_lifecycle_store import ConnectorLifecycleError

    secret = "private-document-text-and-secret-token"
    errors = {
        "citation": EvidenceValidationError("model_citation_invalid"),
        "membership": EvidenceValidationError("model_membership_invalid"),
        "source": DriveReadError("packet_source_changed"),
        "timeout": TimeoutError(secret),
        "storage": ConnectorLifecycleError(secret),
        "unexpected": RuntimeError(secret),
        "unsafe_model": EvidenceValidationError(secret),
        "unsafe_source": DriveReadError(secret),
        "invalid": ValueError(secret),
    }
    error = errors[failure]
    await originals(reusable)
    assert await reusable.worker.run_facts_one(user_id="owner") == "facts_complete"
    if failure == "membership":
        assert await reusable.worker.run_packet_one(user_id="owner") == "packet_queued"
        reusable.worker.checker = AsyncMock(side_effect=error)
    elif failure == "source":
        reusable.packets.evidence_page = AsyncMock(side_effect=error)
    elif failure == "storage":
        reusable.packets.commit_build = AsyncMock(side_effect=error)
    else:
        reusable.worker.constructor = AsyncMock(side_effect=error)
    caplog.clear()
    assert await reusable.worker.run_packet_one(user_id="owner") == "packet_unavailable"
    with reusable.facts.db.engine.connect() as connection:
        row = (
            connection.execute(
                text(
                    "SELECT *,extract(epoch FROM next_at-updated_at) AS delay FROM drive_packet_heads"
                )
            )
            .mappings()
            .one()
        )
        assert row["error_code"] == code and row["dirty"]
        assert row["lease_id"] is None and row["lease_expires_at"] is None
        assert row["delay"] == pytest.approx(3600 if isinstance(error, ValueError) else 60, abs=0.1)
        assert (
            connection.execute(text("SELECT count(*) FROM drive_packet_versions")).scalar_one() == 0
        )
    messages = [
        record.getMessage()
        for record in caplog.records
        if "drive_packet_failed" in record.getMessage()
    ]
    assert len(messages) == 1
    assert f"stage={stage} code={code}" in messages[0]
    # A successful phase commit resets the next phase's retry counter.
    assert "attempt=1" in messages[0]
    assert "elapsed_ms=" in messages[0]
    assert secret not in caplog.text


async def test_packet_claim_failure_is_logged_without_changing_exception_or_exposing_text(
    caplog, monkeypatch
):
    from hushh_mcp.services.external_connector_lifecycle_store import ConnectorLifecycleError

    admission = AsyncMock()
    monkeypatch.setattr("hushh_mcp.services.drive_packet_worker.admit_hub_content", admission)
    secret = "private-sql-parameters-and-token"
    error = ConnectorLifecycleError(secret)
    store = SimpleNamespace(claim_packet=AsyncMock(side_effect=error), release_packet=AsyncMock())
    worker = DrivePacketWorker(
        facts_store=SimpleNamespace(), packet_store=store, policy=lambda: POLICY
    )
    with pytest.raises(ConnectorLifecycleError) as captured:
        await worker.run_packet_one(user_id="private-owner-id")
    assert captured.value is error
    admission.assert_awaited_once_with(
        "private-owner-id", "drive_packet_build_claim", resolve_mode=None
    )
    store.release_packet.assert_not_awaited()
    assert (
        "stage=claim_packet code=connector_storage_unavailable attempt=0 elapsed_ms=" in caplog.text
    )
    assert secret not in caplog.text and "private-owner-id" not in caplog.text


async def test_packet_release_rejects_untrusted_failure_code(reusable):
    await originals(reusable)
    assert await reusable.worker.run_facts_one(user_id="owner") == "facts_complete"
    job = await reusable.packets.claim_packet(user_id="owner", policy_version=POLICY)
    await reusable.packets.release_packet(job, code="private-document-or-token")
    with reusable.facts.db.engine.connect() as connection:
        assert (
            connection.execute(text("SELECT error_code FROM drive_packet_heads")).scalar_one()
            == "packet_unavailable"
        )


async def test_owner_name_on_file_is_read_for_the_wrong_person_fence(reusable):
    # An isolated schema has no identity cache: the listing is empty, not a stall.
    assert await reusable.packets.owner_identity(user_id="owner") == {"names": []}
    with reusable.facts.db.engine.begin() as connection:
        connection.exec_driver_sql(
            "CREATE TABLE actor_identity_cache (user_id TEXT PRIMARY KEY, display_name TEXT)"
        )
        connection.exec_driver_sql(
            "INSERT INTO actor_identity_cache VALUES ('owner', ' Synthetic Owner '), ('blank', ' ')"
        )
    assert await reusable.packets.owner_identity(user_id="owner") == {"names": ["Synthetic Owner"]}
    assert await reusable.packets.owner_identity(user_id="blank") == {"names": []}
    assert await reusable.packets.owner_identity(user_id="nobody") == {"names": []}
    # Every packet job reads the name and the build still finishes; these
    # synthetic facts name nobody, so the fence leaves the Ready verdict alone.
    assert (await ready_packet(reusable))["packetId"]


async def test_last_member_removal_retires_work_and_preserves_frozen_history(reusable, sharing):
    from hushh_mcp.services.drive_packet_contract import DocumentFacts

    packet = await ready_packet(reusable, 2)
    created = await request(sharing)
    with reusable.facts.db.engine.begin() as connection:
        connection.execute(
            text(
                "UPDATE drive_share_requests SET reusable_packet_id=:packet,reusable_packet_version=1 WHERE request_id=:request"
            ),
            {"packet": packet["packetId"], "request": created["requestId"]},
        )
        before = connection.execute(
            text("SELECT manifest_envelope,digest FROM drive_packet_versions")
        ).one()
        rows = (
            connection.execute(text("SELECT * FROM drive_document_facts ORDER BY document_id"))
            .mappings()
            .all()
        )
        reusable.packets._authority(connection, user_id="owner")
        for index, row in enumerate(rows):
            facts = DocumentFacts.model_validate(reusable.facts.facts(dict(row)))
            facts.canonical_packets = []
            reusable.packets.update_membership_locked(connection, row, facts)
            head = connection.execute(text("SELECT * FROM drive_packet_heads")).mappings().one()
            assert head["dirty"] is (index == 0)
        assert not head["awaiting_collection"] and head["lease_id"] is None
        assert (
            connection.execute(
                text("SELECT manifest_envelope,digest FROM drive_packet_versions")
            ).one()
            == before
        )
        assert (
            connection.execute(text("SELECT available FROM drive_packet_versions")).scalar_one()
            is False
        )
        assert (
            connection.execute(
                text("SELECT count(*) FROM drive_packet_version_sources")
            ).scalar_one()
            == 2
        )
        bound = connection.execute(
            text("SELECT reusable_packet_id,reusable_packet_version FROM drive_share_requests")
        ).one()
        assert (
            str(bound.reusable_packet_id) == packet["packetId"]
            and bound.reusable_packet_version == 1
        )
    reusable.worker.constructor = AsyncMock(
        side_effect=AssertionError("retired packet invoked model")
    )
    assert await reusable.worker.run_packet_one(user_id="owner") == "idle"
    reusable.worker.constructor.assert_not_awaited()
    assert (await reusable.packets.list_packets(user_id="owner"))["packets"] == []
    with pytest.raises(DriveReadError, match="packet_unavailable"):
        await reusable.packets.current_packet_manifest(
            owner_user_id="owner", packet_id=packet["packetId"], version=1
        )


async def test_legacy_empty_packet_is_hidden_and_retired_without_model_work(reusable):
    packet = await ready_packet(reusable)
    with reusable.facts.db.engine.begin() as connection:
        connection.execute(text("DELETE FROM drive_packet_members"))
        connection.execute(
            text(
                "UPDATE drive_packet_heads SET dirty=TRUE,awaiting_collection=TRUE,build_phase='finalize'"
            )
        )
        before = connection.execute(
            text("SELECT manifest_envelope,digest FROM drive_packet_versions")
        ).one()
    assert (await reusable.packets.list_packets(user_id="owner"))["packets"] == []
    with pytest.raises(DriveReadError, match="packet_unavailable"):
        await reusable.packets.current_packet_manifest(
            owner_user_id="owner", packet_id=packet["packetId"], version=1
        )
    reusable.worker.constructor = AsyncMock(
        side_effect=AssertionError("empty packet invoked model")
    )
    reusable.worker.checker = AsyncMock(side_effect=AssertionError("empty packet invoked model"))
    assert await reusable.worker.run_packet_one(user_id="owner") == "idle"
    reusable.worker.constructor.assert_not_awaited()
    reusable.worker.checker.assert_not_awaited()
    with reusable.facts.db.engine.connect() as connection:
        head = connection.execute(text("SELECT * FROM drive_packet_heads")).mappings().one()
        assert not head["dirty"] and not head["awaiting_collection"] and head["lease_id"] is None
        assert (
            connection.execute(
                text("SELECT manifest_envelope,digest FROM drive_packet_versions")
            ).one()
            == before
        )
        assert (
            connection.execute(text("SELECT available FROM drive_packet_versions")).scalar_one()
            is False
        )
    assert await reusable.worker.run_packet_one(user_id="owner") == "idle"
    with reusable.facts.db.engine.connect() as connection:
        assert (
            connection.execute(text("SELECT revision FROM drive_packet_heads")).scalar_one()
            == head["revision"]
        )


async def test_empty_head_cleanup_is_bounded_and_does_not_block_current_packet(reusable):
    from uuid import uuid4

    from hushh_mcp.services.drive_document_facts_store import seal_evidence

    await originals(reusable)
    assert await reusable.worker.run_facts_one(user_id="owner") == "facts_complete"
    with reusable.facts.db.engine.begin() as connection:
        current = connection.execute(text("SELECT * FROM drive_packet_heads")).mappings().one()
        for index in range(34):
            row = {**current, "packet_id": uuid4()}
            connection.execute(
                text("""INSERT INTO drive_packet_heads(packet_id,user_id,connection_generation,key_fingerprint,key_envelope)
                VALUES(:id,'owner',1,:fingerprint,CAST(:envelope AS jsonb))"""),
                {
                    "id": row["packet_id"],
                    "fingerprint": str(uuid4()),
                    "envelope": seal_evidence(
                        reusable.packets.cipher,
                        reusable.packets._packet_identity(row, "key"),
                        {
                            "key": f"retired-{index}",
                            "title": "Retired",
                            "description": "Retired empty test group",
                        },
                    ),
                },
            )
    claimed = await reusable.packets.claim_packet(user_id="owner", policy_version=POLICY)
    assert claimed["packet_id"] == current["packet_id"] and claimed["member_count"] == 1
    with reusable.facts.db.engine.connect() as connection:
        assert (
            connection.execute(
                text("""SELECT count(*) FROM drive_packet_heads h WHERE dirty
            AND NOT EXISTS(SELECT 1 FROM drive_packet_members m WHERE m.packet_id=h.packet_id)""")
            ).scalar_one()
            == 2
        )


async def test_zero_selected_document_abstention_is_retained_but_not_a_catalog_packet(reusable):
    await originals(reusable)
    assert await reusable.worker.run_facts_one(user_id="owner") == "facts_complete"

    async def abstain(**kwargs):
        assessment = await construct(**kwargs)
        assessment.update(
            state="unable_to_verify",
            selected_document_ids=[],
            excluded_documents=[
                {
                    "document_id": document["document_id"],
                    "reason": "unverifiable",
                    "explanation": "Cannot establish useful verified evidence.",
                }
                for document in kwargs["documents"]
            ],
        )
        return assessment

    async def cannot_verify(**kwargs):
        return {
            **await check(**kwargs),
            "state": "unable_to_verify",
            "correct_coverage": False,
            "issues": ["No selected documents can be verified."],
        }

    reusable.worker.constructor, reusable.worker.checker = abstain, cannot_verify
    for _ in range(3):
        outcome = await reusable.worker.run_packet_one(user_id="owner")
    assert outcome == "unable_to_verify"
    assert (await reusable.packets.list_packets(user_id="owner"))["packets"] == []
    with reusable.facts.db.engine.connect() as connection:
        row = connection.execute(
            text("SELECT state,document_count,available FROM drive_packet_versions")
        ).one()
        assert row.state == "unable_to_verify" and row.document_count == 0 and not row.available


async def test_canonical_key_context_is_current_bounded_and_owner_private(reusable):
    from uuid import uuid4

    from hushh_mcp.services.drive_document_facts_store import seal_evidence

    date_evidence = {
        "role": "planned_action",
        "start": None,
        "end": None,
        "meaning": "Undated proposed action, not a records coverage window",
        "citations": [{"page": 1, "quote": "Synthetic statement evidence"}],
    }
    record_status = {
        "status": "draft",
        "evidence_basis": "documentary_form",
        "explanation": "Synthetic draft; execution is not established.",
        "citations": [{"page": 1, "quote": "Synthetic statement evidence"}],
    }

    async def assessed_dates(**kwargs):
        return {
            **await assess_pages(**kwargs),
            "date_evidence": [date_evidence],
            "record_status": record_status,
        }

    reusable.worker.page_assessor = assessed_dates
    await ready_packet(reusable)
    context = await reusable.packets.canonical_key_context(user_id="owner", policy_version=POLICY)
    assert len(context["packets"]) == 1 and not context["truncated"]
    assert context["representative_only"] and not context["collection_complete"]
    item = context["packets"][0]
    assert item["key"] == "synthetic-statement-account"
    assert item["representative_document"]["document_type"] == "statement"
    assert item["representative_document"]["date_evidence"] == [
        {key: value for key, value in date_evidence.items() if key != "citations"}
    ]
    assert item["representative_document"]["record_status"] == {
        key: value for key, value in record_status.items() if key != "citations"
    }
    assert "citations" not in json.dumps(item)
    assert (
        await reusable.packets.canonical_key_context(user_id="owner", policy_version="new-policy")
    )["packets"] == []
    with pytest.raises(DriveReadError):
        await reusable.packets.canonical_key_context(user_id="unrelated", policy_version=POLICY)

    with reusable.facts.db.engine.begin() as connection:
        head = connection.execute(text("SELECT * FROM drive_packet_heads")).mappings().one()
        member = connection.execute(text("SELECT * FROM drive_packet_members")).mappings().one()
        for n in range(65):
            candidate = {**head, "packet_id": uuid4()}
            key = {"key": f"bounded-{n}", "title": "Synthetic", "description": "Bounded reference"}
            connection.execute(
                text("""INSERT INTO drive_packet_heads
                    (packet_id,user_id,connection_generation,key_fingerprint,key_envelope)
                    VALUES(:id,'owner',1,:fingerprint,CAST(:envelope AS jsonb))"""),
                {
                    "id": candidate["packet_id"],
                    "fingerprint": str(uuid4()),
                    "envelope": seal_evidence(
                        reusable.packets.cipher,
                        reusable.packets._packet_identity(candidate, "key"),
                        key,
                    ),
                },
            )
            connection.execute(
                text("""INSERT INTO drive_packet_members(packet_id,document_id,facts_version)
                    VALUES(:packet,:document,:facts)"""),
                {
                    "packet": candidate["packet_id"],
                    "document": member["document_id"],
                    "facts": member["facts_version"],
                },
            )
    bounded = await reusable.packets.canonical_key_context(user_id="owner", policy_version=POLICY)
    assert len(bounded["packets"]) == 64 and bounded["truncated"]
    assert len(json.dumps(bounded).encode()) <= 48 * 1024
    with reusable.facts.db.engine.begin() as connection:
        connection.execute(text("UPDATE connected_documents SET active_version='replaced'"))
    assert (await reusable.packets.canonical_key_context(user_id="owner", policy_version=POLICY))[
        "packets"
    ] == []


async def test_completed_document_fold_receives_owner_canonical_context(reusable):
    await originals(reusable)
    capture = AsyncMock(side_effect=fold)
    reusable.worker.consolidator = capture
    assert await reusable.worker.run_facts_one(user_id="owner") == "facts_complete"
    context = capture.await_args.kwargs["canonical_context"]
    assert context == {
        "packets": [],
        "truncated": False,
        "representative_only": True,
        "collection_complete": False,
    }


async def test_same_owner_fact_folds_serialize_and_expired_lease_recovers(reusable, monkeypatch):
    # Under a single-lease cap, an owner's facts jobs still run one at a time.
    monkeypatch.setenv("DRIVE_FACTS_OWNER_LEASES", "1")
    await originals(reusable, count=2)
    assert await reusable.facts.enqueue(user_id="owner", policy_version=POLICY) == 2
    claims = await asyncio.gather(
        reusable.facts.claim(user_id="owner", policy_version=POLICY),
        reusable.facts.claim(user_id="owner", policy_version=POLICY),
    )
    assert sum(job is not None for job in claims) == 1
    leased = next(job for job in claims if job)
    with reusable.facts.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_document_facts
                SET lease_expires_at=clock_timestamp()-interval '1 second'
                WHERE document_id=:id AND facts_version=:version"""),
            {"id": leased["document_id"], "version": leased["facts_version"]},
        )
    recovered = await reusable.facts.claim(user_id="owner", policy_version=POLICY)
    assert recovered is not None and recovered["lease_id"] != leased["lease_id"]
    with pytest.raises(DriveReadError, match="facts_superseded"):
        await reusable.facts.require_current(leased)


async def test_packet_claim_skips_older_policy_head_without_burning_attempts(reusable):
    await originals(reusable, count=2)
    seen = []

    async def separate_fold(**kwargs):
        result = await fold(**kwargs)
        result["canonical_packets"][0]["key"] += str(len(seen))
        seen.append(result)
        return result

    reusable.worker.consolidator = separate_fold
    for _ in range(2):
        assert await reusable.worker.run_facts_one(user_id="owner") == "facts_complete"
    with reusable.facts.db.engine.begin() as connection:
        heads = (
            connection.execute(
                text("""SELECT h.packet_id,m.document_id FROM drive_packet_heads h
                JOIN drive_packet_members m ON m.packet_id=h.packet_id ORDER BY h.created_at""")
            )
            .mappings()
            .all()
        )
        old, current = heads
        connection.execute(
            text("DELETE FROM drive_document_fact_pages WHERE document_id=:id"),
            {"id": old["document_id"]},
        )
        connection.execute(
            text(
                "UPDATE drive_document_facts SET facts_profile='older-policy' WHERE document_id=:id"
            ),
            {"id": old["document_id"]},
        )
    claimed = await reusable.packets.claim_packet(user_id="owner", policy_version=POLICY)
    assert claimed["packet_id"] == current["packet_id"]
    with reusable.facts.db.engine.connect() as connection:
        assert (
            connection.execute(
                text("SELECT attempts FROM drive_packet_heads WHERE packet_id=:id"),
                {"id": old["packet_id"]},
            ).scalar_one()
            == 0
        )


def test_final_duplicate_check_keeps_substantive_differences():
    from hushh_mcp.services.drive_packet_worker import compact_evidence

    a = document_facts([{"page": 1}])
    b = document_facts([{"page": 1}])
    a["facts"] = [{"value": "Trade A: 10 shares", "citations": []}]
    b["facts"] = [{"value": "Trade B: 20 shares", "citations": []}]
    documents = [
        {"document_id": str(n), "source_version": "1", "complete": True, "facts": facts}
        for n, facts in enumerate([a, b])
    ]
    summaries = [compact_evidence(document) for document in documents]
    assert summaries[0]["facts"] == ["Trade A: 10 shares"]
    assert summaries[1]["facts"] == ["Trade B: 20 shares"]


@pytest.mark.parametrize(
    "mode", ["old_key", "old_empty", "current_empty", "no_heads", "source_changed"]
)
async def test_late_old_policy_membership_is_reconciled_from_current_facts(reusable, mode):
    await originals(reusable)
    assert await reusable.facts.enqueue(user_id="owner", policy_version="retired-policy") == 1
    old_job = await reusable.facts.claim(user_id="owner", policy_version="retired-policy")
    if mode == "current_empty":

        async def no_groups(**kwargs):
            result = await fold(**kwargs)
            result["canonical_packets"] = []
            return result

        reusable.worker.consolidator = no_groups
    assert await reusable.worker.run_facts_one(user_id="owner") == "facts_complete"
    pages = [{"page": 1}]
    old_facts = document_facts(pages)
    if mode == "old_empty":
        old_facts["canonical_packets"] = []
    else:
        old_facts["canonical_packets"][0]["key"] = "retired-group"
    await reusable.facts.commit_batch(
        old_job, page_facts=page_facts(pages), document_facts=old_facts
    )
    with reusable.facts.db.engine.begin() as connection:
        original = (
            connection.execute(
                text(
                    "SELECT facts_envelope,updated_at FROM drive_document_facts WHERE facts_profile=:policy"
                ),
                {"policy": POLICY},
            )
            .mappings()
            .one()
        )
        if mode == "no_heads":
            connection.execute(text("DELETE FROM drive_packet_heads"))
        elif mode == "source_changed":
            connection.execute(text("UPDATE connected_documents SET source_version='2'"))
    if mode == "no_heads":
        assert await reusable.facts.due_owners() == ["owner"]
    assert await reusable.facts.enqueue(user_id="owner", policy_version=POLICY) == 0
    with reusable.facts.db.engine.connect() as connection:
        current = (
            connection.execute(
                text(
                    "SELECT facts_version,facts_envelope,updated_at FROM drive_document_facts WHERE facts_profile=:policy"
                ),
                {"policy": POLICY},
            )
            .mappings()
            .one()
        )
        members = (
            connection.execute(text("SELECT facts_version FROM drive_packet_members"))
            .scalars()
            .all()
        )
        assert current["facts_envelope"] == original["facts_envelope"]
        if mode == "source_changed":
            assert current["updated_at"] == original["updated_at"]
            assert members == [old_job["facts_version"]]
            return
        assert members == ([] if mode == "current_empty" else [current["facts_version"]])
        snapshot = connection.execute(
            text("SELECT packet_id,revision,updated_at FROM drive_packet_heads ORDER BY packet_id")
        ).all()
    # No new interpretation, source mutation or repeated packet revision churn.
    assert await reusable.facts.enqueue(user_id="owner", policy_version=POLICY) == 0
    with reusable.facts.db.engine.connect() as connection:
        assert (
            connection.execute(
                text(
                    "SELECT packet_id,revision,updated_at FROM drive_packet_heads ORDER BY packet_id"
                )
            ).all()
            == snapshot
        )
        assert (
            connection.execute(
                text("SELECT updated_at FROM drive_document_facts WHERE facts_profile=:policy"),
                {"policy": POLICY},
            ).scalar_one()
            == current["updated_at"]
        )


async def test_request_priority_facts_use_exact_targets_and_reuse_complete_evidence(
    reusable, monkeypatch
):
    monkeypatch.setenv("DRIVE_FACTS_OWNER_LEASES", "1")
    await originals(reusable, count=3)
    with reusable.collection.db.engine.connect() as connection:
        ids = [
            str(identity)
            for identity in connection.execute(
                text("SELECT document_id FROM connected_documents ORDER BY document_id")
            ).scalars()
        ]
    target = ids[-1]
    assert (
        await reusable.worker.run_facts_one(user_id="owner", document_ids=[target])
        == "facts_complete"
    )
    with reusable.collection.db.engine.connect() as connection:
        rows = list(
            connection.execute(
                text("SELECT document_id,status FROM drive_document_facts")
            ).mappings()
        )
    assert [(str(row["document_id"]), row["status"]) for row in rows] == [(target, "complete")]
    assert await reusable.worker.run_facts_one(user_id="owner", document_ids=[target]) == "idle"
    assert await reusable.facts.enqueue(user_id="owner", policy_version=POLICY) == 2
    claim = await reusable.facts.claim(
        user_id="owner", policy_version=POLICY, document_ids=[ids[1]]
    )
    assert str(claim["document_id"]) == ids[1]
    assert (
        await reusable.facts.claim(user_id="owner", policy_version=POLICY, document_ids=[ids[0]])
        is None
    )
    await reusable.facts.release(claim)
    next_claim = await reusable.facts.claim(user_id="owner", policy_version=POLICY)
    assert str(next_claim["document_id"]) == ids[0]


async def test_targeted_facts_enqueue_scopes_membership_reconciliation(reusable, monkeypatch):
    await originals(reusable, count=2)
    with reusable.collection.db.engine.connect() as connection:
        ids = [
            str(identity)
            for identity in connection.execute(
                text("SELECT document_id FROM connected_documents ORDER BY document_id")
            ).scalars()
        ]
    observed = []
    reconcile = reusable.facts._reconcile_membership_locked

    def scoped_reconcile(connection, **kwargs):
        observed.append(kwargs["document_ids"])
        return reconcile(connection, **kwargs)

    monkeypatch.setattr(reusable.facts, "_reconcile_membership_locked", scoped_reconcile)
    assert (
        await reusable.facts.enqueue(user_id="owner", policy_version=POLICY, document_ids=[ids[0]])
        == 1
    )
    assert observed == [(ids[0],)]
    with reusable.collection.db.engine.connect() as connection:
        rows = [
            str(identity)
            for identity in connection.execute(
                text("SELECT document_id FROM drive_document_facts")
            ).scalars()
        ]
    assert rows == [ids[0]]


@pytest.mark.parametrize("cap,leased", [(4, 4), (1, 1)])
async def test_facts_claims_lease_up_to_owner_cap_on_distinct_documents(
    reusable, monkeypatch, cap, leased
):
    monkeypatch.setenv("DRIVE_FACTS_OWNER_LEASES", str(cap))
    await originals(reusable, count=6)
    assert await reusable.facts.enqueue(user_id="owner", policy_version=POLICY) == 6

    jobs = await asyncio.gather(
        *(reusable.facts.claim(user_id="owner", policy_version=POLICY) for _ in range(5))
    )

    won = [job for job in jobs if job]
    assert len(won) == leased
    assert len({job["document_id"] for job in won}) == leased
    # A committed job frees exactly one slot.
    pages = [{"page": 1, "text": "Synthetic statement evidence"}]
    await reusable.facts.commit_batch(
        won[0], page_facts=page_facts(pages), document_facts=document_facts(pages)
    )
    following = await reusable.facts.claim(user_id="owner", policy_version=POLICY)
    assert following and following["document_id"] not in {job["document_id"] for job in won}
    assert await reusable.facts.claim(user_id="owner", policy_version=POLICY) is None


async def test_running_document_is_not_claimed_again_after_its_source_changes(
    reusable, monkeypatch
):
    from dataclasses import replace

    monkeypatch.setenv("DRIVE_FACTS_OWNER_LEASES", "4")
    await originals(reusable)
    await reusable.facts.enqueue(user_id="owner", policy_version=POLICY)
    running = await reusable.facts.claim(user_id="owner", policy_version=POLICY)
    assert running
    with reusable.facts.db.engine.begin() as connection:
        connection.execute(text("UPDATE drive_collection_sync SET next_at=clock_timestamp()"))
    changed = replace(source("synthetic-source-0"), version="2")
    sync = await reusable.collection.claim(user_id="owner")
    await reusable.collection.commit_page(
        sync, checkpoint={"changes_token": "changed-mid-facts"}, files=[changed], phase="changes"
    )
    job = await reusable.ingestion.claim(user_id="owner", generation=1)
    await reusable.ingestion.publish_pages(job, metadata=changed, batch=collection_pages())
    assert await reusable.facts.enqueue(user_id="owner", policy_version=POLICY) == 1
    # Never two running facts jobs for one document, even across its versions.
    assert await reusable.facts.claim(user_id="owner", policy_version=POLICY) is None
    await reusable.facts.release(running)
    current = await reusable.facts.claim(user_id="owner", policy_version=POLICY)
    assert current and current["document_id"] == running["document_id"]
    assert current["source_version"] == "2"


async def test_semantic_sweep_runs_parallel_facts_with_one_enqueue_per_owner(reusable, monkeypatch):
    monkeypatch.setenv("DRIVE_FACTS_OWNER_LEASES", "4")
    await originals(reusable, count=6)
    enqueue = AsyncMock(side_effect=reusable.facts.enqueue)
    monkeypatch.setattr(reusable.facts, "enqueue", enqueue)
    # Page facts wait until four run at once, instead of a fixed sleep that a
    # loaded runner can outlast while claims are still serialized.
    reusable.worker.page_assessor, held = held_pages(reusable, 4, [])

    result = await reusable.worker.run(max_jobs=6)

    assert result["facts_complete"] == 4
    assert held["peak"] == 4
    enqueue.assert_awaited_once()


async def test_semantic_sweep_gives_every_owner_work_before_parallel_facts(monkeypatch):
    from collections import Counter

    admission = AsyncMock()
    monkeypatch.setattr("hushh_mcp.services.drive_packet_worker.admit_hub_content", admission)
    monkeypatch.setenv("DRIVE_FACTS_OWNER_LEASES", "4")
    monkeypatch.setenv("DRIVE_PACKET_SLOTS", "3")
    facts = SimpleNamespace(
        due_owners=AsyncMock(return_value=["a", "b", "c", "d"]), enqueue=AsyncMock(return_value=0)
    )
    worker = DrivePacketWorker(
        facts_store=facts, packet_store=SimpleNamespace(), policy=lambda: POLICY
    )
    # Least recently served first. Owner a has one file waiting for facts, b
    # and c have more than the cap, and d has only a packet build due.
    waiting = {"a": 1, "b": 9, "c": 9, "d": 0}
    calls = []

    async def facts_one(*, user_id, enqueue):
        assert enqueue is False
        if not waiting[user_id]:
            return "idle"
        waiting[user_id] -= 1
        calls.append(("facts", user_id))
        return "facts_queued"

    async def packet_one(*, user_id):
        if user_id != "d":
            return "idle"
        calls.append(("packet", user_id))
        return "packet_queued"

    worker.run_facts_one, worker.run_packet_one = facts_one, packet_one

    # One packet build for the one owner with a build due; packet slots that
    # found none ran facts instead, so every slot did work.
    assert await worker.run(max_jobs=10) == {"packet_queued": 1, "facts_queued": 9, "idle": 5}
    assert {call.args for call in admission.await_args_list} == {
        (owner, "drive_packet_facts_enqueue") for owner in ("a", "b", "c", "d")
    }
    facts_calls = [user_id for kind, user_id in calls if kind == "facts"]
    # Owner b is never starved by owner a: every owner with facts work gets a
    # job before any owner gets a second, then owners with more work get extra
    # jobs up to the per-owner cap.
    assert facts_calls[:3] == ["a", "b", "c"]
    assert Counter(facts_calls) == {"a": 1, "b": 4, "c": 4}
    assert [call.kwargs["user_id"] for call in facts.enqueue.await_args_list] == [
        "a",
        "b",
        "c",
        "d",
    ]
    facts.due_owners.assert_awaited_once_with(limit=10)


async def test_drain_gives_every_owner_facts_then_extra_jobs_up_to_the_owner_cap(
    reusable, monkeypatch
):
    from collections import Counter

    from hushh_mcp.services.drive_document_worker import DriveDocumentWorker

    owners = ["owner"] + [f"owner-{n}" for n in range(1, 8)]
    monkeypatch.setenv("CONNECTOR_INTERNAL_OWNER_COHORT", ",".join(owners))
    monkeypatch.setenv("DRIVE_FACTS_OWNER_LEASES", "4")
    # Eight owners have facts due. The first, least recently served, has the
    # large backlog. No packet build is due yet.
    await owner_originals(reusable, "owner", 8)
    for user_id in owners[1:]:
        await owner_originals(reusable, user_id, 1)
    expected, leases = 4 + 7, []
    reusable.worker.page_assessor, held = held_pages(reusable, expected, leases)
    worker = DriveDocumentWorker(SimpleNamespace(), packet_worker=reusable.worker)
    worker.due_owners = AsyncMock(return_value=[])
    monkeypatch.setattr("hushh_mcp.services.drive_work_wake.wake_drive_work", AsyncMock())

    result = await worker.run(max_jobs=20, deadline_seconds=160)

    # One drain gave every owner a facts job, then gave the owner with more
    # work extra jobs up to its cap, using the packet slots with no build due.
    per_owner = {"owner": 4, **dict.fromkeys(owners[1:], 1)}
    assert facts_done(reusable) == per_owner
    assert held["peak"] == expected
    assert result["outcomes"]["queued"] == expected
    # Never two running jobs on one document.
    assert Counter(user_id for user_id, _ in leases) == per_owner
    assert len({document_id for _, document_id in leases}) == expected


async def test_packet_builds_use_at_most_their_slots_and_idle_ones_run_facts(reusable, monkeypatch):
    from collections import Counter

    owners = ["owner"] + [f"owner-{n}" for n in range(1, 8)]
    builds = owners[:4]
    monkeypatch.setenv("CONNECTOR_INTERNAL_OWNER_COHORT", ",".join(owners))
    monkeypatch.setenv("DRIVE_FACTS_OWNER_LEASES", "4")
    monkeypatch.setenv("DRIVE_PACKET_SLOTS", "3")
    for user_id in owners:
        await owner_originals(reusable, user_id, 2 if user_id in builds else 1)
    # Four owners each finished one file, so each has a packet build due and
    # one more file waiting for facts. The other four only wait for facts.
    for user_id in builds:
        assert await reusable.worker.run_facts_one(user_id=user_id) == "facts_complete"
    built, packets_built = [], asyncio.Event()
    run_packet_one = reusable.worker.run_packet_one

    async def observed_packet(*, user_id):
        outcome = await run_packet_one(user_id=user_id)
        if outcome != "idle":
            built.append(user_id)
            if len(built) == 3:
                packets_built.set()
        return outcome

    reusable.worker.run_packet_one = observed_packet
    leases = []
    reusable.worker.page_assessor, held = held_pages(
        reusable, len(owners), leases, after=packets_built
    )

    result = await reusable.worker.run(max_jobs=12)

    # At most three packet builds, one per owner, all for owners with one due.
    assert len(built) == len(set(built)) == 3 and set(built) <= set(builds)
    assert result["packet_queued"] == 3
    # The other slots ran one facts job for every owner at once.
    assert held["peak"] == len(owners)
    assert Counter(user_id for user_id, _ in leases) == dict.fromkeys(owners, 1)
    assert result["facts_complete"] == len(owners)
    assert facts_done(reusable) == dict.fromkeys(owners, 1) | dict.fromkeys(builds, 2)


async def test_owners_beyond_one_sweep_are_served_first_in_the_next(reusable, monkeypatch):
    owners = ["owner"] + [f"owner-{n}" for n in range(1, 8)]
    monkeypatch.setenv("CONNECTOR_INTERNAL_OWNER_COHORT", ",".join(owners))
    monkeypatch.setenv("DRIVE_FACTS_OWNER_LEASES", "4")
    for user_id in owners:
        await owner_originals(reusable, user_id, 2)

    await reusable.worker.run(max_jobs=4)
    first = facts_done(reusable)
    await reusable.worker.run(max_jobs=4)

    # Four slots serve the four least recently served owners once each; the
    # next sweep serves the other four first, so no owner waits behind another.
    assert first == dict.fromkeys(owners[:4], 1)
    assert facts_done(reusable) == dict.fromkeys(owners, 1)


async def test_parallel_final_folds_see_each_others_new_canonical_keys(reusable, monkeypatch):
    monkeypatch.setenv("DRIVE_FACTS_OWNER_LEASES", "4")
    await originals(reusable, count=3)
    assert await reusable.facts.enqueue(user_id="owner", policy_version=POLICY) == 3
    contexts, in_flight, peak = [], 0, 0

    async def keyed_fold(**kwargs):
        nonlocal in_flight, peak
        in_flight += 1
        peak = max(peak, in_flight)
        contexts.append({item["key"] for item in kwargs["canonical_context"]["packets"]})
        await asyncio.sleep(0.05)
        in_flight -= 1
        result = await fold(**kwargs)
        result["canonical_packets"][0]["key"] = f"invented-group-{len(contexts)}"
        return result

    reusable.worker.consolidator = keyed_fold

    outcomes = await asyncio.gather(
        *(reusable.worker.run_facts_one(user_id="owner", enqueue=False) for _ in range(3))
    )

    assert outcomes == ["facts_complete"] * 3
    # Page facts ran in parallel; each keying fold saw every earlier new key.
    assert peak == 1
    assert sorted(len(keys) for keys in contexts) == [0, 1, 2]


async def test_new_issuer_creates_its_own_packet_and_same_key_joins_existing_packet(reusable):
    await originals(reusable, count=3)
    keys = iter(
        [
            "issuer-a-account-1-statement-2026",
            "issuer-b-account-9-statement-2026",
            "issuer-a-account-1-statement-2026",
        ]
    )

    async def keyed(**kwargs):
        result = await fold(**kwargs)
        result["canonical_packets"][0]["key"] = next(keys)
        return result

    reusable.worker.consolidator = keyed
    for _ in range(3):
        assert await reusable.worker.run_facts_one(user_id="owner") == "facts_complete"
    with reusable.facts.db.engine.connect() as connection:
        sizes = connection.execute(
            text("SELECT count(*) FROM drive_packet_members GROUP BY packet_id")
        ).scalars()
        assert sorted(sizes) == [1, 2]
    outcomes = []
    while outcomes.count("ready") < 2 and len(outcomes) < 10:
        outcomes.append(await reusable.worker.run_packet_one(user_id="owner"))
    assert outcomes.count("ready") == 2
    listed = (await reusable.packets.list_packets(user_id="owner"))["packets"]
    assert sorted(item["documentCount"] for item in listed) == [1, 2]
    assert {item["state"] for item in listed} == {"ready"}


async def test_source_change_builds_next_version_and_listing_needs_a_new_allow(reusable):
    from dataclasses import replace

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
        frozen = connection.execute(
            text("SELECT manifest_envelope,digest FROM drive_packet_versions WHERE version=1")
        ).one()
        connection.execute(text("UPDATE drive_collection_sync SET next_at=clock_timestamp()"))
    changed = replace(source("synthetic-source-0"), version="2")
    sync = await reusable.collection.claim(user_id="owner")
    await reusable.collection.commit_page(
        sync, checkpoint={"changes_token": "changed-source"}, files=[changed], phase="changes"
    )
    with reusable.facts.db.engine.connect() as connection:
        assert connection.execute(text("SELECT dirty FROM drive_packet_heads")).scalar_one()
        assert not connection.execute(
            text("SELECT available FROM drive_packet_versions WHERE version=1")
        ).scalar_one()
    stale = (await reusable.packets.list_packets(user_id="recipient", owner_user_id="owner"))[
        "packets"
    ]
    assert [item["canRequest"] for item in stale] == [False]

    job = await reusable.ingestion.claim(user_id="owner", generation=1)
    await reusable.ingestion.publish_pages(job, metadata=changed, batch=collection_pages())
    assert await reusable.worker.run_facts_one(user_id="owner") == "facts_complete"
    for _ in range(3):
        outcome = await reusable.worker.run_packet_one(user_id="owner")
    assert outcome == "ready"

    with reusable.facts.db.engine.connect() as connection:
        versions = connection.execute(
            text("""SELECT version,digest,manifest_envelope,available
              FROM drive_packet_versions ORDER BY version""")
        ).all()
    assert [row.version for row in versions] == [1, 2]
    assert (versions[0].manifest_envelope, versions[0].digest) == (
        frozen.manifest_envelope,
        frozen.digest,
    )
    assert versions[1].digest != versions[0].digest
    assert versions[1].available and not versions[0].available
    # The Allow belonged to version 1. Buyers see nothing until the owner
    # allows version 2, and the old Allow cannot be re-applied.
    assert (await reusable.packets.list_packets(user_id="recipient", owner_user_id="owner"))[
        "packets"
    ] == []
    with pytest.raises(DriveReadError, match="packet_unavailable"):
        await reusable.packets.set_listing(
            user_id="owner",
            packet_id=packet["packetId"],
            version=1,
            decision="allow",
            price_cents=125,
            expected_revision=1,
            disclosure=LISTING_DISCLOSURE,
        )
    await reusable.packets.set_listing(
        user_id="owner",
        packet_id=packet["packetId"],
        version=2,
        decision="allow",
        price_cents=150,
        expected_revision=0,
        disclosure=LISTING_DISCLOSURE,
    )
    buyer = (await reusable.packets.list_packets(user_id="recipient", owner_user_id="owner"))[
        "packets"
    ]
    assert [(item["version"], item["priceCents"], item["canRequest"]) for item in buyer] == [
        (2, 150, True)
    ]


async def test_failed_member_batch_check_is_never_ready_even_if_final_check_passes(reusable):
    await originals(reusable)
    assert await reusable.worker.run_facts_one(user_id="owner") == "facts_complete"

    async def overconfident_final(**kwargs):
        if kwargs["batch_scope"]["mode"] == "member_batch":
            return {
                **await check(**kwargs),
                "state": "incomplete",
                "correct_coverage": False,
                "issues": ["Member batch evidence is unresolved."],
            }
        return await check(**{**kwargs, "complete": True})

    reusable.worker.checker = overconfident_final
    for _ in range(3):
        outcome = await reusable.worker.run_packet_one(user_id="owner")
    assert outcome == "incomplete"
    view = (await reusable.packets.list_packets(user_id="owner"))["packets"][0]
    assert view["state"] == "incomplete" and view["gaps"] and not view["canList"]
    with pytest.raises(DriveReadError, match="packet_unavailable"):
        await reusable.packets.set_listing(
            user_id="owner",
            packet_id=view["packetId"],
            version=1,
            decision="allow",
            price_cents=125,
            expected_revision=0,
            disclosure=LISTING_DISCLOSURE,
        )


async def test_incomplete_packet_reports_every_gap_and_cannot_be_listed(reusable):
    await originals(reusable)
    assert await reusable.worker.run_facts_one(user_id="owner") == "facts_complete"
    gaps = ["Statement for 2026-02 is missing.", "Page 3 of one statement is unreadable."]

    async def incomplete(**kwargs):
        return {**await construct(**kwargs), "state": "incomplete", "gaps": gaps}

    reusable.worker.constructor = incomplete
    for _ in range(3):
        outcome = await reusable.worker.run_packet_one(user_id="owner")
    assert outcome == "incomplete"
    view = (await reusable.packets.list_packets(user_id="owner"))["packets"][0]
    assert view["state"] == "incomplete" and view["gaps"] == gaps and not view["canList"]


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


async def test_worker_carries_host_file_time_without_persisting_it_in_manifest(reusable):
    # The store carries creation time through the host worker evidence ports.
    # This is metadata conservation, not model-context or semantic proof;
    # model input filters and the immutable manifest separately withhold it.
    from dataclasses import replace

    seen, checker = [], reusable.worker.checker

    async def recording(**kwargs):
        seen.extend(kwargs["documents"])
        return await checker(**kwargs)

    reusable.worker.checker = recording
    created = "2026-09-20T08:00:00Z"
    files = [replace(source("synthetic-created-source"), created_time=created)]
    await seed_collection(reusable.collection, files=files)
    job = await reusable.ingestion.claim(user_id="owner", generation=1)
    await reusable.ingestion.publish_pages(job, metadata=files[0], batch=collection_pages())
    assert await reusable.worker.run_facts_one(user_id="owner") == "facts_complete"
    for _ in range(3):
        result = await reusable.worker.run_packet_one(user_id="owner")
    assert result == "ready"
    assert seen and {item.get("created_time") for item in seen} == {created}
    [packet] = (await reusable.packets.list_packets(user_id="owner"))["packets"]
    manifest = await reusable.packets.current_packet_manifest(
        owner_user_id="owner", packet_id=packet["packetId"], version=1
    )
    assert manifest["sources"]
    assert all("created_time" not in item for item in manifest["sources"])


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
    planner.assert_awaited_once()
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
    with pytest.raises(DriveReadError, match="packet_superseded"):
        await period.freeze(job, search_job_id=state["jobId"])
    current = await reusable.packets.current_packet_manifest(
        owner_user_id="owner", packet_id=str(job["packet_id"]), version=1
    )
    assert current["digest"] and current["price_cents"] == 500
    page = await reusable.packets.list_packets(user_id="owner", owner_contents=True, limit=100)
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
