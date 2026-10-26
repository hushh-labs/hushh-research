"""Versioned recovery of empty period sales preserves history and all authority."""

# ruff: noqa: F401,F811 -- existing disposable PostgreSQL fixture graph
from datetime import UTC, datetime
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from sqlalchemy import text

from hushh_mcp.services.google_drive_adapter import DriveReadError
from tests.services.test_drive_financial_packet_rollout_postgres import legacy_frozen_runtime
from tests.services.test_drive_period_packet_previews_postgres import (
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


async def saved_empty_sale_recovery(reusable, monkeypatch, *, eligible=4, unverified=False):
    """Existing deployed heads may already have a complete newer private scan."""
    from hushh_mcp.services.external_mcp_client import ExternalMcpToolResult

    service, head, identity = await legacy_frozen_runtime(reusable, monkeypatch, legacy_empty=True)
    with service.store.db.engine.connect() as connection:
        original = connection.execute(
            text(
                "SELECT to_jsonb(v) FROM drive_packet_versions v WHERE packet_id=:id AND version=1"
            ),
            {"id": identity},
        ).scalar_one()

    async def read(*, user_id, tool_name, arguments):
        if tool_name == "list_shared_drives":
            return ExternalMcpToolResult(False, {"drives": [], "nextPageToken": None}, False)
        assert tool_name in {"search_files", "list_files"}
        return ExternalMcpToolResult(
            False,
            {
                "files": [
                    {
                        "id": f"recovered-source-{i}",
                        "title": f"Synthetic financial match {i}",
                        "mimeType": "application/pdf",
                        "version": "2",
                        "createdTime": f"{head['period_start']}T12:00:00Z",
                        "modifiedTime": f"{head['period_start']}T12:00:00Z",
                        **({} if unverified else {"capabilities": {"canShare": i < eligible}}),
                    }
                    for i in range(51)
                ],
                "nextPageToken": None,
                "incompleteSearch": False,
            },
            False,
        )

    service.search.transport.read_tool.side_effect = read
    monkeypatch.setattr(
        "hushh_mcp.services.drive_financial_packet_tagging.FinancialPacketTagger.run_one",
        AsyncMock(return_value="idle"),
    )
    with monkeypatch.context() as delayed:
        delayed.setattr(service.store, "finalize_empty_sale", AsyncMock(return_value=False))
        result = await service.run(max_jobs=1, deadline_seconds=10)
    assert result["outcomes"]["completed"] == 1
    preview = await service.preview(user_id="owner", packet_id=identity)
    assert preview["complete"] and preview["matched"] == 51
    return service, head, identity, original


async def test_saved_complete_scan_appends_four_eligible_files_without_rewriting_empty_sale(
    reusable, monkeypatch
):
    service, head, identity, original = await saved_empty_sale_recovery(reusable, monkeypatch)
    reads = service.search.transport.read_tool.await_count
    assert await service.store.due_owners(limit=1) == ["owner"]
    assert await service.run_one(user_id="owner", packet_id=identity) == "completed"
    assert service.search.transport.read_tool.await_count == reads  # Reuse saved complete scan.
    with service.store.db.engine.connect() as connection:
        versions = list(
            connection.execute(
                text(
                    "SELECT version,to_jsonb(v) FROM drive_packet_versions v WHERE packet_id=:id ORDER BY version"
                ),
                {"id": identity},
            )
        )
        assert len(versions) == 2 and versions[0][1] == original
        current = service.store._row(
            connection, "SELECT * FROM drive_packet_heads WHERE packet_id=:id", {"id": identity}
        )
        assert current["current_version"] == 2
        assert current["sale_finalization_revision"] == current["revision"]
        assert current["preview_document_count"] == 51
        version = service.store._row(
            connection,
            "SELECT * FROM drive_packet_versions WHERE packet_id=:id AND version=2",
            {"id": identity},
        )
        manifest = service.store._manifest(version)
        assert version["document_count"] == 4 and version["available"]
        assert manifest["version"] == 2 and len(manifest["sources"]) == 4
        assert all(item["shareable"] is True for item in manifest["source_metadata"].values())
        assert connection.execute(
            text("SELECT version FROM drive_packet_listings WHERE packet_id=:id"), {"id": identity}
        ).scalars().all() == [1]
        assert (
            connection.execute(text("SELECT count(*) FROM drive_share_requests")).scalar_one() == 0
        )
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
    preview = await service.preview(user_id="owner", packet_id=identity)
    assert preview["matched"] == 51 and preview["complete"]
    assert await service.run_one(user_id="owner", packet_id=identity) == "idle"
    assert await service.store.due_owners(limit=1) == []
    # An old version's listing never becomes permission to request the new set.
    with pytest.raises(DriveReadError, match="packet_unavailable"):
        await service.store.current_packet_manifest(
            owner_user_id="owner", packet_id=identity, version=2, viewer_user_id="recipient"
        )
    from tests.drive_postgres_test_support import apply_drive_fixture_migration

    with service.store.db.engine.begin() as connection:
        apply_drive_fixture_migration(
            connection, "rollback/429_drive_empty_sale_finalization.rollback.sql"
        )
        apply_drive_fixture_migration(connection, "429_drive_empty_sale_finalization.sql")
        preserved = list(
            connection.execute(
                text(
                    "SELECT version,to_jsonb(v) FROM drive_packet_versions v WHERE packet_id=:id ORDER BY version"
                ),
                {"id": identity},
            )
        )
        assert preserved == versions  # Down/reapply never removes either immutable version.


async def pin_empty_sale_request(service, sharing, head, identity):
    from hushh_mcp.services.drive_sharing_contract import ShareRequestPurpose
    from tests.services.test_drive_packet_catalog_postgres import recipient

    request = await sharing.create_request(
        recipient=recipient(),
        owner_user_id="owner",
        client_request_id=str(uuid4()),
        purpose=ShareRequestPurpose(
            purpose="Synthetic financial request",
            periodStart=str(head["period_start"]),
            periodEnd=str(head["period_end"]),
        ),
    )
    with service.store.db.engine.begin() as connection:
        connection.execute(
            text(
                "UPDATE drive_share_requests SET reusable_packet_id=:id,reusable_packet_version=1 WHERE request_id=:request"
            ),
            {"id": identity, "request": request["requestId"]},
        )


def change_recovery_evidence(service, job, head, identity, fault):
    with service.store.db.engine.begin() as connection:
        if fault == "incomplete":
            connection.execute(
                text("UPDATE drive_owner_search_jobs SET incomplete_search=TRUE WHERE job_id=:job"),
                {"job": job["build"]["search_job_id"]},
            )
        elif fault == "generation":
            connection.exec_driver_sql(
                "UPDATE user_external_connector_connections SET connection_generation=connection_generation+1 WHERE user_id='owner'"
            )
        elif fault == "lease":
            connection.execute(
                text("UPDATE drive_packet_heads SET lease_id=:lease WHERE packet_id=:id"),
                {"lease": str(uuid4()), "id": identity},
            )
        elif fault == "old_query":
            job["build"]["query_source"] = {"kind": "legacy"}
            search = service.store._row(
                connection,
                "SELECT * FROM drive_owner_search_jobs WHERE job_id=:job",
                {"job": job["build"]["search_job_id"]},
            )
            checkpoint = service.search.store._checkpoint(search)
            checkpoint["query_source"] = {"kind": "legacy"}
            envelope = service.search.store._seal(
                checkpoint, "owner", str(search["job_id"]), "owner-search-checkpoint"
            )
            connection.execute(
                text(
                    "UPDATE drive_owner_search_jobs SET checkpoint_envelope=CAST(:envelope AS jsonb) WHERE job_id=:job"
                ),
                {"envelope": envelope, "job": search["job_id"]},
            )
        elif fault == "open_period":
            connection.execute(
                text("UPDATE drive_owner_search_jobs SET created_at=:created WHERE job_id=:job"),
                {
                    "created": datetime.combine(head["period_start"], datetime.min.time(), UTC),
                    "job": job["build"]["search_job_id"],
                },
            )
        elif fault == "limit":
            connection.execute(
                text("UPDATE drive_owner_search_jobs SET matched=121 WHERE job_id=:job"),
                {"job": job["build"]["search_job_id"]},
            )


@pytest.mark.parametrize(
    "fault", ["request", "incomplete", "generation", "lease", "old_query", "open_period", "limit"]
)
async def test_empty_sale_recovery_refuses_changed_authority_or_incomplete_evidence(
    reusable, sharing, monkeypatch, fault
):
    service, head, identity, original = await saved_empty_sale_recovery(reusable, monkeypatch)
    job = await service.store.claim_build(user_id="owner", packet_id=identity)
    assert job is not None
    if fault == "request":
        await pin_empty_sale_request(service, sharing, head, identity)
    else:
        change_recovery_evidence(service, job, head, identity, fault)
    with pytest.raises((DriveReadError, ValueError)):
        await service.store.freeze(job, search_job_id=job["build"]["search_job_id"])
    with service.store.db.engine.connect() as connection:
        assert (
            connection.execute(
                text("SELECT current_version FROM drive_packet_heads WHERE packet_id=:id"),
                {"id": identity},
            ).scalar_one()
            == 1
        )
        assert (
            connection.execute(
                text(
                    "SELECT to_jsonb(v) FROM drive_packet_versions v WHERE packet_id=:id AND version=1"
                ),
                {"id": identity},
            ).scalar_one()
            == original
        )
        assert (
            connection.execute(
                text("SELECT count(*) FROM drive_packet_versions WHERE packet_id=:id"),
                {"id": identity},
            ).scalar_one()
            == 1
        )


@pytest.mark.parametrize("unverified", [False, True])
async def test_empty_sale_recovery_records_denied_or_unknown_scan_once(
    reusable, monkeypatch, unverified
):
    service, head, identity, original = await saved_empty_sale_recovery(
        reusable, monkeypatch, eligible=0, unverified=unverified
    )
    assert await service.run_one(user_id="owner", packet_id=identity) == "completed"
    assert await service.run_one(user_id="owner", packet_id=identity) == "idle"
    with service.store.db.engine.connect() as connection:
        row = service.store._row(
            connection, "SELECT * FROM drive_packet_heads WHERE packet_id=:id", {"id": identity}
        )
        assert row["current_version"] == 1 and row["sale_finalization_revision"] == row["revision"]
        assert (
            connection.execute(
                text(
                    "SELECT to_jsonb(v) FROM drive_packet_versions v WHERE packet_id=:id AND version=1"
                ),
                {"id": identity},
            ).scalar_one()
            == original
        )
        assert (
            connection.execute(
                text("SELECT count(*) FROM drive_packet_versions WHERE packet_id=:id"),
                {"id": identity},
            ).scalar_one()
            == 1
        )
