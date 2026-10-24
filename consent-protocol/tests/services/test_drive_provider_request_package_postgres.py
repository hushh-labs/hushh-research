"""Exact provider-search package admission; no content models or payment effects."""

# ruff: noqa: F401,F811 -- reuse the existing isolated PostgreSQL fixture graph

import json
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from sqlalchemy import text

from hushh_mcp.services.drive_sharing_contract import DriveSharingError
from hushh_mcp.services.google_drive_adapter import DriveReadError
from tests.services.test_drive_request_package_service import job, setup_work
from tests.services.test_drive_request_package_store_postgres import (
    connector_postgres_url,
    documents,
    drive,
    drive_connect,
    lifecycle,
    packages,
    request_bulk,
    request_search,
    sharing,
)


def _provider_rows(packages, connection, search, packet_id, provenance):
    from hushh_mcp.services.drive_request_discovery import discovery_evidence

    metadata, sources = {}, []
    for item in connection.execute(
        text("SELECT * FROM drive_owner_search_results WHERE job_id=:job ORDER BY position"),
        {"job": search},
    ).mappings():
        value = packages.search_cipher.open(
            item["metadata_envelope"],
            user_id="owner",
            resource_id=f"{search}:{item['position']}",
            purpose="owner-search-result",
        )
        identity = str(uuid4())
        value.update(
            providerPacketDocumentId=identity,
            providerPacketId=packet_id,
            providerPacketVersion=1,
            sourceVersion="7",
        )
        value["discoveryEvidence"] = discovery_evidence(
            provenance, user_id="owner", generation=1, metadata=value
        )
        metadata[identity] = dict(value)
        sources.append({"document_id": identity, "source_version": "7"})
        connection.execute(
            text("""UPDATE drive_owner_search_results
            SET metadata_envelope=CAST(:envelope AS jsonb) WHERE job_id=:job AND position=:position"""),
            {
                "job": search,
                "position": item["position"],
                "envelope": packages._seal(
                    value, "owner", f"{search}:{item['position']}", "owner-search-result"
                ),
            },
        )
    return metadata, sources


async def provider_packet_search(packages, request_bulk, sharing, monkeypatch):
    from hushh_mcp.services.drive_request_semantic_plan import semantic_plan_digest

    request_id, search = await request_search(packages, request_bulk, sharing, count=2)
    packet_id = str(uuid4())
    plan = {
        "version": 1,
        "status": "ready",
        "date_basis": "modified",
        "clauses": [],
        "metadata_listing": True,
        "clarification": None,
    }
    # The semantic parser owns full plan validation. These query bindings are
    # synthetic, while this test exercises real request locks and persistence.
    queries = [{"arguments": {"query": "trashed = false"}}]
    binding = {
        "ownerUserId": "owner",
        "packetId": packet_id,
        "version": 1,
        "manifestDigest": "c" * 64,
        "listingRevision": 1,
        "priceCents": 500,
    }
    with sharing.db.engine.begin() as connection:
        request = sharing._request(connection, "owner", request_id)
        row = packages._owned(connection, "owner", search)
        checkpoint = packages._checkpoint(row)
        checkpoint.update(provider_packet=True, reusable_packet=binding)
        provenance = {
            "queries": queries,
            "semantic_plan": plan,
            "query_index": 0,
            "semantic_plan_digest": semantic_plan_digest(plan),
            "request_origin_id": request_id,
            "request_revision": request["revision"],
            "requested_period": {"start": "2026-01-01", "end": "2026-02-28", "timezone": "UTC"},
        }
        metadata, sources = _provider_rows(packages, connection, search, packet_id, provenance)
        private = {**sharing._open_request(request), "reusable_packet": binding}
        connection.execute(
            text("""UPDATE drive_share_requests SET request_envelope=CAST(:envelope AS jsonb)
            WHERE request_id=:request"""),
            {
                "request": request_id,
                "envelope": json.dumps(
                    sharing.sharing_cipher.seal(
                        private, user_id="owner", resource_id=request_id, purpose="request"
                    )
                ),
            },
        )
        connection.execute(
            text("""UPDATE drive_owner_search_jobs SET checkpoint_envelope=CAST(:envelope AS jsonb)
            WHERE job_id=:job"""),
            {
                "job": search,
                "envelope": packages._seal(checkpoint, "owner", search, "owner-search-checkpoint"),
            },
        )
    manifest = {
        "schema_version": 2,
        "kind": "provider_discovery",
        "digest": "c" * 64,
        "packet_id": packet_id,
        "version": 1,
        "connection_generation": 1,
        "periodStart": "2026-01-01",
        "periodEnd": "2026-02-28",
        "timezone": "UTC",
        "sources": sources,
        "source_metadata": metadata,
        "selected_document_ids": list(metadata),
        "search": {"queries": queries, "plan": plan},
        "price_cents": 500,
    }
    # The catalog's separate current-version tests cover its authority. Preserve
    # a fixed exact manifest here without requiring extracted facts or content.
    monkeypatch.setattr(packages, "_provider_manifest", lambda *_a, **_k: manifest)
    return request_id, search, manifest


def _tamper_provider_result(packages, sharing, search, manifest, tamper):
    with sharing.db.engine.begin() as connection:
        item = (
            connection.execute(
                text("""SELECT * FROM drive_owner_search_results
            WHERE job_id=:job AND position=1"""),
                {"job": search},
            )
            .mappings()
            .one()
        )
        value = packages.search_cipher.open(
            item["metadata_envelope"],
            user_id="owner",
            resource_id=f"{search}:1",
            purpose="owner-search-result",
        )
        if tamper == "member":
            value["providerPacketDocumentId"] = str(uuid4())
        elif tamper == "source":
            value["sourceVersion"] = "8"
        elif tamper == "request":
            value["discoveryEvidence"]["request_id"] = str(uuid4())
        elif tamper == "query":
            value["discoveryEvidence"]["query_digest"] = "d" * 64
        elif tamper == "content":
            value["contentVerified"] = True
        else:
            manifest["selected_document_ids"].pop()
        connection.execute(
            text("""UPDATE drive_owner_search_results
            SET metadata_envelope=CAST(:envelope AS jsonb) WHERE job_id=:job AND position=1"""),
            {
                "job": search,
                "envelope": packages._seal(value, "owner", f"{search}:1", "owner-search-result"),
            },
        )


@pytest.mark.parametrize(
    "tamper", [None, "member", "source", "request", "query", "content", "partial"]
)
async def test_provider_packet_freeze_binds_all_metadata_without_fabricated_assessment(
    packages, request_bulk, sharing, monkeypatch, tamper
):
    request_id, search, manifest = await provider_packet_search(
        packages, request_bulk, sharing, monkeypatch
    )
    if tamper is not None:
        _tamper_provider_result(packages, sharing, search, manifest, tamper)
    job = await packages.claim_evaluation(user_id="owner", job_id=search)
    if tamper:
        with pytest.raises(DriveSharingError, match="package_changed"):
            await packages.finalize_provider_packet(job)
        return
    ready = await packages.finalize_provider_packet(job)
    assert ready["canAllow"] and ready["selectedCount"] == 2
    assert ready["confidenceBasis"] == "provider_search" and ready["confidenceScore"] is None
    assert ready["evaluatedCount"] == 0 and ready["coverageStatus"] == "unknown"
    with sharing.db.engine.begin() as connection:
        request = sharing._request(connection, "owner", request_id)
        validated = packages.validate_ready_package(
            connection, request, sharing._open_request(request), ready["revision"], ready["digest"]
        )
        assert validated["buyer_disclosure"]["confidenceBasis"] == "provider_search"
        assert validated["buyer_disclosure"]["periods"] == []
        assert all(
            s["fingerprint_basis"] == "provider_metadata" for s in validated["selected_sources"]
        )
        assert (
            connection.execute(
                text(
                    "SELECT count(evaluated_at) FROM drive_owner_search_results WHERE job_id=:job"
                ),
                {"job": search},
            ).scalar_one()
            == 0
        )
        assert (
            connection.execute(
                text("SELECT count(*) FROM drive_request_payment_orders")
            ).scalar_one()
            == 0
        )
        assert request["owner_allowed_at"] is None
        row = packages._owned(connection, "owner", search)
        assert "assessment" not in packages._checkpoint(row)["agent_package"]


async def test_provider_only_claim_leaves_historical_content_package_unleased(
    packages, request_bulk, sharing
):
    _, search = await request_search(packages, request_bulk, sharing, count=1)
    assert (
        await packages.claim_evaluation(user_id="owner", job_id=search, provider_only=True) is None
    )
    with sharing.db.engine.connect() as connection:
        row = packages._owned(connection, "owner", search)
        assert row["evaluation_status"] == "pending" and row["lease_id"] is None


@pytest.mark.parametrize("changed", [False, True])
async def test_provider_packet_finalizes_exact_selection_without_content_stage(changed):
    work = job()
    work["checkpoint"] = {
        "provider_packet": True,
        "reusable_packet": {"packetId": "packet", "version": 1},
    }
    service, store, reader, assessor, final, wake = setup_work(work)
    manifest = {"kind": "provider_discovery", "schema_version": 2}
    service._reusable_manifest = AsyncMock(return_value=manifest)
    store.finalize_provider_packet = AsyncMock(return_value={"status": "ready"})
    if changed:
        store.require_evaluation_current.side_effect = DriveReadError("connection_changed")
    assert await service.run_one(user_id="owner", job_id="job") == (
        "unavailable" if changed else "ready"
    )
    reader.read_compilation_match.assert_not_awaited()
    assessor.assert_not_awaited()
    final.assert_not_awaited()
    store.commit_evaluations.assert_not_awaited()
    store.finalize_package.assert_not_awaited()
    if changed:
        store.finalize_provider_packet.assert_not_awaited()
    else:
        store.finalize_provider_packet.assert_awaited_once_with(work)
    wake.assert_not_awaited()
