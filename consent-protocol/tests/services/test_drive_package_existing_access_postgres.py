"""Real durable no-charge completion, with synthetic observed Google ACLs."""

# ruff: noqa: F401,F811 -- shared isolated PostgreSQL fixture graph
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import text

from hushh_mcp.services.drive_bulk_share_store import DriveBulkShareStore
from hushh_mcp.services.drive_package_access_preflight import PackageAccessResult
from hushh_mcp.services.drive_package_existing_access_store import DrivePackageExistingAccessStore
from hushh_mcp.services.drive_request_bulk_service import DriveRequestBulkService
from hushh_mcp.services.drive_request_package_service import DriveRequestPackageService
from hushh_mcp.services.drive_request_package_store import DriveRequestPackageStore
from hushh_mcp.services.google_drive_adapter import DriveReadError
from tests.services.test_drive_request_index_reuse_postgres import (
    LISTING_DISCLOSURE,
    MIGRATIONS,
    catalog,
    collection,
    collection_pages,
    connector_postgres_url,
    documents,
    drive,
    drive_connect,
    flow,
    ingestion,
    lifecycle,
    ready_packet,
    recipient,
    reusable,
    sharing,
)


@pytest.fixture
async def approved_access(catalog, reusable, sharing, monkeypatch):
    monkeypatch.setattr(
        "hushh_mcp.services.drive_owner_search_service.wake_drive_work", AsyncMock()
    )
    request, found, search, *_ = await flow(catalog, reusable, sharing)
    store = DriveRequestPackageStore(db=sharing.db, sharing=sharing)
    never = AsyncMock(side_effect=AssertionError("Exact packet reuses indexed evidence"))
    service = DriveRequestPackageService(
        store=store,
        facts=reusable.facts,
        packets=reusable.packets,
        reader_factory=never,
        document_assessor=never,
        package_assessor=never,
        wake=AsyncMock(),
    )
    assert await service.run_one(user_id="owner", job_id=found["jobId"]) == "queued"
    assert await service.run_one(user_id="owner", job_id=found["jobId"]) == "ready"
    review = await store.package_review(user_id="owner", request_id=request["requestId"])
    with sharing.db.engine.begin() as connection:
        row = sharing._request(connection, "owner", request["requestId"])
    await sharing.allow_request(
        user_id="owner",
        request_id=request["requestId"],
        revision=row["revision"],
        amount_cents=None,
        package_revision=review["revision"],
        package_digest=review["digest"],
    )
    bulk = DriveBulkShareStore(db=sharing.db)
    prepared = await DriveRequestBulkService(
        sharing=sharing,
        search=search,
        bulk=bulk,
        require_owner=AsyncMock(),
        recipient_identity=AsyncMock(return_value=recipient()),
        wake=AsyncMock(),
    ).prepare(user_id="owner", request_id=request["requestId"], positions=[1])
    context = await sharing.request_bulk_context(user_id="owner", request_id=request["requestId"])
    files = await bulk.package_sources(user_id="owner", request_id=request["requestId"])
    result = PackageAccessResult(
        user_id="owner",
        request_id=request["requestId"],
        request_revision=context["revision"],
        checked_at=datetime.now(UTC),
        status="all_existing",
        recipient={**context["recipient"], "user_id": context["recipientUserId"]},
        files=tuple(
            {
                **item,
                "access": "present",
                "permission": {
                    "id": "synthetic-existing-permission",
                    "type": "user",
                    "role": "reader",
                },
            }
            for item in files
        ),
    )
    completion = DrivePackageExistingAccessStore(db=sharing.db, cipher=bulk.cipher)
    return completion, result, prepared, bulk


async def test_existing_access_finishes_exact_delivery_without_payment_or_managed_grant(
    approved_access, sharing
):
    completion, result, prepared, bulk = approved_access
    expected = {"requestId": result.request_id, "existingAccess": True}
    assert (
        await completion.complete(user_id="owner", request_id=result.request_id, result=result)
        == expected
    )
    assert (
        await completion.complete(user_id="owner", request_id=result.request_id, result=result)
        == expected
    )
    with sharing.db.engine.connect() as connection:
        request = sharing._request(connection, "owner", result.request_id)
        assert request["status"] == "completed" and request["payment_required"] is False
        assert (
            connection.execute(
                text("SELECT count(*) FROM drive_request_payment_orders")
            ).scalar_one()
            == 0
        )
        effect = connection.execute(text("SELECT * FROM drive_bulk_share_effects")).mappings().one()
        assert effect["state"] == "preexisting"
        receipt = bulk._open(
            effect["receipt_envelope"],
            user_id="owner",
            resource_id=f"{effect['share_id']}:{effect['position']}:recipient",
            purpose="bulk-share-receipt",
        )
        assert (
            receipt["managed"] is False and receipt["provenance"] == "existing_acl_before_checkout"
        )
    delivered = await bulk.recipient_files(
        recipient_user_id="recipient",
        recipient_subject=result.recipient["subject"],
        recipient_email=result.recipient["email"],
        share_id=prepared["shareId"],
    )
    assert delivered["sharedCount"] == 1
    assert delivered["files"][0]["status"] == "preexisting"
    assert delivered["files"][0]["openUrl"].startswith("https://drive.google.com/file/d/")


@pytest.mark.parametrize(
    "change", ["stale", "expired_permission", "changed_source", "revoked_processing", "mixed"]
)
async def test_changed_or_unproven_existing_access_never_commits_delivery(
    approved_access, sharing, change
):
    completion, result, _, _ = approved_access
    if change == "stale":
        result = replace(result, checked_at=datetime.now(UTC) - timedelta(seconds=61))
    elif change == "expired_permission":
        result = replace(
            result,
            files=tuple(
                {
                    **item,
                    "permission": {**item["permission"], "expirationTime": "2000-01-01T00:00:00Z"},
                }
                for item in result.files
            ),
        )
    elif change == "mixed":
        result = replace(result, status="mixed")
    else:
        with sharing.db.engine.begin() as connection:
            sql = (
                "UPDATE connected_documents SET source_version='2'"
                if change == "changed_source"
                else "UPDATE connected_documents SET processing_enabled=FALSE"
            )
            connection.execute(text(sql))
    with pytest.raises(DriveReadError):
        await completion.complete(user_id="owner", request_id=result.request_id, result=result)
    with sharing.db.engine.connect() as connection:
        assert sharing._request(connection, "owner", result.request_id)["status"] == "pending"
        assert (
            connection.execute(text("SELECT count(*) FROM drive_bulk_share_effects")).scalar_one()
            == 0
        )
