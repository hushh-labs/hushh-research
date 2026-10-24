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

pytestmark = [pytest.mark.feature_drive_packets, pytest.mark.trace_loop]


def preview_read(head, *, empty, interrupt):
    from hushh_mcp.services.external_mcp_client import ExternalMcpToolResult

    timestamp = f"{head['period_start'].isoformat()}T12:00:00Z"

    async def read(*, user_id, tool_name, arguments):
        assert user_id == "owner"
        if tool_name == "list_shared_drives":
            return ExternalMcpToolResult(False, {"drives": [], "nextPageToken": None}, False)
        assert tool_name in {"list_files", "search_files"}, (
            "A packet search must not read file bodies"
        )
        if arguments.get("pageToken"):
            raise DriveReadError("provider_unavailable", retryable=False)
        files = (
            []
            if empty
            else [
                {
                    "id": f"preview-file-{i}",
                    "title": f"Example statement {i}",
                    "mimeType": "video/mp4" if i == 0 else "application/pdf",
                    "version": "1",
                    "createdTime": timestamp,
                    "modifiedTime": timestamp,
                    "capabilities": {"canShare": i != 0},
                }
                for i in range(26)
            ]
        )
        return ExternalMcpToolResult(
            False,
            {
                "files": files,
                "nextPageToken": "second" if interrupt else None,
                "incompleteSearch": False,
            },
            False,
        )

    return read


async def preview_runtime(reusable, monkeypatch, *, historical=False, empty=False, interrupt=False):
    from hushh_mcp.services.drive_owner_search_service import DriveOwnerSearchService
    from hushh_mcp.services.drive_owner_search_store import DriveOwnerSearchStore
    from hushh_mcp.services.drive_period_packet_service import DrivePeriodPacketService
    from hushh_mcp.services.drive_period_packet_store import DrivePeriodPacketStore
    from tests.services.test_drive_period_packets import semantic

    monkeypatch.setenv("DRIVE_PERIOD_PACKETS_ENABLED", "true")
    monkeypatch.setattr(
        "hushh_mcp.services.drive_request_package_assessment.validate_semantic_model_binding",
        lambda value: value,
    )
    binding = {
        "provider": "azure_openai",
        "deployment": "synthetic",
        "config_fingerprint": "synthetic",
        "approval_generation": None,
    }
    monkeypatch.setattr(
        "hushh_mcp.services.drive_period_packet_service.semantic_request_model_binding",
        lambda: binding,
    )
    store = DrivePeriodPacketStore(db=reusable.collection.db, cipher=reusable.collection.cipher)
    instant = datetime(2020, 3, 1, tzinfo=UTC) if historical else datetime.now(UTC)
    await store.ensure_owner(user_id="owner", now=instant)
    with store.db.engine.connect() as connection:
        head = dict(
            connection.execute(
                text("""SELECT * FROM drive_packet_heads WHERE user_id='owner'
          AND category='financial' ORDER BY period_start DESC LIMIT 1""")
            )
            .mappings()
            .one()
        )
    plan = semantic()
    plan["date_basis"] = "created"
    planner = AsyncMock(
        return_value={
            "file_kind": "any",
            "semantic_query": plan,
            "subject_scope": "specific_records",
            "subject_complete": True,
            "semantic_intent": "other",
            "discovery_clues": ["statement"],
            "required_entities": [],
            "expected_document_anatomy": "Provider query matches only.",
        }
    )
    read = preview_read(head, empty=empty, interrupt=interrupt)
    transport = SimpleNamespace(read_tool=AsyncMock(side_effect=read))
    service = DrivePeriodPacketService(
        store=store,
        planner=planner,
        require_owner=AsyncMock(),
        search=DriveOwnerSearchService(
            store=DriveOwnerSearchStore(db=store.db), transport=transport
        ),
    )
    return service, head, planner, transport


@pytest.mark.parametrize("historical", [False, True])
async def test_owner_queries_open_and_historical_ranges_without_purchase(
    reusable, monkeypatch, historical
):
    service, head, planner, transport = await preview_runtime(
        reusable, monkeypatch, historical=historical
    )
    identity = str(head["packet_id"])
    before = await service.preview(user_id="owner", packet_id=identity)
    assert before["matched"] is None and before["status"] == "not_started"
    for _ in range(5):
        preview = await service.prepare_preview(user_id="owner", packet_id=identity)
        if preview["complete"]:
            break
    assert preview["complete"] and preview["matched"] == 26
    assert len(preview["documents"]) == 25 and preview["nextCursor"]
    assert preview["documents"][0]["shareable"] is False
    assert preview["documents"][0]["viewUrl"].startswith("https://drive.google.com/")
    rest = await service.preview(user_id="owner", packet_id=identity, cursor=preview["nextCursor"])
    assert len(rest["documents"]) == 1 and rest["nextCursor"] is None
    counts = (planner.await_count, transport.read_tool.await_count)
    await service.prepare_preview(user_id="owner", packet_id=identity)
    assert (planner.await_count, transport.read_tool.await_count) == counts
    with service.store.db.engine.connect() as connection:
        current = dict(
            connection.execute(
                text("SELECT * FROM drive_packet_heads WHERE packet_id=:id"), {"id": identity}
            )
            .mappings()
            .one()
        )
        assert current["current_version"] == (1 if historical else 0)
        assert current["revision"] == head["revision"]
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
    if not historical:
        first_revision = preview["revision"]
        # Acceptance is recorded before a worker can claim the owner slot.
        assert await service.store.request_preview(
            user_id="owner", packet_id=identity, refresh=True
        )
        queued = await service.preview(user_id="owner", packet_id=identity)
        assert queued["revision"] == first_revision + 1
        assert queued["status"] == "queued" and queued["stale"]
        assert queued["matched"] == 26 and queued["documents"] == preview["documents"]
        refreshed = await service.prepare_preview(user_id="owner", packet_id=identity)
        assert refreshed["revision"] == first_revision + 1
        with service.store.db.engine.connect() as connection:
            assert (
                connection.execute(
                    text("SELECT count(*) FROM drive_owner_search_jobs WHERE period_packet_id=:id"),
                    {"id": identity},
                ).scalar_one()
                == 2
            )
    else:
        before = await service.store.current_packet_manifest(
            owner_user_id="owner", packet_id=identity, version=1
        )
        await service.prepare_preview(user_id="owner", packet_id=identity, refresh=True)
        after = await service.store.current_packet_manifest(
            owner_user_id="owner", packet_id=identity, version=1
        )
        assert before["digest"] == after["digest"]
        assert (planner.await_count, transport.read_tool.await_count) == counts
    with service.store.db.engine.begin() as connection:
        connection.execute(
            text(
                "UPDATE user_external_connector_connections SET status='revoked' WHERE user_id='owner' AND connector_id='google_drive'"
            )
        )
    with pytest.raises(DriveReadError):
        await service.preview(user_id="owner", packet_id=identity)


async def test_finalization_requeries_after_a_completed_open_period_preview(reusable, monkeypatch):
    from hushh_mcp.services.drive_request_discovery import discovery_evidence

    service, head, _, _ = await preview_runtime(reusable, monkeypatch, historical=True)
    identity = str(head["packet_id"])
    job = await service.store.claim_build(user_id="owner", packet_id=identity)
    plan, binding = await service._plan(job, AsyncMock())
    state = await service._search_job(job, plan, binding)
    searches = service.search.store
    claimed = await searches.claim(user_id="owner", job_id=state["jobId"])
    source = {
        "id": "open-preview",
        "name": "Example statement",
        "mimeType": "application/pdf",
        "sourceVersion": "1",
        "shareable": True,
        "createdTime": f"{head['period_start']}T00:00:00Z",
    }
    source["discoveryEvidence"] = discovery_evidence(
        claimed["checkpoint"], user_id="owner", generation=1, metadata=source
    )
    await searches.commit_page(claimed, checkpoint=claimed["checkpoint"], files=[source], done=True)
    with service.store.db.engine.begin() as connection:
        connection.execute(
            text("UPDATE drive_owner_search_jobs SET created_at=:started WHERE job_id=:id"),
            {
                "id": state["jobId"],
                "started": datetime.combine(head["period_start"], datetime.min.time(), UTC),
            },
        )
    from hushh_mcp.services.drive_financial_packet_query import QUERY_SOURCE

    await service.store.save_build(
        job, {"plan": plan, "model_binding": binding, "query_source": QUERY_SOURCE}
    )
    preview = await service.prepare_preview(user_id="owner", packet_id=identity)
    assert preview["complete"] and preview["matched"] == 1
    with service.store.db.engine.connect() as connection:
        assert (
            connection.execute(
                text("SELECT current_version FROM drive_packet_heads WHERE packet_id=:id"),
                {"id": identity},
            ).scalar_one()
            == 0
        )
    final = await service.prepare_preview(user_id="owner", packet_id=identity)
    assert final["complete"] and final["revision"] == preview["revision"] + 1
    with service.store.db.engine.connect() as connection:
        assert (
            connection.execute(
                text("SELECT current_version FROM drive_packet_heads WHERE packet_id=:id"),
                {"id": identity},
            ).scalar_one()
            == 1
        )


@pytest.mark.parametrize("empty", [False, True])
async def test_preview_retains_partial_files_and_distinguishes_completed_empty(
    reusable, monkeypatch, empty
):
    service, head, _, transport = await preview_runtime(
        reusable, monkeypatch, empty=empty, interrupt=not empty
    )
    identity = str(head["packet_id"])
    for _ in range(5):
        preview = await service.prepare_preview(user_id="owner", packet_id=identity)
        if preview["complete"] or preview["status"] == "failed":
            break
    assert preview["complete"] is empty
    assert preview["matched"] == (0 if empty else 26)
    assert preview["status"] == ("completed" if empty else "failed")
    if not empty:
        assert preview["documents"] and preview["documents"][0]["viewUrl"]
        transport.read_tool.side_effect = DriveReadError("provider_unavailable", retryable=False)
        retried = await service.prepare_preview(user_id="owner", packet_id=identity, refresh=True)
        assert retried["documents"] == preview["documents"] and retried["stale"]
    with pytest.raises(DriveReadError):
        await service.preview(user_id="recipient", packet_id=identity)
    await service.store.set_background(user_id="owner", enabled=False, confirmed=True)
    with pytest.raises(DriveReadError):
        await service.prepare_preview(user_id="owner", packet_id=identity, refresh=True)


async def test_noncompilable_model_plan_is_not_pinned_across_recovery(reusable, monkeypatch):
    from copy import deepcopy

    service, head, planner, _ = await preview_runtime(reusable, monkeypatch)
    # Nonfinancial historical heads retain their model-authored contract.
    with service.store.db.engine.begin() as connection:
        connection.execute(
            text("UPDATE drive_packet_heads SET category='bank' WHERE packet_id=:id"),
            {"id": head["packet_id"]},
        )
    good = planner.return_value
    invalid = deepcopy(good)
    invalid["semantic_query"]["date_basis"] = "content"
    planner.side_effect = [invalid, good]
    identity = str(head["packet_id"])
    failed = await service.prepare_preview(user_id="owner", packet_id=identity)
    assert failed["status"] == "failed" and failed["errorCode"] == "planner_output_invalid"
    assert failed["matched"] is None and failed["documents"] == []
    with service.store.db.engine.connect() as connection:
        row = dict(
            connection.execute(
                text("SELECT * FROM drive_packet_heads WHERE packet_id=:id"), {"id": identity}
            )
            .mappings()
            .one()
        )
        assert "plan" not in service.store._build(row)
    for _ in range(5):
        result = await service.prepare_preview(user_id="owner", packet_id=identity)
        if result["complete"]:
            break
    assert result["complete"] and result["matched"] == 26 and planner.await_count == 2
