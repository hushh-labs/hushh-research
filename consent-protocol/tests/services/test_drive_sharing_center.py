"""Real PostgreSQL projection and mixed-source Consent Center pagination."""

# ruff: noqa: F811 -- imported pytest fixtures

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from sqlalchemy import create_engine, text

from hushh_mcp.services.consent_center_service import ConsentCenterService
from hushh_mcp.services.drive_sharing_center_contributor import DriveSharingCenterContributor
from tests.services.test_drive_permission_executor import (  # noqa: F401
    connector_postgres_url,
    documents,
    drive,
    drive_connect,
    lifecycle,
    permission_setup,
    rows,
    sharing,
)
from tests.services.test_drive_sharing_store import request, review


@pytest.mark.asyncio
async def test_legacy_sqlite_has_no_drive_projection_or_postgres_transaction():
    engine = create_engine("sqlite://")
    try:
        projection = DriveSharingCenterContributor(db=SimpleNamespace(engine=engine))
        with patch.object(projection, "_transaction", new_callable=AsyncMock) as transaction:
            counts = await projection.counts("owner")
            assert counts == {
                "incoming_requests": 0,
                "outgoing_requests": 0,
                "active_grants": 0,
                "history": 0,
                "schema_available": False,
            }
            assert await projection.page("owner", bucket="history", limit=10) == {
                "total": 0,
                "items": [],
                "schema_available": False,
            }
            preview = await projection.preview("owner")
            assert preview["schema_available"] is False
            assert all(value == [] for value in preview["buckets"].values())
            assert all(value == 0 for value in preview["counts"].values())
            with pytest.raises(ValueError, match="invalid_document_projection_page"):
                await projection.page("owner", bucket="arbitrary", limit=10)
            transaction.assert_not_called()
    finally:
        engine.dispose()


def center(store):
    service = ConsentCenterService.__new__(ConsentCenterService)
    service._drive_center = DriveSharingCenterContributor(db=store.db)
    empty = {
        key: []
        for key in ("incoming_requests", "outgoing_requests", "active_grants", "history", "invites")
    }
    service._location_buckets_async = AsyncMock(return_value=empty)
    service._marketplace_buckets_async = AsyncMock(return_value=empty)
    service._load_investor_pending_entries = AsyncMock(return_value=[])
    service._load_investor_active_entries = AsyncMock(return_value=[])
    service._load_investor_previous_entries = AsyncMock(return_value=[])
    service._incoming_connection_request_count = AsyncMock(return_value=0)
    service._incoming_connection_request_entries = AsyncMock(return_value=[])
    service._load_connection_entries_for_actor = AsyncMock(return_value=[])
    return service


@pytest.mark.asyncio
async def test_metadata_only_previews_counts_and_filtered_pages(sharing, monkeypatch):
    for _ in range(61):
        await request(sharing)
    projection = DriveSharingCenterContributor(db=sharing.db)
    monkeypatch.delenv("DRIVE_SHARING_KEY_V1")
    monkeypatch.delenv("DRIVE_DOCUMENT_KEY_V1")
    monkeypatch.setenv("DRIVE_DOCUMENT_SHARING", "false")
    snapshot = await projection.preview("owner")
    assert snapshot["counts"]["incoming_requests"] == 61
    assert len(snapshot["buckets"]["incoming_requests"]) == 50
    assert (await projection.counts("recipient"))["incoming_requests"] == 0
    assert (await projection.counts("recipient"))["outgoing_requests"] == 61
    assert (await projection.counts("stranger"))["incoming_requests"] == 0
    page = await projection.page("owner", bucket="incoming_requests", limit=20, offset=60)
    assert page["total"] == 61 and len(page["items"]) == 1
    assert (await projection.page("owner", bucket="incoming_requests", limit=20, offset=9999))[
        "total"
    ] == 61
    assert (await projection.page("owner", bucket="incoming_requests", limit=20, query="%"))[
        "total"
    ] == 0
    assert (
        await projection.page(
            "owner", bucket="incoming_requests", limit=20, query="private six-month"
        )
    )["total"] == 0
    row = page["items"][0]
    assert row["scope"] is None and isinstance(row["issued_at"], int)
    assert set(row["metadata"]) == {
        "request_source",
        "request_id",
        "direction",
        "state",
        "revision",
        "recorded_outcome_only",
    }
    assert "recipient@example" not in str(snapshot) and "purpose" not in str(snapshot)
    assert (
        await projection.page(
            "owner", bucket="incoming_requests", limit=20, query=row["request_id"]
        )
    )["total"] == 1
    service = center(sharing)
    service._owned_user_identifiers = AsyncMock(return_value=[])
    service._hydrate_entry_identities = AsyncMock(side_effect=lambda entries: entries)
    service._consent_db = MagicMock()
    service._consent_db.get_pending_requests = AsyncMock(return_value=[])
    service._consent_db.get_active_tokens = AsyncMock(return_value=[])
    service._consent_db.get_audit_log = AsyncMock(return_value={"items": []})
    service._consent_db.get_internal_activity_summary = AsyncMock(return_value={})
    legacy = await service.get_center("owner", actor="investor")
    assert len(legacy["incoming_requests"]) == 50
    assert legacy["summary"]["incoming_requests"] == 61
    # B can rediscover every pending request after reload, without a Drive
    # credential, document key, feature admission or A's private suggestions.
    seen = []
    for page_number in range(1, 5):
        sent = await service.list_center(
            "recipient",
            actor="investor",
            surface="pending",
            request_view="sent",
            page=page_number,
            limit=20,
        )
        assert sent["total"] == 61 and sent["request_view"] == "sent"
        seen.extend(sent["items"])
    assert len({item["id"] for item in seen}) == 61
    assert all(
        item["metadata"]["direction"] == "outgoing" and item["scope"] is None for item in seen
    )
    assert (
        await service.list_center(
            "stranger", actor="investor", surface="pending", request_view="sent"
        )
    )["total"] == 0
    assert (
        await service.list_center("owner", actor="investor", surface="pending", request_view="sent")
    )["total"] == 0
    assert (await service.list_center("recipient", actor="investor", surface="pending"))[
        "total"
    ] == 0


@pytest.mark.asyncio
async def test_pending_expiry_and_private_preparation_masking(sharing):
    await review(sharing)
    projection = DriveSharingCenterContributor(db=sharing.db)
    assert (await projection.page("recipient", bucket="outgoing_requests", limit=1))["items"][0][
        "metadata"
    ]["state"] == "pending"
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text(
                "UPDATE drive_share_requests SET created_at=now()-INTERVAL '31 days',expires_at=now()-INTERVAL '1 day'"
            )
        )
    assert (await projection.counts("owner"))["incoming_requests"] == 0
    assert (await projection.page("owner", bucket="history", limit=1))["items"][0][
        "status"
    ] == "expired"


@pytest.mark.asyncio
async def test_approval_is_not_delivery_and_recorded_revocation_is_not_active(permission_setup):
    store, executor, _, ids = permission_setup
    projection = DriveSharingCenterContributor(db=store.db)
    assert (await projection.counts("owner"))["incoming_requests"] == 1
    assert (await projection.counts("owner"))["active_grants"] == 0
    await executor.grant(user_id="owner", operation_id=ids[0])
    assert (await projection.counts("owner"))["active_grants"] == 1
    assert (await projection.counts("recipient"))["active_grants"] == 1
    # A recorded removal excludes the original grant even if a later attempt
    # is pending. We never infer current Google ACL state from this projection.
    with store.db.engine.begin() as connection:
        connection.execute(
            text("""
          INSERT INTO drive_share_permission_operations(
            operation_id,user_id,request_id,review_revision,batch_id,document_id,
            connection_generation,file_lock_hmac,kind,parent_operation_id,plan_envelope,state)
          SELECT '99999999-9999-4999-8999-999999999999',user_id,request_id,review_revision,
            'synthetic-revocation',document_id,connection_generation,file_lock_hmac,'revoke',
            operation_id,plan_envelope,'absent' FROM drive_share_permission_operations
          WHERE operation_id=:id
        """),
            {"id": ids[0]},
        )
    assert (await projection.counts("owner"))["active_grants"] == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("v2", ["true", "false"])
async def test_summary_and_list_share_authoritative_counts(sharing, monkeypatch, v2):
    await request(sharing)
    monkeypatch.setenv("CONSENT_CENTER_SUMMARY_V2_ENABLED", v2)
    service = center(sharing)
    summary = await service.get_center_summary("owner", actor="investor")
    assert summary["counts"] == {"pending": 1, "active": 0, "previous": 0}
    listed = await service.list_center("owner", actor="investor", surface="pending")
    assert listed["total"] == 1 and len(listed["items"]) == 1
    assert (await service.get_center_summary("recipient", actor="investor"))["counts"][
        "pending"
    ] == 0
    assert (await service.get_center_summary("owner", actor="investor", mode="connections"))[
        "counts"
    ]["pending"] == 0


@pytest.mark.asyncio
async def test_mixed_source_pagination_matches_full_sort_with_ties_and_filters(sharing):
    for _ in range(61):
        await request(sharing)
    with sharing.db.engine.begin() as connection:
        connection.execute(text("UPDATE drive_share_requests SET created_at=now()"))
    service = center(sharing)
    drive = await service._drive_center.page("owner", bucket="incoming_requests", limit=100)
    stamp = drive["items"][0]["issued_at"]
    existing = [
        {
            "id": identifier,
            "issued_at": stamp + offset,
            "status": "pending",
            "counterpart_label": "Google Drive files",
        }
        for identifier, offset in (("z-new", 10000), ("a-old", -10000), ("z-tie", 0), ("a-tie", 0))
    ]
    all_items = service._sort_display_entries([*existing, *drive["items"]])
    observed = []
    for page in range(1, 9):
        result = await service._paginate_with_drive(
            existing, user_id="owner", surface="pending", page=page, limit=10, query="drive"
        )
        assert result["total"] == 65
        assert result["items"] == all_items[(page - 1) * 10 : page * 10]
        observed.extend(result["items"])
    assert len({item["id"] for item in observed}) == 65


@pytest.mark.asyncio
async def test_missing_schema_is_distinct_from_an_empty_installed_schema(sharing):
    projection = DriveSharingCenterContributor(db=sharing.db)
    assert (await projection.counts("owner"))["schema_available"] is True
    # Same search_path as the queries, not a coincidental public schema.
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text(
                "ALTER TABLE drive_share_management_contexts RENAME TO temporarily_uninstalled_management"
            )
        )
    try:
        assert (await projection.counts("owner"))["schema_available"] is False
        assert (await projection.preview("owner"))["schema_available"] is False
        assert (await projection.page("owner", bucket="history", limit=10))[
            "schema_available"
        ] is False
        service = center(sharing)
        assert (await service.get_center_summary("owner", actor="investor"))[
            "drive_projection_available"
        ] is False
    finally:
        with sharing.db.engine.begin() as connection:
            connection.execute(
                text(
                    "ALTER TABLE temporarily_uninstalled_management RENAME TO drive_share_management_contexts"
                )
            )


@pytest.mark.asyncio
async def test_sql_failures_are_not_reported_as_zero(sharing):
    projection = DriveSharingCenterContributor(db=sharing.db)
    with patch.object(projection, "_installed", side_effect=RuntimeError("synthetic unavailable")):
        for operation in (
            projection.counts("owner"),
            projection.preview("owner"),
            projection.page("owner", bucket="history", limit=10),
        ):
            with pytest.raises(RuntimeError, match="synthetic unavailable"):
                await operation


def test_display_sort_does_not_change_lifecycle_tie_reduction():
    events = [{"id": "a", "issued_at": 100}, {"id": "z", "issued_at": 100}]
    assert ConsentCenterService._sort_entries(events) == events
    assert ConsentCenterService._sort_display_entries(events) == list(reversed(events))
