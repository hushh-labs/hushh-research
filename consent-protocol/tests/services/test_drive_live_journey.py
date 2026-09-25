"""Zero-index foreground review and trusted background repeat in isolated Postgres."""

# ruff: noqa: F401, F811 -- shared isolated PostgreSQL fixtures
import json
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from sqlalchemy import text

from hushh_mcp.services.drive_live_preferences import DriveLivePreferences
from hushh_mcp.services.drive_permission_executor import DrivePermissionExecutor
from hushh_mcp.services.drive_permission_store import DrivePermissionStore
from hushh_mcp.services.drive_permission_worker import DrivePermissionWorker
from hushh_mcp.services.drive_sharing_contract import (
    BROAD_TRUST_DISCLOSURE,
    BROAD_TRUST_SCOPE,
    DriveSharingError,
    ShareRequestPurpose,
    VerifiedGoogleRecipient,
)
from hushh_mcp.services.drive_sharing_projection_store import DriveSharingProjectionStore
from hushh_mcp.services.drive_sharing_service import DriveSharingService
from hushh_mcp.services.drive_suggestion_service import DriveSuggestionService
from hushh_mcp.services.drive_suggestion_store import DriveSuggestionStore
from hushh_mcp.services.google_drive_adapter import LIVE_POLICY_HASH, DriveReadError
from hushh_mcp.services.google_drive_permission_adapter import CreatedReader, PermissionSnapshot
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
        return await store.create_request(
            recipient=VerifiedGoogleRecipient(
                "recipient", "1234567", "recipient@example.invalid", datetime.now(UTC)
            ),
            owner_user_id="owner",
            client_request_id=str(uuid4()),
            purpose=ShareRequestPurpose(purpose=purpose),
        )

    return store, preferences, service, create


async def test_zero_index_foreground_then_new_file_trusted_repeat_and_revocation(live_journey):
    store, preferences, service, create = live_journey
    first = await create("First document")
    with pytest.raises(DriveReadError, match="background_preparation_required"):
        await service().run_one(user_id="owner", request_id=first["requestId"])
    owner = AsyncMock()
    assert (
        await service(owner).run_one(user_id="owner", request_id=first["requestId"])
        == "review_ready"
    )
    assert owner.await_count > 3
    review = await store.owner_review(user_id="owner", request_id=first["requestId"])
    assert review["canApprove"]
    assert not rows(store, "connected_documents")
    with store.db.engine.connect() as connection:
        assert connection.execute(text("SELECT COUNT(*) FROM document_chunks")).scalar_one() == 0
    await store.approve_review(
        user_id="owner",
        generation=1,
        request_id=first["requestId"],
        revision=review["revision"],
        review_digest=review["reviewDigest"],
        document_ids=[item["documentId"] for item in review["files"]],
        confirmed=True,
        trust_future_requests=True,
        trust_scope=BROAD_TRUST_SCOPE,
        trust_disclosure_version=BROAD_TRUST_DISCLOSURE,
    )
    await preferences.set_background(user_id="owner", enabled=True, confirmed=True)
    second = await create("Different document and purpose")
    assert (
        await service().run_one(user_id="owner", request_id=second["requestId"]) == "review_ready"
    )
    assert (await store.request_status(user_id="recipient", request_id=second["requestId"]))[
        "status"
    ] == "approved"
    rule = (await store.list_rules(user_id="owner"))["items"][0]
    assert rule["scope"] == BROAD_TRUST_SCOPE and rule["readiness"] == "ready"
    operation = next(
        item
        for item in rows(store, "drive_share_permission_operations")
        if str(item["request_id"]) == second["requestId"]
    )
    permissions = DrivePermissionStore(db=store.db, authority_key="synthetic-ledger-key")
    with store.db.engine.begin() as connection:
        assert permissions._grant_authority(connection, operation)["rule_id"] == rule["ruleId"]
    await store.revoke_rule(
        user_id="owner", rule_id=rule["ruleId"], version=rule["version"], confirmed=True
    )
    with pytest.raises(DriveSharingError, match="approval_superseded"):
        await permissions.claim_grant(user_id="owner", operation_id=str(operation["operation_id"]))


async def test_trusted_rule_grants_a_future_file_while_owner_is_away_and_recipient_opens_the_original(
    live_journey,
):
    """S19/S16: A trusts B once; a later request is prepared and delivered with no
    owner session, and B opens the original Drive file, never a copy."""
    store, preferences, service, create = live_journey
    first = await create("First document")
    owner = AsyncMock()
    assert (
        await service(owner).run_one(user_id="owner", request_id=first["requestId"])
        == "review_ready"
    )
    review = await store.owner_review(user_id="owner", request_id=first["requestId"])
    await store.approve_review(
        user_id="owner",
        generation=1,
        request_id=first["requestId"],
        revision=review["revision"],
        review_digest=review["reviewDigest"],
        document_ids=[item["documentId"] for item in review["files"]],
        confirmed=True,
        trust_future_requests=True,
        trust_scope=BROAD_TRUST_SCOPE,
        trust_disclosure_version=BROAD_TRUST_DISCLOSURE,
    )
    await preferences.set_background(user_id="owner", enabled=True, confirmed=True)
    owner_calls = owner.await_count
    second = await create("Different document and purpose")
    assert (
        await service().run_one(user_id="owner", request_id=second["requestId"]) == "review_ready"
    )

    # The scheduled drain: the real worker and executor, synthetic Google boundary.
    oauth = SimpleNamespace(
        current_credential=AsyncMock(
            return_value=(
                {"connection_generation": 1},
                {
                    "accessToken": "synthetic-token",
                    "subject": "12345",
                    "oauthClientId": "synthetic-client",
                },
            )
        )
    )
    adapter = SimpleNamespace(
        inspect_shareable=AsyncMock(),
        list_permissions=AsyncMock(return_value=PermissionSnapshot(())),
        create_reader=AsyncMock(
            return_value=CreatedReader("synthetic-permission", "recipient@example.invalid")
        ),
        remove_recorded_permission=AsyncMock(),
    )
    worker = DrivePermissionWorker(
        DrivePermissionExecutor(
            store=DrivePermissionStore(db=store.db, authority_key="synthetic-ledger-key"),
            oauth=oauth,
            adapter=adapter,
            verify_recipient=AsyncMock(),
        )
    )
    assert (await worker.run())["outcomes"] == {"succeeded": 2}
    assert oauth.current_credential.await_count == 2
    assert all(
        call.kwargs["required_profile"] == "live"
        for call in oauth.current_credential.await_args_list
    )
    inspected = {
        call.kwargs["file_id"]: call.kwargs for call in adapter.inspect_shareable.await_args_list
    }
    assert set(inspected) == {"new-file-1", "new-file-2"}
    assert inspected["new-file-2"]["require_app_authorized"] is False
    assert inspected["new-file-2"]["require_genai_eligibility"] is False
    assert {call.kwargs["verified_email"] for call in adapter.create_reader.await_args_list} == {
        "recipient@example.invalid"
    }
    # Nothing on the second request needed the owner to be present.
    assert owner.await_count == owner_calls

    sharing_view = DriveSharingService(
        oauth=object(),
        store=DriveSharingProjectionStore(db=store.db, authority_key="synthetic-ledger-key"),
        verify_recipient=AsyncMock(),
    )
    delivered = await sharing_view.delivery(user_id="recipient", request_id=second["requestId"])
    assert [item["openUrl"] for item in delivered["files"]] == [
        "https://drive.google.com/file/d/new-file-2/view"
    ]
    assert delivered["files"][0]["name"] == "Requested document"
    assert "new-file-1" not in str(delivered)
    foreground = await sharing_view.delivery(user_id="recipient", request_id=first["requestId"])
    assert [item["openUrl"] for item in foreground["files"]] == [
        "https://drive.google.com/file/d/new-file-1/view"
    ]


@pytest.mark.parametrize(
    "plan",
    [
        {"relative_days": 2, "mode": "find", "time_intent": "file_activity"},
        # Calendar days and a file type must keep the metadata-only path and the type.
        {
            "date_from": "2026-09-22",
            "date_to": "2026-09-24",
            "file_kind": "pdf",
            "mode": "find",
            "time_intent": "file_activity",
        },
    ],
)
async def test_recency_card_dates_bind_private_metadata_through_approved_permission_plan(
    live_journey, plan
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
    document_id = str(uuid4())
    file_id = "recent-file-1"
    source_ref = "document:" + "b" * 32
    observed = {}
    source = {
        "document_id": document_id,
        "file_id": file_id,
        "name": "Recent.pdf",
        "source_version": "7",
        "content_fingerprint": None,
        "connection_generation": 1,
        "metadata_only": True,
        "_live": True,
    }

    def reader_factory(*, user_id, require_access):
        assert user_id == "owner"

        async def find(**kwargs):
            await require_access()
            observed["find"] = kwargs
            return {"matches": [{"file_id": file_id, "name": "Recent.pdf"}], "truncated": False}

        async def bind_matches(**kwargs):
            await require_access()
            observed["bind"] = kwargs
            source.update(
                time_field=kwargs["time_field"],
                start_time=kwargs["start_time"],
                end_time=kwargs["end_time"],
            )
            return {
                "untrusted_external_content": [
                    {
                        "document_ref": document_id,
                        "source_ref": source_ref,
                        "name": "Recent.pdf",
                        "text": "Verified file metadata only",
                    }
                ],
                "truncated": False,
            }

        return SimpleNamespace(
            find=find,
            bind_matches=bind_matches,
            search=AsyncMock(),
            require_current=require_access,
            _rows=[source],
        )

    owner = AsyncMock()
    service = service_factory(owner)
    service.reader_factory = reader_factory
    service.search_planner = AsyncMock(return_value=plan)
    service.interpreter = AsyncMock()
    assert await service.run_one(user_id="owner", request_id=request_id) == "review_ready"
    assert observed["find"]["query"] == []
    assert observed["find"].get("file_kind", "any") == plan.get("file_kind", "any")
    assert observed["find"]["time_field"] == "modifiedTime"
    assert observed["bind"]["start_time"] == observed["find"]["start_time"]
    assert observed["bind"]["end_time"] == observed["find"]["end_time"]
    service.interpreter.assert_not_awaited()

    review = await store.owner_review(user_id="owner", request_id=request_id)
    assert review["canApprove"] and len(review["files"]) == 1
    assert review["coverage"]["coverage_status"] == "complete"
    assert review["coverage"]["covered_periods"] == []
    assert not rows(store, "connected_documents")
    with store.db.engine.connect() as connection:
        assert connection.execute(text("SELECT COUNT(*) FROM document_chunks")).scalar_one() == 0

    await store.approve_review(
        user_id="owner",
        generation=1,
        request_id=request_id,
        revision=review["revision"],
        review_digest=review["reviewDigest"],
        document_ids=[document_id],
        confirmed=True,
    )
    operation = next(
        item
        for item in rows(store, "drive_share_permission_operations")
        if str(item["request_id"]) == request_id
    )
    assert file_id not in json.dumps(operation["plan_envelope"])
    plan = store.sharing_cipher.open(
        operation["plan_envelope"],
        user_id="owner",
        resource_id=str(operation["operation_id"]),
        purpose="permission-plan",
    )
    assert plan["file_id"] == file_id
    assert plan["source_kind"] == "live"
    assert plan["metadata_only"] is True
    assert plan["time_field"] == "modifiedTime"
    assert plan["start_time"] == observed["find"]["start_time"]
    assert plan["end_time"] == observed["find"]["end_time"]


async def test_foreground_owner_revoked_before_publication_has_no_review_or_grant(live_journey):
    store, _, service, create = live_journey
    item = await create("Requested records")
    owner = AsyncMock()
    owner.side_effect = [None, None, PermissionError("revoked")]
    assert (
        await service(owner).run_one(user_id="owner", request_id=item["requestId"]) == "unavailable"
    )
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
