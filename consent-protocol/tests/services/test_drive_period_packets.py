"""Metadata packet calendar, exact source provenance and no-reader boundaries."""

from copy import deepcopy
from datetime import UTC, date, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest

from hushh_mcp.services.drive_period_packet_contract import PacketPeriod, current_year_periods
from hushh_mcp.services.drive_period_packet_page import frozen_provider_page
from hushh_mcp.services.drive_period_packet_service import DrivePeriodPacketService
from hushh_mcp.services.drive_request_discovery import (
    DISCOVERY_DELIVERY_POLICY,
    compile_discovery_queries,
    discovery_evidence_matches,
)
from hushh_mcp.services.drive_request_semantic_plan import semantic_plan_digest
from hushh_mcp.services.google_drive_adapter import DriveReadError


def semantic():
    return {
        "version": 1,
        "status": "ready",
        "metadata_listing": False,
        "date_basis": "title_created_modified",
        "clarification": None,
        "clauses": [
            {
                "predicates": [
                    {
                        "id": "statement",
                        "kind": "semantic",
                        "value": "statement",
                        "match": "token",
                        "negated": False,
                        "discovery_terms": [],
                    }
                ]
            }
        ],
    }


def test_current_year_pairs_close_only_after_local_period_end():
    periods = current_year_periods(datetime(2026, 10, 24, tzinfo=UTC), "Asia/Kolkata")
    assert [(p.start.month, p.end.month) for p in periods] == [
        (1, 2),
        (3, 4),
        (5, 6),
        (7, 8),
        (9, 10),
    ]
    assert periods[-1].closed(datetime(2026, 10, 31, 18, 29, 59, tzinfo=UTC)) is False
    assert periods[-1].closed(datetime(2026, 10, 31, 18, 30, tzinfo=UTC)) is True
    leap = current_year_periods(datetime(2024, 2, 5, tzinfo=UTC), "UTC")
    assert leap[0].end == date(2024, 2, 29)
    with pytest.raises(ValueError):
        PacketPeriod(start=date(2026, 2, 1), end=date(2026, 3, 31), timezone="UTC")


async def test_disabled_worker_does_not_touch_store(monkeypatch):
    monkeypatch.delenv("DRIVE_PERIOD_PACKETS_ENABLED", raising=False)
    store = SimpleNamespace(due_owners=AsyncMock(side_effect=AssertionError("DB accessed")))
    service = DrivePeriodPacketService(store=store, search=SimpleNamespace())
    assert (await service.run())["outcomes"] == {}
    store.due_owners.assert_not_awaited()


@pytest.mark.parametrize("changed", [False, True])
async def test_frozen_packet_pages_exact_metadata_and_rebinds_to_buyer_request(changed):
    plan = semantic()
    request = str(uuid4())
    checkpoint = {
        "queries": compile_discovery_queries(plan),
        "query_index": 0,
        "semantic_plan": plan,
        "semantic_plan_digest": semantic_plan_digest(plan),
        "requested_period": {
            "start": "2026-01-01",
            "end": "2026-02-28",
            "timezone": "Asia/Kolkata",
        },
        "request_origin_id": request,
        "request_revision": 0,
        "packet_offset": 0,
        "discovery_delivery_policy": DISCOVERY_DELIVERY_POLICY,
    }
    raw = {
        "id": "file-synthetic",
        "title": "Statement",
        "mimeType": "application/pdf",
        "modifiedTime": "2026-01-10T00:00:00Z",
        "version": "2" if changed else "1",
        "capabilities": {"canShare": True},
    }
    metadata = {"id": raw["id"], "name": raw["title"], "mimeType": raw["mimeType"]}
    identity = str(uuid4())
    manifest = {
        "packet_id": str(uuid4()),
        "version": 1,
        "sources": [{"document_id": identity, "source_version": "1"}],
        "source_metadata": {identity: metadata},
    }
    transport = SimpleNamespace(
        read_tool=AsyncMock(
            return_value=SimpleNamespace(is_error=False, truncated=False, payload={"file": raw})
        )
    )
    service = SimpleNamespace(transport=transport)
    job = {"user_id": "owner", "generation": 7}
    original = deepcopy(checkpoint)
    if changed:
        with pytest.raises(DriveReadError, match="source_changed"):
            await frozen_provider_page(service, job, manifest, checkpoint)
        assert checkpoint == original
    else:
        result, files, incomplete, done = await frozen_provider_page(
            service, job, manifest, checkpoint
        )
        assert done and not incomplete and result["packet_offset"] == 1
        assert files[0]["providerPacketDocumentId"] == identity
        assert files[0]["sourceVersion"] == "1"
        assert discovery_evidence_matches(
            files[0], user_id="owner", generation=7, checkpoint=original
        )
        assert files[0]["discoveryEvidence"]["request_id"] == request
        assert (
            not {"facts", "indexedEvidence", "requestEvidence", "contentVerified"} & files[0].keys()
        )
    transport.read_tool.assert_awaited_once_with(
        user_id="owner", tool_name="get_file_metadata", arguments={"fileId": "file-synthetic"}
    )


@pytest.mark.parametrize("tamper", [None, "queries", "binding", "origin"])
def test_catalog_checkpoint_cannot_substitute_request_or_provider_plan(tamper):
    from hushh_mcp.services.drive_period_packet_page import validate_buyer_checkpoint

    plan = semantic()
    queries = compile_discovery_queries(plan)
    binding = {"packetId": "packet", "version": 1}
    purpose = {
        "purpose": "Synthetic packet",
        "periodStart": "2026-01-01",
        "periodEnd": "2026-02-28",
    }
    manifest = {
        "kind": "provider_discovery",
        "search": {"plan": plan, "queries": queries, "model_binding": None},
        "periodStart": "2026-01-01",
        "periodEnd": "2026-02-28",
        "timezone": "UTC",
    }
    private = {"purpose": purpose, "reusable_packet": binding, "agent_package_required": True}
    checkpoint = {
        "semantic_plan": plan,
        "semantic_plan_digest": semantic_plan_digest(plan),
        "semantic_model_binding": None,
        "queries": queries,
        "requested_period": {"start": "2026-01-01", "end": "2026-02-28", "timezone": "UTC"},
        "semantic_purpose": purpose,
        "reusable_packet": binding,
        "provider_packet": True,
        "authority_mode": "agent_package",
        "evidence_route": "packet",
        "discovery_delivery_policy": DISCOVERY_DELIVERY_POLICY,
    }
    changed = deepcopy(checkpoint)
    if tamper == "queries":
        changed["queries"] = []
    elif tamper == "binding":
        changed["semantic_model_binding"] = {"provider": "other"}
    elif tamper == "origin":
        changed["reusable_packet"] = {"packetId": "other", "version": 1}
    if tamper:
        with pytest.raises(DriveReadError, match="search_superseded"):
            validate_buyer_checkpoint(manifest, private, changed, checkpoint)
    else:
        validate_buyer_checkpoint(manifest, private, changed, checkpoint)


async def test_worker_threads_exact_head_lease_to_pre_send_guard(monkeypatch):
    from hushh_mcp.services.drive_period_packet_contract import PERIOD_PACKET_POLICY

    monkeypatch.setattr(
        "hushh_mcp.services.drive_period_packet_service.admit_hub_content", AsyncMock()
    )
    identity = str(uuid4())
    work = {"packet_id": identity, "revision": 3, "lease_id": "lease-current", "build": {}}
    store = SimpleNamespace(
        ensure_owner=AsyncMock(),
        claim_build=AsyncMock(return_value=work),
        require_build_current=AsyncMock(side_effect=DriveReadError("packet_superseded")),
        save_build=AsyncMock(),
    )
    service = DrivePeriodPacketService(store=store, search=SimpleNamespace())

    async def model_pre_send(_job, current):
        await current()
        raise AssertionError(PERIOD_PACKET_POLICY)

    service._plan = model_pre_send
    assert await service.run_one(user_id="owner") == "unavailable"
    store.require_build_current.assert_awaited_once_with(
        user_id="owner", packet_id=identity, revision=3, lease_id="lease-current"
    )
