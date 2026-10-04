"""Live request routing and exact owner selection in isolated Postgres."""

# ruff: noqa: F401, F811 -- shared isolated PostgreSQL fixtures
import json
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from sqlalchemy import text

from hushh_mcp.services.drive_live_preferences import DriveLivePreferences
from hushh_mcp.services.drive_sharing_contract import (
    DriveSharingError,
    ShareRequestPurpose,
    VerifiedGoogleRecipient,
)
from hushh_mcp.services.drive_suggestion_service import DriveSuggestionService
from hushh_mcp.services.drive_suggestion_store import DriveSuggestionStore
from hushh_mcp.services.google_drive_adapter import LIVE_POLICY_HASH, DriveReadError
from tests.services.test_drive_sharing_store import (
    MIGRATIONS,
    connector_postgres_url,
    documents,
    drive,
    drive_connect,
    lifecycle,
    rows,
    sharing,
)


@pytest.fixture
async def live_journey(sharing, monkeypatch):
    monkeypatch.setenv("GOOGLE_DRIVE_LIVE", "true")
    with sharing.db.engine.connect() as connection:
        connection.execute(
            text(
                "UPDATE external_mcp_connectors SET oauth_scopes='openid email https://www.googleapis.com/auth/drive.file' WHERE connector_id='google_drive'"
            )
        )
        connection.commit()
        # Execute SQL verbatim: this migration contains JSON colons and PL/pgSQL %I.
        with connection.connection.driver_connection.cursor() as cursor:
            cursor.execute((MIGRATIONS / "241_drive_live_sharing.sql").read_text())
        connection.execute(
            text(
                "UPDATE user_external_connector_connections SET verified_policy_hash=:policy WHERE user_id='owner'"
            ),
            {"policy": LIVE_POLICY_HASH},
        )
        connection.commit()
    store = DriveSuggestionStore(db=sharing.db, authority_key="synthetic-ledger-key")
    preferences = DriveLivePreferences(db=store.db)
    await preferences.set_background(user_id="owner", enabled=False, confirmed=True)
    counter = [0]

    def reader_factory(*, user_id, require_access):
        counter[0] += 1
        document = str(uuid4())
        ref = "document:" + "a" * 32
        source = {
            "document_id": document,
            "file_id": f"new-file-{counter[0]}",
            "name": "Requested document",
            "source_version": "1",
            "content_fingerprint": str(counter[0]) * 64,
            "connection_generation": 1,
            "_live": True,
        }

        match = {"file_id": source["file_id"], "name": source["name"]}

        # The reader's real call shape: a typed metadata search, then reads of
        # exactly the files it found.
        async def find(*, query, file_kind="any", shared_with_me=False, recent=False, **bounds):
            assert query == ["records"] and not bounds
            await require_access()
            return {"matches": [match], "truncated": False}

        async def read_matches(*, matches, truncated=False):
            assert matches == [match]
            await require_access()
            return {
                "untrusted_external_content": [
                    {
                        "source_ref": ref,
                        "document_ref": document,
                        "text": "Requested records",
                        "page": None,
                    }
                ],
                "truncated": truncated,
            }

        return SimpleNamespace(
            find=find, read_matches=read_matches, require_current=require_access, _rows=[source]
        )

    async def interpret(**kwargs):
        item = json.loads(kwargs["prompt"])["retrieved_documents"]["untrusted_external_content"][0]
        return {
            "files": [{"document_ref": item["document_ref"], "source_refs": [item["source_ref"]]}],
            "coverage_summary": "Requested records found",
            "gaps": [],
            "coverage_status": "complete",
            "covered_periods": [],
        }

    def service(owner=None):
        return DriveSuggestionService(
            oauth=SimpleNamespace(),
            store=store,
            reader_factory=reader_factory,
            interpreter=interpret,
            search_planner=AsyncMock(return_value={"terms": ["records"]}),
            require_owner=owner,
            candidate_selector=AsyncMock(return_value={"selected": ["c1"]}),
        )

    async def create(purpose):
        today = datetime.now(UTC).date()
        return await store.create_request(
            recipient=VerifiedGoogleRecipient(
                "recipient", "1234567", "recipient@example.invalid", datetime.now(UTC)
            ),
            owner_user_id="owner",
            client_request_id=str(uuid4()),
            purpose=ShareRequestPurpose(
                purpose=purpose,
                periodStart=(today - timedelta(days=30)).isoformat(),
                periodEnd=today.isoformat(),
            ),
        )

    return store, preferences, service, create


async def test_live_request_uses_durable_search_without_legacy_foreground_review(live_journey):
    store, _, service, create = live_journey
    request = await create("First document")
    request_id = request["requestId"]
    owner = AsyncMock()
    foreground = service(owner)
    assert await service().run_one(user_id="owner", request_id=request_id) == "not_claimed"
    assert await foreground.run_one(user_id="owner", request_id=request_id) == "not_claimed"
    foreground.search_planner.assert_not_awaited()
    assert owner.await_count == 1
    review = await store.owner_review(user_id="owner", request_id=request_id)
    assert review["durableAvailable"] and not review["canApprove"]
    assert review["files"] == []
    assert (await store.request_status(user_id="recipient", request_id=request_id))[
        "status"
    ] == "pending"
    assert not rows(store, "drive_share_reviews")
    assert not rows(store, "drive_share_permission_operations")
    assert not rows(store, "connected_documents")


async def test_background_drain_cannot_prepare_ordinary_live_request(live_journey):
    store, preferences, service, create = live_journey
    await preferences.set_background(user_id="owner", enabled=True, confirmed=True)
    request = await create("Different document and purpose")
    request_id = request["requestId"]
    assert request_id not in {str(item["request_id"]) for item in await store.due_preparations()}
    background = service()
    assert await background.run_one(user_id="owner", request_id=request_id) == "not_claimed"
    background.search_planner.assert_not_awaited()
    context = await store.request_bulk_context(user_id="owner", request_id=request_id, start=True)
    assert context["searchStarted"]
    assert context["recipientUserId"] == "recipient"
    assert request_id not in {str(item["request_id"]) for item in await store.due_preparations()}
    assert (await store.request_status(user_id="recipient", request_id=request_id))[
        "status"
    ] == "pending"
    assert not rows(store, "drive_share_reviews")
    assert not rows(store, "drive_share_permission_operations")


async def test_period_request_keeps_dates_for_durable_search_without_legacy_recency_plan(
    live_journey,
):
    store, _, service_factory, _ = live_journey
    created = await store.create_request(
        recipient=VerifiedGoogleRecipient(
            "recipient", "1234567", "recipient@example.invalid", datetime.now(UTC)
        ),
        owner_user_id="owner",
        client_request_id=str(uuid4()),
        purpose=ShareRequestPurpose(
            purpose="Files from the last two days",
            periodStart="2026-09-22",
            periodEnd="2026-09-24",
        ),
    )
    request_id = created["requestId"]
    service = service_factory(AsyncMock())
    assert await service.run_one(user_id="owner", request_id=request_id) == "not_claimed"
    service.search_planner.assert_not_awaited()
    service.candidate_selector.assert_not_awaited()
    review = await store.owner_review(user_id="owner", request_id=request_id)
    assert review["durableAvailable"] and not review["canApprove"]
    assert review["purpose"]["periodStart"] == "2026-09-22"
    assert review["purpose"]["periodEnd"] == "2026-09-24"
    context = await store.request_bulk_context(user_id="owner", request_id=request_id, start=True)
    assert context["searchStarted"]
    assert context["purpose"] == review["purpose"]
    assert not rows(store, "drive_share_reviews")
    assert not rows(store, "drive_share_permission_operations")


async def test_revoked_owner_cannot_start_legacy_review_or_grant(live_journey):
    store, _, service, create = live_journey
    item = await create("Requested records")
    owner = AsyncMock(side_effect=PermissionError("revoked"))
    with pytest.raises(PermissionError, match="revoked"):
        await service(owner).run_one(user_id="owner", request_id=item["requestId"])
    assert (await store.request_status(user_id="recipient", request_id=item["requestId"]))[
        "status"
    ] == "pending"
    assert not rows(store, "drive_share_reviews")
    assert not rows(store, "drive_share_permission_operations")


async def test_owner_selected_files_bind_metadata_only_and_queue_viewer_grants(live_journey):
    """A shares files picked from B's answered question: no planner, model or read."""
    store, _, service_factory, _ = live_journey
    created = await store.create_request(
        recipient=VerifiedGoogleRecipient(
            "recipient", "1234567", "recipient@example.invalid", datetime.now(UTC)
        ),
        owner_user_id="owner",
        client_request_id=str(uuid4()),
        purpose=ShareRequestPurpose(purpose="Last 6 months bank statement"),
        owner_initiated=True,
    )
    request_id = created["requestId"]
    document_id = str(uuid4())
    source = {
        "document_id": document_id,
        "file_id": "chosen-file-1",
        "name": "HDFC statement Apr 2026.pdf",
        "source_version": "3",
        "content_fingerprint": None,
        "connection_generation": 1,
        "metadata_only": True,
        "_live": True,
    }
    observed = {}

    def reader_factory(*, user_id, require_access):
        async def bind_matches(**kwargs):
            await require_access()
            observed.update(kwargs)
            source.update(
                time_field=kwargs["time_field"],
                start_time=kwargs["start_time"],
                end_time=kwargs["end_time"],
            )
            return {
                "untrusted_external_content": [
                    {
                        "document_ref": document_id,
                        "source_ref": "document:" + "c" * 32,
                        "name": source["name"],
                        "text": "Verified file metadata only",
                    }
                ],
                "truncated": False,
            }

        return SimpleNamespace(
            bind_matches=bind_matches,
            find=AsyncMock(side_effect=AssertionError("searched")),
            read_matches=AsyncMock(side_effect=AssertionError("content read")),
            require_current=require_access,
            _rows=[source],
        )

    service = service_factory(AsyncMock())
    service.reader_factory = reader_factory
    service.search_planner = AsyncMock(side_effect=AssertionError("planner"))
    service.interpreter = AsyncMock(side_effect=AssertionError("interpreter"))
    chosen = [{"file_id": "chosen-file-1", "name": source["name"], "mime_type": "application/pdf"}]
    assert (
        await service.run_one(user_id="owner", request_id=request_id, owner_selected=chosen)
        == "review_ready"
    )
    assert observed["matches"] == chosen and observed["time_field"] == "modifiedTime"
    # A approves these exact files next: no "ready to review" alert about A's own tap.
    assert "document_share_review_ready" not in {
        item["event_type"] for item in rows(store, "drive_share_events")
    }
    review = await store.owner_review(user_id="owner", request_id=request_id)
    assert review["canApprove"] and [item["documentId"] for item in review["files"]] == [
        document_id
    ]
    assert review["coverage"]["coverage_status"] == "unknown"
    await store.approve_review(
        user_id="owner",
        generation=1,
        request_id=request_id,
        revision=review["revision"],
        review_digest=review["reviewDigest"],
        document_ids=[document_id],
        confirmed=True,
    )
    grants = rows(store, "drive_share_permission_operations")
    assert [str(item["document_id"]) for item in grants] == [document_id]


async def test_a_failed_owner_selection_does_not_alert_the_owner(live_journey):
    """A's own share that cannot bind is answered on A's card, never by a push
    telling A that files are ready to review."""
    store, _, service_factory, _ = live_journey
    created = await store.create_request(
        recipient=VerifiedGoogleRecipient(
            "recipient", "1234567", "recipient@example.invalid", datetime.now(UTC)
        ),
        owner_user_id="owner",
        client_request_id=str(uuid4()),
        purpose=ShareRequestPurpose(purpose="Chris onboarding recordings"),
        owner_initiated=True,
    )

    def reader_factory(*, user_id, require_access):
        async def bind_matches(**kwargs):
            await require_access()
            raise DriveReadError("source_changed")

        return SimpleNamespace(
            bind_matches=bind_matches,
            find=AsyncMock(side_effect=AssertionError("searched")),
            read_matches=AsyncMock(side_effect=AssertionError("content read")),
            require_current=require_access,
            _rows=[],
        )

    service = service_factory(AsyncMock())
    service.reader_factory = reader_factory
    service.search_planner = AsyncMock(side_effect=AssertionError("planner"))
    service.interpreter = AsyncMock(side_effect=AssertionError("interpreter"))
    chosen = [{"file_id": "chosen-file-1", "name": "Recording.mp4", "mime_type": "video/mp4"}]
    assert (
        await service.run_one(
            user_id="owner", request_id=created["requestId"], owner_selected=chosen
        )
        == "unavailable"
    )
    assert "document_share_review_ready" not in {
        item["event_type"] for item in rows(store, "drive_share_events")
    }


async def test_owner_selection_is_refused_without_owner_authority(live_journey):
    store, _, service_factory, _ = live_journey
    service = service_factory(None)
    with pytest.raises(DriveReadError, match="owner_authority_required"):
        await service.run_one(user_id="owner", request_id=str(uuid4()), owner_selected=[])


async def test_an_owner_share_request_stays_out_of_the_background_lane(live_journey):
    store, preferences, _, _ = live_journey
    await preferences.set_background(user_id="owner", enabled=True, confirmed=True)
    created = await store.create_request(
        recipient=VerifiedGoogleRecipient(
            "recipient", "1234567", "recipient@example.invalid", datetime.now(UTC)
        ),
        owner_user_id="owner",
        client_request_id=str(uuid4()),
        purpose=ShareRequestPurpose(purpose="Last 6 months bank statement"),
        owner_initiated=True,
    )
    request_id = created["requestId"]
    # A is not told about A's own share, and the worker never prepares it.
    assert not [event for event in rows(store, "drive_share_events") if event["user_id"] == "owner"]
    assert request_id not in {item["request_id"] for item in await store.due_preparations()}
    assert await store.claim_preparation(user_id="owner", request_id=request_id) is None
    assert (
        await store.claim_preparation(user_id="owner", request_id=request_id, foreground=True)
        is None
    )
    claimed = await store.claim_preparation(
        user_id="owner", request_id=request_id, foreground=True, owner_selected=True
    )
    assert claimed is not None and claimed["request_id"] == request_id
