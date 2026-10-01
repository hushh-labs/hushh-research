"""A document request freezes every Drive match for only its verified recipient."""

# ruff: noqa: F811 -- imported isolated PostgreSQL fixtures

import asyncio
import base64
import json
import threading
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from sqlalchemy import text

from hushh_mcp.runtime_settings import clear_runtime_settings_caches
from hushh_mcp.services.connection_graph_service import lock_connection_graph_users
from hushh_mcp.services.drive_bulk_share_store import DriveBulkShareStore
from hushh_mcp.services.drive_owner_search_service import DriveOwnerSearchService
from hushh_mcp.services.drive_owner_search_store import DriveOwnerSearchStore
from hushh_mcp.services.drive_request_payment_refunds import _claim_refunds
from hushh_mcp.services.drive_request_payment_service import DriveRequestPaymentService
from hushh_mcp.services.drive_sharing_contract import (
    DriveSharingError,
    ShareRequestPurpose,
    VerifiedGoogleRecipient,
)
from hushh_mcp.services.drive_sharing_retention import erase_drive_account_in_transaction
from hushh_mcp.services.drive_sharing_service import DriveSharingService
from hushh_mcp.services.drive_suggestion_store import DriveSuggestionStore
from hushh_mcp.services.external_mcp_client import ExternalMcpToolResult
from hushh_mcp.services.google_drive_adapter import DRIVE_BASE, DRIVE_POLICY, LIVE_POLICY_HASH
from tests.services.test_drive_sharing_store import (  # noqa: F401
    MIGRATIONS,
    connector_postgres_url,
    documents,
    drive,
    drive_connect,
    lifecycle,
    sharing,
)


@pytest.fixture
def request_bulk(sharing, monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("GOOGLE_DRIVE_LIVE", "true")
    monkeypatch.setenv("DRIVE_DOCUMENT_SHARING", "true")
    monkeypatch.setenv("DRIVE_REQUEST_PAYMENTS_ENABLED", "true")
    monkeypatch.setenv("STRIPE_SECRET_KEY", "sk_test_local_only_synthetic")
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "whsec_payment_test_secret")
    monkeypatch.setenv("APP_FRONTEND_ORIGIN", "https://test.example")
    clear_runtime_settings_caches()
    monkeypatch.setenv("CONNECTOR_INTERNAL_OWNER_COHORT", "owner,recipient,trusted-member")
    monkeypatch.setenv("DRIVE_SHARING_KEY_V1", base64.b64encode(b"s" * 32).decode())
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE external_mcp_connectors SET transport_kind='google_drive_rest',
            mcp_endpoint=:endpoint,capability_policy=CAST(:policy AS jsonb)
            WHERE connector_id='google_drive'"""),
            {"endpoint": DRIVE_BASE, "policy": json.dumps(DRIVE_POLICY)},
        )
        connection.execute(
            text("""UPDATE user_external_connector_connections SET
            validation_state='verified',verified_policy_hash=:policy
            WHERE user_id='owner' AND connector_id='google_drive'"""),
            {"policy": LIVE_POLICY_HASH},
        )
        # A real accepted connection exists for B. A separate trusted-circle
        # member must never be added to this request's recipient snapshot.
        connection.execute(
            text("""CREATE TABLE IF NOT EXISTS connection_origins(
              connection_id UUID, status TEXT, origin_kind TEXT)""")
        )
        connection.execute(
            text("""CREATE TABLE IF NOT EXISTS one_location_circles(
              id UUID, owner_user_id TEXT, system_kind TEXT, status TEXT)""")
        )
        connection.execute(
            text("""CREATE TABLE IF NOT EXISTS one_location_circle_memberships(
              circle_id UUID, user_id TEXT, status TEXT)""")
        )
        connection.execute(
            text("""INSERT INTO connection_origins(connection_id,status,origin_kind)
            SELECT c.id,'active','direct_request' FROM connections c
            WHERE NOT EXISTS(SELECT 1 FROM connection_origins o
              WHERE o.connection_id=c.id AND o.status='active'
                AND o.origin_kind='direct_request')""")
        )
        trusted_connection = str(uuid4())
        circle = str(uuid4())
        connection.execute(
            text("INSERT INTO connections VALUES (:id,'owner','trusted-member','active')"),
            {"id": trusted_connection},
        )
        connection.execute(
            text("""INSERT INTO connection_origins VALUES
            (:id,'active','direct_request')"""),
            {"id": trusted_connection},
        )
        connection.execute(
            text("""INSERT INTO one_location_circles VALUES
            (:id,'owner','trusted','active')"""),
            {"id": circle},
        )
        connection.execute(
            text("""INSERT INTO one_location_circle_memberships VALUES
            (:circle,'trusted-member','active')"""),
            {"circle": circle},
        )
    yield DriveBulkShareStore(db=sharing.db)
    clear_runtime_settings_caches()


async def _request(sharing):
    return await sharing.create_request(
        recipient=VerifiedGoogleRecipient(
            "recipient", "1234567", "b@example.invalid", datetime.now(UTC)
        ),
        owner_user_id="owner",
        client_request_id=str(uuid4()),
        purpose=ShareRequestPurpose(purpose="Standup notes from last 3 months"),
    )


def _search(bulk, *, request_id, count=525, incomplete=False, shareability=None, verified=True):
    job = str(uuid4())
    rows = []
    for position in range(1, count + 1):
        file_id = f"standup-file-{position}"
        metadata = {
            "id": file_id,
            "name": f"Standup notes 2026-09-{(position % 28) + 1:02d} #{position}",
            "mimeType": "application/vnd.google-apps.document",
            "modifiedTime": "2026-09-27T00:00:00Z",
            "openUrl": f"https://drive.google.com/open?id={file_id}",
            "shareable": True,
        }
        if shareability and position in shareability:
            if shareability[position] is None:
                metadata.pop("shareable")
            else:
                metadata["shareable"] = shareability[position]
        rows.append(
            {
                "job": job,
                "user": "owner",
                "position": position,
                "digest": bulk.cipher.digest("owner-search-file", [job, file_id]),
                "envelope": bulk._seal(
                    metadata,
                    user_id="owner",
                    resource_id=f"{job}:{position}",
                    purpose="owner-search-result",
                ),
            }
        )
    with bulk.db.engine.begin() as connection:
        request_revision = connection.execute(
            text("""UPDATE drive_share_requests SET bulk_search_started_at=clock_timestamp()
            WHERE request_id=:request RETURNING revision"""),
            {"request": request_id},
        ).scalar_one()
        connection.execute(
            text("""INSERT INTO drive_owner_search_jobs(
              job_id,user_id,client_request_id,request_digest,connection_generation,
              consent_version,status,revision,matched,pages_scanned,incomplete_search,
              checkpoint_envelope)
              VALUES(:job,'owner',:client,:digest,1,'drive-owner-search-v1',
                :status,24,:count,23,:incomplete,CAST(:checkpoint AS jsonb))"""),
            {
                "job": job,
                "client": request_id,
                "digest": bulk.cipher.digest("test-request", [job]),
                "status": "limited" if incomplete else "completed",
                "count": count,
                "incomplete": incomplete,
                "checkpoint": bulk._seal(
                    {
                        "done": not incomplete,
                        "request_origin_id": request_id,
                        "request_revision": request_revision,
                        **({"request_shareability_version": 1} if verified else {}),
                    },
                    user_id="owner",
                    resource_id=job,
                    purpose="owner-search-checkpoint",
                ),
            },
        )
        connection.execute(
            text("""INSERT INTO drive_owner_search_results(
              job_id,user_id,position,file_digest,metadata_envelope)
              VALUES(:job,:user,:position,:digest,CAST(:envelope AS jsonb))"""),
            rows,
        )
    return job


async def _complete_shared_drive_search(bulk, sharing, *, request_id):
    """Collect 25 personal and 500 shared-drive files through checkpointed pages."""
    context = await sharing.request_bulk_context(user_id="owner", request_id=request_id, start=True)
    store = DriveOwnerSearchStore(db=bulk.db)
    arguments = {"query": "name contains 'Standup'", "orderBy": "modifiedTime desc"}
    today = datetime.now(UTC).date()
    period = {
        "start": (today - timedelta(days=90)).isoformat(),
        "end": today.isoformat(),
        "timezone": "UTC",
    }
    older_modified = (today - timedelta(days=120)).isoformat() + "T00:00:00Z"
    state, created = await store.create(
        user_id="owner",
        client_request_id=request_id,
        request={"query": "Standup notes from last 3 months", "timezone": "UTC"},
        confirmed=True,
        checkpoint={
            "request": {"query": "Standup notes from last 3 months", "timezone": "UTC"},
            "request_origin_id": request_id,
            "request_revision": context["revision"],
            "request_shareability_version": 1,
            "arguments": arguments,
            "queries": [{"arguments": arguments}],
            "query_index": 0,
            "requested_period": period,
            "phase": "user",
            "page_token": None,
            "drive_page_token": None,
            "drives": [],
            "drive_index": 0,
            "seen_tokens": [],
            "drive_tokens": [],
        },
    )
    assert created
    seen_shared_pages = []

    async def read(*, user_id, tool_name, arguments):
        assert user_id == "owner"
        if tool_name == "list_shared_drives":
            return ExternalMcpToolResult(
                False, {"drives": [{"id": "shared-drive-1"}], "nextPageToken": None}, False
            )
        if tool_name == "get_file_metadata":
            assert arguments == {"fileId": "standup-file-525"}
            return ExternalMcpToolResult(
                False,
                {
                    "file": {
                        "id": "standup-file-525",
                        "title": "Hushh Team Standup Notes",
                        "mimeType": "application/vnd.google-apps.document",
                        "modifiedTime": older_modified,
                        "capabilities": {"canShare": True},
                    }
                },
                False,
            )
        assert tool_name == "search_files"
        page_size = arguments["pageSize"]
        assert page_size == 100
        if "driveId" not in arguments:
            numbers = range(1, 26)
            next_token = None
        else:
            assert arguments["driveId"] == "shared-drive-1"
            offset = int(arguments.get("pageToken") or "0")
            seen_shared_pages.append(offset)
            numbers = range(26 + offset, min(26 + offset + page_size, 526))
            next_token = str(offset + page_size) if offset + page_size < 500 else None
        files = [
            {
                "id": f"standup-file-{number}",
                "title": f"Standup notes {today.isoformat()} #{number}",
                "mimeType": "application/vnd.google-apps.document",
                "modifiedTime": older_modified
                if number == 525
                else today.isoformat() + "T00:00:00Z",
                "capabilities": {"canShare": True},
            }
            for number in numbers
        ]
        if 525 in numbers:
            files[-1] = {
                "id": "standup-shortcut-525",
                "title": f"Standup notes {today.isoformat()} #525",
                "mimeType": "application/vnd.google-apps.shortcut",
                "modifiedTime": older_modified,
                "capabilities": {"canShare": True},
                "shortcutDetails": {
                    "targetId": "standup-file-525",
                    "targetMimeType": "application/vnd.google-apps.document",
                },
            }
        return ExternalMcpToolResult(
            False,
            {"files": files, "nextPageToken": next_token, "incompleteSearch": False},
            False,
        )

    service = DriveOwnerSearchService(store=store, transport=SimpleNamespace(read_tool=read))
    for _ in range(12):
        status = await store.status(user_id="owner", job_id=state["jobId"])
        if not status["canStop"]:
            break
        await service.run_one(user_id="owner", job_id=state["jobId"])
    final = await store.status(user_id="owner", job_id=state["jobId"])
    assert final["status"] == "completed"
    assert final["matched"] == 525
    assert final["incompleteSearch"] is False
    assert seen_shared_pages == list(range(0, 500, 100))
    last = await store.reference(user_id="owner", job_id=state["jobId"], position=525)
    assert last["id"] == "standup-file-525"
    assert last["shortcutName"].startswith("Standup notes")
    return state["jobId"]


def _recipient(user_id, email):
    return {
        "userId": user_id,
        "name": user_id,
        "email": email,
        "subject": "1234567" if user_id == "recipient" else f"subject-{user_id}",
        "kind": "google_provider" if user_id == "recipient" else "verified_email",
    }


async def _trusted_request(sharing):
    return await sharing.create_request(
        recipient=VerifiedGoogleRecipient(
            "trusted-member",
            "subject-trusted-member",
            "trusted@example.invalid",
            datetime.now(UTC),
            "verified_email",
        ),
        owner_user_id="owner",
        client_request_id=str(uuid4()),
        purpose=ShareRequestPurpose(purpose="Standup notes from last 3 months"),
    )


async def _trusted_review(bulk, sharing, *, paid=True):
    request = await _trusted_request(sharing)
    review = await bulk.create_review(
        user_id="owner",
        search_job_id=_search(bulk, request_id=request["requestId"], count=1),
        client_request_id=str(uuid4()),
        recipients=[_recipient("trusted-member", "trusted@example.invalid")],
        excluded=[],
        origin_request_id=request["requestId"],
        selected_positions=[1],
    )
    with bulk.db.engine.begin() as connection:
        origin = bulk._row(
            connection,
            "SELECT * FROM drive_share_requests WHERE request_id=:request",
            {"request": request["requestId"]},
        )
        assert sharing._open_request(origin)["trusted_auto"] is True
        assert origin["payment_required"] is True
        if paid:
            connection.execute(
                text("""INSERT INTO drive_request_payment_orders
                  (request_id,user_id,requester_user_id,status,paid_at)
                  VALUES (:request,'owner','trusted-member','paid',clock_timestamp())"""),
                {"request": request["requestId"]},
            )
    return review


@pytest.mark.asyncio
async def test_new_trusted_request_cannot_queue_or_claim_grants_until_paid(request_bulk, sharing):
    review = await _trusted_review(request_bulk, sharing, paid=False)
    with request_bulk.db.engine.begin() as connection:
        request_id = connection.execute(
            text("SELECT origin_request_id FROM drive_bulk_shares WHERE share_id=:share"),
            {"share": review["shareId"]},
        ).scalar_one()
    approval = {
        "user_id": "owner",
        "share_id": review["shareId"],
        "revision": review["revision"],
        "review_digest": review["reviewDigest"],
    }
    with pytest.raises(DriveSharingError, match="payment_required"):
        await request_bulk.approve(**approval)
    with request_bulk.db.engine.begin() as connection:
        assert (
            connection.execute(text("SELECT count(*) FROM drive_bulk_share_effects")).scalar_one()
            == 0
        )
        connection.execute(
            text("""INSERT INTO drive_request_payment_orders
              (request_id,user_id,requester_user_id,status)
              VALUES (:request,'owner','trusted-member','awaiting_payment')"""),
            {"request": request_id},
        )
    with pytest.raises(DriveSharingError, match="payment_required"):
        await request_bulk.approve(**approval)
    with request_bulk.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_request_payment_orders
              SET status='paid',paid_at=clock_timestamp() WHERE request_id=:request"""),
            {"request": request_id},
        )
    await request_bulk.approve(**approval)
    with request_bulk.db.engine.begin() as connection:
        assert (
            connection.execute(text("SELECT count(*) FROM drive_bulk_share_effects")).scalar_one()
            == 1
        )
        connection.execute(
            text(
                "UPDATE drive_request_payment_orders SET status='refunded' WHERE request_id=:request"
            ),
            {"request": request_id},
        )
    with pytest.raises(DriveSharingError, match="payment_required"):
        await request_bulk.claim(
            user_id="owner",
            share_id=review["shareId"],
            position=1,
            recipient_user_id="trusted-member",
        )
    with request_bulk.db.engine.begin() as connection:
        connection.execute(
            text("UPDATE drive_request_payment_orders SET status='paid' WHERE request_id=:request"),
            {"request": request_id},
        )
    assert (
        await request_bulk.claim(
            user_id="owner",
            share_id=review["shareId"],
            position=1,
            recipient_user_id="trusted-member",
        )
        is not None
    )


async def _approved_request(bulk, sharing, count):
    request = await _request(sharing)
    review = await bulk.create_review(
        user_id="owner",
        search_job_id=_search(bulk, request_id=request["requestId"], count=count),
        client_request_id=str(uuid4()),
        recipients=[_recipient("recipient", "b@example.invalid")],
        excluded=[],
        origin_request_id=request["requestId"],
    )
    await bulk.approve(
        user_id="owner",
        share_id=review["shareId"],
        revision=review["revision"],
        review_digest=review["reviewDigest"],
    )
    delivery = DriveSharingService(
        oauth=SimpleNamespace(lifecycle=SimpleNamespace(db=sharing.db)),
        store=DriveSuggestionStore(db=sharing.db),
        verify_recipient=AsyncMock(),
    )
    return request, review, delivery


async def _paid_request_review(bulk, sharing):
    request = await _request(sharing)
    review = await bulk.create_review(
        user_id="owner",
        search_job_id=_search(bulk, request_id=request["requestId"], count=1),
        client_request_id=str(uuid4()),
        recipients=[_recipient("recipient", "b@example.invalid")],
        excluded=[],
        origin_request_id=request["requestId"],
    )
    with bulk.db.engine.begin() as connection:
        connection.execute(
            text("UPDATE drive_share_requests SET payment_required=TRUE WHERE request_id=:request"),
            {"request": request["requestId"]},
        )
        connection.execute(
            text("""INSERT INTO drive_request_payment_orders
              (request_id,user_id,requester_user_id,status,stripe_payment_intent_id,paid_at)
              VALUES (:request,'owner','recipient','paid',:intent,clock_timestamp())"""),
            {"request": request["requestId"], "intent": f"pi_test_{uuid4().hex}"},
        )
    return request, review


async def _erase_recipient_before_graph_mutation(bulk, monkeypatch, mutate):
    """Prove a real PostgreSQL wait, then commit erasure before the writer."""
    erasure_held = threading.Event()
    release_erasure = threading.Event()
    writer_entered = threading.Event()
    erasure_pid: list[int] = []
    writer_pid: list[int] = []

    def erase(connection):
        lock_connection_graph_users(connection, user_ids=["recipient"])
        erasure_pid.append(connection.execute(text("SELECT pg_backend_pid()")).scalar_one())
        erasure_held.set()
        assert release_erasure.wait(20), "erasure barrier was not released"
        erase_drive_account_in_transaction(connection, user_id="recipient", permanent=False)

    def observe_writer_gate(connection, *, user_ids):
        writer_pid.append(connection.execute(text("SELECT pg_backend_pid()")).scalar_one())
        writer_entered.set()
        lock_connection_graph_users(connection, user_ids=user_ids)

    erasure_task = asyncio.create_task(bulk._transaction(erase))
    writer_task = None
    try:
        assert await asyncio.to_thread(erasure_held.wait, 10)
        monkeypatch.setattr(
            "hushh_mcp.services.connection_graph_service.lock_connection_graph_users",
            observe_writer_gate,
        )
        writer_task = asyncio.create_task(mutate())
        assert await asyncio.to_thread(writer_entered.wait, 10)
        deadline = asyncio.get_running_loop().time() + 1
        while True:
            with bulk.db.engine.connect() as connection:
                blocked = connection.execute(
                    text("SELECT :holder = ANY(pg_blocking_pids(:waiter))"),
                    {"holder": erasure_pid[0], "waiter": writer_pid[0]},
                ).scalar_one()
            if blocked:
                break
            assert asyncio.get_running_loop().time() < deadline, "writer did not wait on erasure"
            await asyncio.sleep(0.01)
    finally:
        release_erasure.set()
        outcomes = await asyncio.wait_for(
            asyncio.gather(
                *([erasure_task, writer_task] if writer_task else [erasure_task]),
                return_exceptions=True,
            ),
            30,
        )
    assert outcomes[0] is None
    return outcomes[1]


@pytest.mark.asyncio
async def test_recipient_erasure_prevents_payment_gated_batch_freeze(
    request_bulk, sharing, monkeypatch
):
    request = await _request(sharing)
    search = _search(request_bulk, request_id=request["requestId"], count=1)
    with request_bulk.db.engine.begin() as connection:
        connection.execute(
            text("UPDATE drive_share_requests SET payment_required=TRUE WHERE request_id=:request"),
            {"request": request["requestId"]},
        )

    async def freeze():
        return await request_bulk.create_review(
            user_id="owner",
            search_job_id=search,
            client_request_id=str(uuid4()),
            recipients=[_recipient("recipient", "b@example.invalid")],
            excluded=[],
            origin_request_id=request["requestId"],
        )

    outcome = await _erase_recipient_before_graph_mutation(request_bulk, monkeypatch, freeze)
    assert isinstance(outcome, DriveSharingError) and str(outcome) == "request_changed"
    with request_bulk.db.engine.begin() as connection:
        assert connection.execute(text("SELECT count(*) FROM drive_bulk_shares")).scalar_one() == 0
        assert (
            connection.execute(text("SELECT count(*) FROM drive_bulk_share_files")).scalar_one()
            == 0
        )
        assert (
            connection.execute(text("SELECT count(*) FROM drive_share_requests")).scalar_one() == 0
        )


@pytest.mark.asyncio
async def test_recipient_erasure_prevents_paid_batch_approval(request_bulk, sharing, monkeypatch):
    request, review = await _paid_request_review(request_bulk, sharing)

    async def approve():
        return await request_bulk.approve(
            user_id="owner",
            share_id=review["shareId"],
            revision=review["revision"],
            review_digest=review["reviewDigest"],
        )

    outcome = await _erase_recipient_before_graph_mutation(request_bulk, monkeypatch, approve)
    assert isinstance(outcome, DriveSharingError) and str(outcome) == "bulk_not_found"
    with request_bulk.db.engine.begin() as connection:
        assert (
            connection.execute(text("SELECT count(*) FROM drive_bulk_share_effects")).scalar_one()
            == 0
        )
        assert connection.execute(text("SELECT count(*) FROM drive_bulk_shares")).scalar_one() == 0
        obligation = (
            connection.execute(
                text("""SELECT status,erased_at,delivery_confirmed_at_erasure
              FROM drive_request_payment_obligations WHERE request_id=:request"""),
                {"request": request["requestId"]},
            )
            .mappings()
            .one()
        )
    assert obligation["status"] == "paid" and obligation["erased_at"] is not None
    assert obligation["delivery_confirmed_at_erasure"] is False


@pytest.mark.asyncio
async def test_recipient_erasure_fences_paid_bulk_effect_settlement(
    request_bulk, sharing, monkeypatch
):
    request, review = await _paid_request_review(request_bulk, sharing)
    await request_bulk.approve(
        user_id="owner",
        share_id=review["shareId"],
        revision=review["revision"],
        review_digest=review["reviewDigest"],
    )
    job = await request_bulk.claim(
        user_id="owner",
        share_id=review["shareId"],
        position=1,
        recipient_user_id="recipient",
    )
    assert job is not None
    await request_bulk.mark_dispatching(job)

    async def settle():
        return await request_bulk.settle(job, state="succeeded", receipt={"managed": True})

    outcome = await _erase_recipient_before_graph_mutation(request_bulk, monkeypatch, settle)
    assert isinstance(outcome, DriveSharingError) and str(outcome) == "bulk_not_found"
    with request_bulk.db.engine.begin() as connection:
        assert (
            connection.execute(text("SELECT count(*) FROM drive_share_requests")).scalar_one() == 0
        )
        assert (
            connection.execute(text("SELECT count(*) FROM drive_bulk_share_effects")).scalar_one()
            == 0
        )
        obligation = (
            connection.execute(
                text("""SELECT status,erased_at,delivery_unsettled_at_erasure,reconciliation_required
              FROM drive_request_payment_obligations WHERE request_id=:request"""),
                {"request": request["requestId"]},
            )
            .mappings()
            .one()
        )
        refunds = _claim_refunds(
            DriveRequestPaymentService(db=request_bulk.db), connection, limit=1
        )
        refund_status = connection.execute(
            text("SELECT status FROM drive_request_payment_refunds WHERE request_id=:request"),
            {"request": request["requestId"]},
        ).scalar_one()
    assert obligation["status"] == "paid" and obligation["erased_at"] is not None
    assert obligation["delivery_unsettled_at_erasure"] is True
    assert obligation["reconciliation_required"] is True
    assert refunds == [] and refund_status == "manual_review"


@pytest.mark.asyncio
async def test_request_review_requires_explicit_drive_shareability(request_bulk, sharing):
    request = await _request(sharing)
    search = _search(
        request_bulk,
        request_id=request["requestId"],
        count=3,
        shareability={2: False, 3: None},
    )
    review = await request_bulk.create_review(
        user_id="owner",
        search_job_id=search,
        client_request_id=str(uuid4()),
        recipients=[_recipient("recipient", "b@example.invalid")],
        excluded=[],
        origin_request_id=request["requestId"],
    )
    assert review["fileCount"] == 1
    page = await request_bulk.files(user_id="owner", share_id=review["shareId"])
    assert [item["position"] for item in page["files"]] == [1]
    await request_bulk.approve(
        user_id="owner",
        share_id=review["shareId"],
        revision=review["revision"],
        review_digest=review["reviewDigest"],
    )
    with request_bulk.db.engine.begin() as connection:
        queued = (
            connection.execute(
                text("SELECT position FROM drive_bulk_share_effects WHERE share_id=:share"),
                {"share": review["shareId"]},
            )
            .scalars()
            .all()
        )
    assert queued == [1]


@pytest.mark.asyncio
async def test_legacy_frozen_request_review_cannot_queue_drive_grants(request_bulk, sharing):
    request = await _request(sharing)
    search = _search(request_bulk, request_id=request["requestId"], count=1, verified=False)
    review = await request_bulk.create_review(
        user_id="owner",
        search_job_id=search,
        client_request_id=str(uuid4()),
        recipients=[_recipient("recipient", "b@example.invalid")],
        excluded=[],
        origin_request_id=request["requestId"],
    )
    with pytest.raises(DriveSharingError, match="search_incomplete"):
        await request_bulk.approve(
            user_id="owner",
            share_id=review["shareId"],
            revision=review["revision"],
            review_digest=review["reviewDigest"],
        )
    with request_bulk.db.engine.begin() as connection:
        assert (
            connection.execute(
                text("SELECT count(*) FROM drive_bulk_share_effects WHERE share_id=:share"),
                {"share": review["shareId"]},
            ).scalar_one()
            == 0
        )
        assert (
            connection.execute(
                text("SELECT status FROM drive_bulk_shares WHERE share_id=:share"),
                {"share": review["shareId"]},
            ).scalar_one()
            == "review_ready"
        )
        assert (
            connection.execute(
                text("SELECT status FROM drive_share_requests WHERE request_id=:request"),
                {"request": request["requestId"]},
            ).scalar_one()
            == "pending"
        )


@pytest.mark.asyncio
async def test_legacy_request_search_refresh_is_idempotent_and_preserves_review(
    request_bulk, sharing
):
    store = DriveOwnerSearchStore(db=request_bulk.db)
    request = await _request(sharing)
    old_job = _search(request_bulk, request_id=request["requestId"], count=2, verified=False)
    old_status = await store.by_client(user_id="owner", client_request_id=request["requestId"])
    assert old_status["coverage"]["shareabilityVerified"] is False
    assert await store.clear_legacy_completed_request(
        user_id="owner", request_id=request["requestId"]
    )
    assert not await store.clear_legacy_completed_request(
        user_id="owner", request_id=request["requestId"]
    )
    with request_bulk.db.engine.begin() as connection:
        assert (
            connection.execute(
                text("SELECT count(*) FROM drive_owner_search_jobs WHERE job_id=:job"),
                {"job": old_job},
            ).scalar_one()
            == 0
        )
        assert (
            connection.execute(
                text("SELECT count(*) FROM drive_owner_search_results WHERE job_id=:job"),
                {"job": old_job},
            ).scalar_one()
            == 0
        )

    current_job = _search(request_bulk, request_id=request["requestId"], count=1, verified=True)
    assert not await store.clear_legacy_completed_request(
        user_id="owner", request_id=request["requestId"]
    )
    current_status = await store.by_client(user_id="owner", client_request_id=request["requestId"])
    assert current_status["jobId"] == current_job
    assert current_status["coverage"]["shareabilityVerified"] is True

    approved_request = await _request(sharing)
    approved_job = _search(request_bulk, request_id=approved_request["requestId"], count=1)
    review = await request_bulk.create_review(
        user_id="owner",
        search_job_id=approved_job,
        client_request_id=str(uuid4()),
        recipients=[_recipient("recipient", "b@example.invalid")],
        excluded=[],
        origin_request_id=approved_request["requestId"],
    )
    await request_bulk.approve(
        user_id="owner",
        share_id=review["shareId"],
        revision=review["revision"],
        review_digest=review["reviewDigest"],
    )
    with request_bulk.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_owner_search_jobs SET checkpoint_envelope=CAST(:envelope AS jsonb)
            WHERE job_id=:job"""),
            {
                "job": approved_job,
                "envelope": request_bulk._seal(
                    {
                        "done": True,
                        "request_origin_id": approved_request["requestId"],
                        "request_revision": approved_request["revision"],
                    },
                    user_id="owner",
                    resource_id=approved_job,
                    purpose="owner-search-checkpoint",
                ),
            },
        )
    assert not await store.clear_legacy_completed_request(
        user_id="owner", request_id=approved_request["requestId"]
    )
    approved_status = await store.by_client(
        user_id="owner", client_request_id=approved_request["requestId"]
    )
    assert approved_status["jobId"] == approved_job
    assert approved_status["coverage"]["shareabilityVerified"] is False


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "state,reason,can_retry",
    [
        ("skipped", "provider_unavailable", True),
        ("skipped", "source_not_shareable", False),
        ("present_unattributed", "permission_outcome_unknown", False),
    ],
)
async def test_72_selected_files_account_for_the_missing_one_without_leaking_it(
    request_bulk, sharing, state, reason, can_retry
):
    request, review, delivery = await _approved_request(request_bulk, sharing, 72)
    share = review["shareId"]
    with request_bulk.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_bulk_share_effects
        SET state=CASE WHEN position<=62 THEN 'succeeded' WHEN position<=71 THEN 'preexisting' ELSE :state END,
            safe_error_code=CASE WHEN position=72 THEN :reason ELSE NULL END
        WHERE share_id=:share"""),
            {"share": share, "state": state, "reason": reason},
        )
        request_bulk._finalize(connection, share)
    owner = await request_bulk.review(user_id="owner", share_id=share)
    assert owner["status"] == "partial"
    assert owner["counts"]["shared"] == 62 and owner["counts"]["alreadyShared"] == 9
    assert owner["counts"]["total"] == 72 and owner["counts"]["failed"] == 0
    assert (
        sum(
            owner["counts"][key]
            for key in (
                "shared",
                "alreadyShared",
                "skipped",
                "failed",
                "needsReview",
                "unknown",
                "pending",
            )
        )
        == 72
    )
    assert owner["issues"] == [{"reasonCode": reason, "count": 1}]
    assert owner["canRetry"] is can_retry
    # A sees the unavailable original and its exact outcome; B sees only the
    # aggregate explanation and 71 confirmed originals, never its private name.
    owner_page = await request_bulk.files(
        user_id="owner", share_id=share, cursor=request_bulk._cursor("owner", share, 50)
    )
    missing = owner_page["files"][-1]
    assert missing["position"] == 72
    assert missing["outcomes"] == [{"status": state, "reasonCode": reason}]
    received = await delivery.delivery(user_id="recipient", request_id=request["requestId"])
    assert received["bulkStatus"] == "partial"
    assert received["counts"] == owner["counts"]
    assert received["sharedCount"] == 71 and received["issues"] == owner["issues"]
    page = await delivery.delivery_files(
        user_id="recipient",
        request_id=request["requestId"],
        cursor=request_bulk._cursor("recipient", share, 50),
    )
    assert len(page["files"]) == 21 and missing["name"] not in {
        item["name"] for item in page["files"]
    }
    with pytest.raises(DriveSharingError, match="request_unavailable"):
        await delivery.delivery(user_id="trusted-member", request_id=request["requestId"])
    with pytest.raises(DriveSharingError, match="bulk_changed"):
        await request_bulk.retry(
            user_id="owner",
            share_id=share,
            revision=owner["revision"] - 1,
            review_digest=owner["reviewDigest"],
        )
    if not can_retry:
        with pytest.raises(DriveSharingError, match="bulk_changed"):
            await request_bulk.retry(
                user_id="owner",
                share_id=share,
                revision=owner["revision"],
                review_digest=owner["reviewDigest"],
            )
        return
    retried = await request_bulk.retry(
        user_id="owner",
        share_id=share,
        revision=owner["revision"],
        review_digest=owner["reviewDigest"],
    )
    assert retried["reviewDigest"] == owner["reviewDigest"]
    assert retried["counts"]["shared"] == 62 and retried["counts"]["alreadyShared"] == 9
    assert retried["counts"]["pending"] == 1 and retried["counts"]["processed"] == 71
    pending = await delivery.delivery(user_id="recipient", request_id=request["requestId"])
    assert pending["bulkStatus"] == "queued" and pending["counts"]["pending"] == 1
    job = await request_bulk.claim(
        user_id="owner", share_id=share, position=72, recipient_user_id="recipient"
    )
    assert job is not None and job["file"]["name"] == missing["name"]
    await request_bulk.mark_dispatching(job)
    await request_bulk.settle(job, state="succeeded", receipt={"managed": True})
    final = await delivery.delivery(user_id="recipient", request_id=request["requestId"])
    assert final["bulkStatus"] == final["status"] == "completed"
    assert final["sharedCount"] == 72 and final["issues"] == []


@pytest.mark.asyncio
async def test_stop_keeps_inflight_result_and_finishes_origin_request(request_bulk, sharing):
    request, review, delivery = await _approved_request(request_bulk, sharing, 2)
    job = await request_bulk.claim(
        user_id="owner", share_id=review["shareId"], position=1, recipient_user_id="recipient"
    )
    await request_bulk.mark_dispatching(job)
    stopped = await request_bulk.stop(user_id="owner", share_id=review["shareId"])
    assert stopped["counts"]["skipped"] == stopped["counts"]["pending"] == 1
    assert (await sharing.request_status(user_id="owner", request_id=request["requestId"]))[
        "status"
    ] == "approved"
    await request_bulk.settle(job, state="succeeded", receipt={"managed": True})
    final = await delivery.delivery(user_id="recipient", request_id=request["requestId"])
    assert final["status"] == "partial" and final["bulkStatus"] == "stopped"
    assert final["counts"]["shared"] == final["counts"]["skipped"] == 1
    assert final["counts"]["pending"] == 0
    assert final["issues"] == [{"reasonCode": "stopped", "count": 1}]


@pytest.mark.asyncio
async def test_request_freezes_all_525_matches_for_only_b(request_bulk, sharing):
    request = await _request(sharing)
    search = await _complete_shared_drive_search(
        request_bulk, sharing, request_id=request["requestId"]
    )
    search_status = await DriveOwnerSearchStore(db=request_bulk.db).status(
        user_id="owner", job_id=search
    )
    assert search_status["coverage"]["shareabilityVerified"] is True
    review = await request_bulk.create_review(
        user_id="owner",
        search_job_id=search,
        client_request_id=str(uuid4()),
        recipients=[_recipient("recipient", "b@example.invalid")],
        excluded=[],
        origin_request_id=request["requestId"],
        excluded_positions=[],
    )
    assert review["fileCount"] == 525
    assert review["recipientCount"] == 1
    assert review["counts"]["total"] == 525
    with request_bulk.db.engine.begin() as connection:
        recipients = (
            connection.execute(text("SELECT recipient_user_id FROM drive_bulk_share_recipients"))
            .scalars()
            .all()
        )
        frozen = connection.execute(
            text("SELECT count(*) FROM drive_bulk_share_files WHERE share_id=:share"),
            {"share": review["shareId"]},
        ).scalar_one()
    assert recipients == ["recipient"]
    assert frozen == 525
    projection = DriveSuggestionStore(db=sharing.db)
    delivery = DriveSharingService(
        oauth=SimpleNamespace(lifecycle=SimpleNamespace(db=sharing.db)),
        store=projection,
        verify_recipient=AsyncMock(),
    )
    private_review = await delivery.delivery(user_id="recipient", request_id=request["requestId"])
    assert "bulkShareId" not in private_review
    assert "fileCount" not in private_review
    assert private_review["files"] == []

    approved = await request_bulk.approve(
        user_id="owner",
        share_id=review["shareId"],
        revision=review["revision"],
        review_digest=review["reviewDigest"],
    )
    assert approved["counts"]["pending"] == 525
    with request_bulk.db.engine.begin() as connection:
        effects = connection.execute(
            text("""SELECT recipient_user_id,count(*) FROM drive_bulk_share_effects
            GROUP BY recipient_user_id""")
        ).all()
    assert effects == [("recipient", 525)]
    before = await delivery.delivery(user_id="recipient", request_id=request["requestId"])
    assert before["bulkShareId"] == review["shareId"]
    assert before["fileCount"] == 525 and before["sharedCount"] == 0
    assert before["files"] == []
    with pytest.raises(DriveSharingError, match="request_unavailable"):
        await delivery.delivery(user_id="trusted-member", request_id=request["requestId"])

    # Synthetic confirmed effects exercise the request/feed and recipient
    # projections without 525 external Google permission calls.
    with request_bulk.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_bulk_share_effects SET state='succeeded',
                updated_at=clock_timestamp() WHERE share_id=:share"""),
            {"share": review["shareId"]},
        )
        request_bulk._finalize(connection, review["shareId"])
    owner_status = await sharing.request_status(user_id="owner", request_id=request["requestId"])
    recipient_status = await sharing.request_status(
        user_id="recipient", request_id=request["requestId"]
    )
    assert owner_status["status"] == recipient_status["status"] == "completed"
    outcome = await delivery.delivery(user_id="recipient", request_id=request["requestId"])
    assert outcome["fileCount"] == outcome["sharedCount"] == 525
    assert outcome["sharingStatus"] == "completed"
    cursor, names = None, []
    while True:
        page = await delivery.delivery_files(
            user_id="recipient", request_id=request["requestId"], cursor=cursor
        )
        assert len(page["files"]) <= 25
        names.extend(file["name"] for file in page["files"])
        cursor = page["nextCursor"]
        if cursor is None:
            break
    assert len(names) == 525
    assert "Hushh Team Standup Notes" in names
    with pytest.raises(DriveSharingError, match="request_unavailable"):
        await delivery.delivery_files(user_id="trusted-member", request_id=request["requestId"])
    with request_bulk.db.engine.begin() as connection:
        events = connection.execute(
            text("""SELECT user_id,event_type FROM drive_share_events
            WHERE request_id=:request AND event_type IN
              ('document_share_decided','document_share_outcome')
            ORDER BY event_type"""),
            {"request": request["requestId"]},
        ).all()
    assert set(events) == {
        ("recipient", "document_share_decided"),
        ("recipient", "document_share_outcome"),
        ("owner", "document_share_outcome"),
    }


@pytest.mark.asyncio
async def test_progressive_batch_claims_keep_search_running_and_aggregate_delivery(
    request_bulk, sharing
):
    request = await _request(sharing)
    request_id = request["requestId"]
    search = _search(request_bulk, request_id=request_id, count=50)
    with request_bulk.db.engine.begin() as connection:
        later = [
            {**dict(row), "metadata_envelope": json.dumps(row["metadata_envelope"])}
            for row in connection.execute(
                text("""
            DELETE FROM drive_owner_search_results WHERE job_id=:job AND position>25
            RETURNING position,file_digest,metadata_envelope"""),
                {"job": search},
            ).mappings()
        ]
        connection.execute(
            text("""UPDATE drive_owner_search_jobs
            SET status='queued',matched=25 WHERE job_id=:job"""),
            {"job": search},
        )

    async def prepare_first():
        return await request_bulk.create_review(
            user_id="owner",
            search_job_id=search,
            client_request_id=str(uuid4()),
            recipients=[_recipient("recipient", "b@example.invalid")],
            excluded=[],
            origin_request_id=request_id,
            selected_positions=list(range(1, 26)),
        )

    first, duplicate = await asyncio.gather(prepare_first(), prepare_first())
    assert first["positions"] == list(range(1, 26))
    assert duplicate["shareId"] == first["shareId"]
    assert await request_bulk.pending_request_reviews(user_id="owner", request_id=request_id) == [
        {
            "shareId": first["shareId"],
            "revision": first["revision"],
            "reviewDigest": first["reviewDigest"],
        }
    ]
    await request_bulk.approve(
        user_id="owner",
        share_id=first["shareId"],
        revision=first["revision"],
        review_digest=first["reviewDigest"],
    )
    assert (await sharing.request_status(user_id="owner", request_id=request_id))[
        "status"
    ] == "pending"
    with request_bulk.db.engine.begin() as connection:
        assert (
            connection.execute(
                text("""SELECT count(*) FROM drive_share_events
            WHERE request_id=:request AND event_type='document_share_decided'"""),
                {"request": request_id},
            ).scalar_one()
            == 0
        )
        connection.execute(
            text("""UPDATE drive_bulk_share_effects
            SET state='succeeded' WHERE share_id=:share AND position=1"""),
            {"share": first["shareId"]},
        )
        request_bulk._finalize(connection, first["shareId"])
        assert (
            connection.execute(
                text("""SELECT count(*) FROM drive_share_events
            WHERE request_id=:request AND user_id='recipient'
              AND event_type='document_share_decided'"""),
                {"request": request_id},
            ).scalar_one()
            == 1
        )
    with request_bulk.db.engine.begin() as connection:
        first_row = request_bulk._row(
            connection,
            "SELECT * FROM drive_bulk_shares WHERE share_id=:share",
            {"share": first["shareId"]},
        )
        assert request_bulk._share_recipient_current(connection, first_row, "owner", "recipient")
        connection.execute(
            text("""INSERT INTO drive_owner_search_results(
            job_id,user_id,position,file_digest,metadata_envelope)
            VALUES(:job,'owner',:position,:file_digest,CAST(:metadata_envelope AS jsonb))"""),
            [{"job": search, **row} for row in later],
        )
        connection.execute(
            text("""UPDATE drive_owner_search_jobs
            SET status='completed',matched=50,revision=revision+1 WHERE job_id=:job"""),
            {"job": search},
        )
    assert await request_bulk.unclaimed_positions(user_id="owner", request_id=request_id) == list(
        range(26, 51)
    )
    second = await request_bulk.create_review(
        user_id="owner",
        search_job_id=search,
        client_request_id=str(uuid4()),
        recipients=[_recipient("recipient", "b@example.invalid")],
        excluded=[],
        origin_request_id=request_id,
        selected_positions=list(range(26, 51)),
    )
    assert second["positions"] == list(range(26, 51))
    with pytest.raises(DriveSharingError, match="bulk_conflict"):
        await request_bulk.create_review(
            user_id="owner",
            search_job_id=search,
            client_request_id=str(uuid4()),
            recipients=[_recipient("recipient", "b@example.invalid")],
            excluded=[],
            origin_request_id=request_id,
            selected_positions=[25, 26],
        )
    await request_bulk.approve(
        user_id="owner",
        share_id=second["shareId"],
        revision=second["revision"],
        review_digest=second["reviewDigest"],
    )
    with request_bulk.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_bulk_share_effects
            SET state='succeeded',updated_at=clock_timestamp()
            WHERE share_id=:share"""),
            {"share": first["shareId"]},
        )
        request_bulk._finalize(connection, first["shareId"])
    assert (await sharing.request_status(user_id="owner", request_id=request_id))[
        "status"
    ] == "pending"
    with request_bulk.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_bulk_share_effects
            SET state='succeeded',updated_at=clock_timestamp()+INTERVAL '1 second'
            WHERE share_id=:share"""),
            {"share": second["shareId"]},
        )
        request_bulk._finalize(connection, second["shareId"])
    assert (await sharing.request_status(user_id="owner", request_id=request_id))[
        "status"
    ] == "completed"
    delivery = DriveSharingService(
        oauth=SimpleNamespace(lifecycle=SimpleNamespace(db=sharing.db)),
        store=DriveSuggestionStore(db=sharing.db),
        verify_recipient=AsyncMock(),
    )
    summary = await delivery.delivery(user_id="recipient", request_id=request_id)
    assert summary["fileCount"] == summary["sharedCount"] == 50
    first_page = await delivery.delivery_files(user_id="recipient", request_id=request_id)
    second_page = await delivery.delivery_files(
        user_id="recipient", request_id=request_id, cursor=first_page["nextCursor"]
    )
    assert len(first_page["files"]) == len(second_page["files"]) == 25
    assert second_page["nextCursor"] is None
    assert len({item["name"] for item in first_page["files"] + second_page["files"]}) == 50


@pytest.mark.asyncio
async def test_progressive_600_files_emit_one_confirmed_availability_event(request_bulk, sharing):
    request = await _request(sharing)
    request_id = request["requestId"]
    search = _search(request_bulk, request_id=request_id, count=600)
    for start in range(1, 601, 25):
        review = await request_bulk.create_review(
            user_id="owner",
            search_job_id=search,
            client_request_id=str(uuid4()),
            recipients=[_recipient("recipient", "b@example.invalid")],
            excluded=[],
            origin_request_id=request_id,
            selected_positions=list(range(start, start + 25)),
        )
        await request_bulk.approve(
            user_id="owner",
            share_id=review["shareId"],
            revision=review["revision"],
            review_digest=review["reviewDigest"],
        )
        with request_bulk.db.engine.begin() as connection:
            connection.execute(
                text("""UPDATE drive_bulk_share_effects
                SET state='succeeded' WHERE share_id=:share"""),
                {"share": review["shareId"]},
            )
            request_bulk._finalize(connection, review["shareId"])
    with request_bulk.db.engine.begin() as connection:
        assert (
            connection.execute(
                text("""SELECT count(*) FROM drive_bulk_share_notifications n
            JOIN drive_bulk_shares b ON b.share_id=n.share_id
            WHERE b.origin_request_id=:request"""),
                {"request": request_id},
            ).scalar_one()
            == 0
        )
        assert (
            connection.execute(
                text("""SELECT count(*) FROM drive_share_events
            WHERE request_id=:request AND user_id='recipient'
              AND event_type='document_share_decided'"""),
                {"request": request_id},
            ).scalar_one()
            == 1
        )
    assert (await sharing.request_status(user_id="owner", request_id=request_id))[
        "status"
    ] == "completed"


@pytest.mark.asyncio
async def test_progressive_failed_batch_never_claims_files_available(request_bulk, sharing):
    request = await _request(sharing)
    request_id = request["requestId"]
    search = _search(request_bulk, request_id=request_id, count=1)
    review = await request_bulk.create_review(
        user_id="owner",
        search_job_id=search,
        client_request_id=str(uuid4()),
        recipients=[_recipient("recipient", "b@example.invalid")],
        excluded=[],
        origin_request_id=request_id,
        selected_positions=[1],
    )
    await request_bulk.approve(
        user_id="owner",
        share_id=review["shareId"],
        revision=review["revision"],
        review_digest=review["reviewDigest"],
    )
    with request_bulk.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_bulk_share_effects
            SET state='failed' WHERE share_id=:share"""),
            {"share": review["shareId"]},
        )
        request_bulk._finalize(connection, review["shareId"])
        assert (
            connection.execute(
                text("""SELECT count(*) FROM drive_share_events
            WHERE request_id=:request AND event_type='document_share_decided'"""),
                {"request": request_id},
            ).scalar_one()
            == 0
        )
    assert (await sharing.request_status(user_id="owner", request_id=request_id))[
        "status"
    ] == "partial"


@pytest.mark.asyncio
@pytest.mark.parametrize("blocker", ["membership", "manual_takeover"])
async def test_manual_approval_after_trusted_authority_changes_can_grant(
    request_bulk, sharing, blocker
):
    review = await _trusted_review(request_bulk, sharing)
    with request_bulk.db.engine.begin() as connection:
        connection.execute(
            text("""INSERT INTO drive_live_preferences(
              user_id,connection_generation,background_enabled)
              VALUES('owner',1,TRUE)
              ON CONFLICT(user_id) DO UPDATE SET background_enabled=TRUE""")
        )
        if blocker == "membership":
            connection.execute(
                text("""UPDATE one_location_circle_memberships SET status='removed'
                WHERE user_id='trusted-member'""")
            )
        else:
            connection.execute(
                text("""UPDATE drive_share_requests SET
                preparation_error_code='manual_search_active'
                WHERE request_id=(SELECT origin_request_id FROM drive_bulk_shares
                  WHERE share_id=:share)"""),
                {"share": review["shareId"]},
            )
    with pytest.raises(DriveSharingError, match="trusted_request_unavailable"):
        await request_bulk.approve(
            user_id="owner",
            share_id=review["shareId"],
            revision=review["revision"],
            review_digest=review["reviewDigest"],
            approval_source="trusted_auto",
        )
    await request_bulk.approve(
        user_id="owner",
        share_id=review["shareId"],
        revision=review["revision"],
        review_digest=review["reviewDigest"],
    )
    with request_bulk.db.engine.begin() as connection:
        row = request_bulk._row(
            connection,
            "SELECT * FROM drive_bulk_shares WHERE share_id=:share",
            {"share": review["shareId"]},
        )
        assert row["approval_source"] == "owner"
        assert request_bulk._share_recipient_current(connection, row, "owner", "trusted-member")
    # The actual effect claim uses the same gate immediately before a Google POST.
    assert (
        await request_bulk.claim(
            user_id="owner",
            share_id=review["shareId"],
            position=1,
            recipient_user_id="trusted-member",
        )
        is not None
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("revocation", ["membership", "background", "manual_takeover"])
async def test_auto_approved_batch_stops_after_authority_revoked(request_bulk, sharing, revocation):
    with request_bulk.db.engine.begin() as connection:
        connection.execute(
            text("""INSERT INTO drive_live_preferences(
              user_id,connection_generation,background_enabled)
              VALUES('owner',1,TRUE)
              ON CONFLICT(user_id) DO UPDATE SET background_enabled=TRUE""")
        )
    review = await _trusted_review(request_bulk, sharing)
    await request_bulk.approve(
        user_id="owner",
        share_id=review["shareId"],
        revision=review["revision"],
        review_digest=review["reviewDigest"],
        approval_source="trusted_auto",
    )
    with request_bulk.db.engine.begin() as connection:
        row = request_bulk._row(
            connection,
            "SELECT * FROM drive_bulk_shares WHERE share_id=:share",
            {"share": review["shareId"]},
        )
        assert row["approval_source"] == "trusted_auto"
        assert request_bulk._share_recipient_current(connection, row, "owner", "trusted-member")
        if revocation == "membership":
            connection.execute(
                text("""UPDATE one_location_circle_memberships SET status='removed'
                WHERE user_id='trusted-member'""")
            )
        elif revocation == "background":
            connection.execute(
                text("""UPDATE drive_live_preferences SET background_enabled=FALSE
                WHERE user_id='owner'""")
            )
        else:
            connection.execute(
                text("""UPDATE drive_share_requests SET
                preparation_error_code='manual_search_active'
                WHERE request_id=(SELECT origin_request_id FROM drive_bulk_shares
                  WHERE share_id=:share)"""),
                {"share": review["shareId"]},
            )
    assert (
        await request_bulk.claim(
            user_id="owner",
            share_id=review["shareId"],
            position=1,
            recipient_user_id="trusted-member",
        )
        is None
    )
    with request_bulk.db.engine.begin() as connection:
        state = connection.execute(
            text("""SELECT state FROM drive_bulk_share_effects
            WHERE share_id=:share AND position=1"""),
            {"share": review["shareId"]},
        ).scalar_one()
        assert state == "skipped"


@pytest.mark.asyncio
async def test_owner_recovers_only_never_posted_auto_skipped_file(request_bulk, sharing):
    with request_bulk.db.engine.begin() as connection:
        connection.execute(
            text("""INSERT INTO drive_live_preferences(
              user_id,connection_generation,background_enabled)
              VALUES('owner',1,TRUE)""")
        )
    auto = await _trusted_review(request_bulk, sharing)
    with request_bulk.db.engine.begin() as connection:
        request_id = connection.execute(
            text("SELECT origin_request_id FROM drive_bulk_shares WHERE share_id=:share"),
            {"share": auto["shareId"]},
        ).scalar_one()
        search_id = connection.execute(
            text("SELECT search_job_id FROM drive_bulk_shares WHERE share_id=:share"),
            {"share": auto["shareId"]},
        ).scalar_one()
    await request_bulk.approve(
        user_id="owner",
        share_id=auto["shareId"],
        revision=auto["revision"],
        review_digest=auto["reviewDigest"],
        approval_source="trusted_auto",
    )
    with request_bulk.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_share_requests SET
            preparation_error_code='manual_search_active' WHERE request_id=:request"""),
            {"request": request_id},
        )
    # The grant worker settles this effect before a Google POST. The request
    # remains pending so its owner can review the exact file again.
    assert (
        await request_bulk.claim(
            user_id="owner",
            share_id=auto["shareId"],
            position=1,
            recipient_user_id="trusted-member",
        )
        is None
    )
    assert (await sharing.request_status(user_id="owner", request_id=str(request_id)))[
        "status"
    ] == "pending"
    before = await request_bulk.batches_by_request(user_id="owner", request_id=str(request_id))
    assert before["claimedPositions"] == [1]
    assert before["recoverablePositions"] == [1]
    assert before["aggregateCounts"]["total"] == 1
    assert before["aggregateCounts"]["skipped"] == 1

    owner = await request_bulk.create_review(
        user_id="owner",
        search_job_id=str(search_id),
        client_request_id=str(uuid4()),
        recipients=[_recipient("trusted-member", "trusted@example.invalid")],
        excluded=[],
        origin_request_id=str(request_id),
        selected_positions=[1],
    )
    assert owner["shareId"] != auto["shareId"]
    with request_bulk.db.engine.begin() as connection:
        historical, current = connection.execute(
            text("""SELECT share_id,origin_request_id FROM drive_bulk_share_files
            WHERE share_id IN (:auto,:owner) ORDER BY share_id"""),
            {"auto": auto["shareId"], "owner": owner["shareId"]},
        ).all()
        claims = {str(share): origin for share, origin in (historical, current)}
        assert claims[auto["shareId"]] is None
        assert str(claims[owner["shareId"]]) == str(request_id)
    # UAT replays every migration on each deploy. An old migration must not
    # recreate the one-batch index, and 259 must not reclaim the released file.
    with request_bulk.db.engine.connect() as connection:
        for name in (
            "256_drive_request_bulk_search.sql",
            "259_drive_progressive_request_batches.sql",
        ):
            connection.exec_driver_sql((MIGRATIONS / name).read_text().replace("%", "%%"))
        connection.commit()
        assert (
            connection.execute(
                text("SELECT to_regclass('drive_bulk_origin_request_unique')")
            ).scalar_one()
            is None
        )
        assert (
            connection.execute(
                text("""SELECT count(*) FROM drive_bulk_shares
            WHERE user_id='owner' AND origin_request_id=:request"""),
                {"request": request_id},
            ).scalar_one()
            == 2
        )
        replayed = connection.execute(
            text("""SELECT share_id,origin_request_id FROM drive_bulk_share_files
            WHERE share_id IN (:auto,:owner)"""),
            {"auto": auto["shareId"], "owner": owner["shareId"]},
        ).all()
        claims = {str(share): origin for share, origin in replayed}
        assert claims[auto["shareId"]] is None
        assert str(claims[owner["shareId"]]) == str(request_id)
    pending = await request_bulk.batches_by_request(user_id="owner", request_id=str(request_id))
    assert pending["claimedPositions"] == [1]
    assert pending["recoverablePositions"] == []
    assert pending["aggregateCounts"]["total"] == 1
    assert pending["aggregateCounts"]["skipped"] == 0
    assert pending["aggregateCounts"]["pending"] == 1

    await request_bulk.approve(
        user_id="owner",
        share_id=owner["shareId"],
        revision=owner["revision"],
        review_digest=owner["reviewDigest"],
    )
    with request_bulk.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_bulk_share_effects SET state='succeeded'
            WHERE share_id=:share"""),
            {"share": owner["shareId"]},
        )
        request_bulk._finalize(connection, owner["shareId"])
    outcome = await request_bulk.batches_by_request(user_id="owner", request_id=str(request_id))
    assert outcome["aggregateCounts"]["total"] == 1
    assert outcome["aggregateCounts"]["shared"] == 1
    assert outcome["aggregateCounts"]["skipped"] == 0
    assert (await sharing.request_status(user_id="owner", request_id=str(request_id)))[
        "status"
    ] == "completed"
    delivery = DriveSharingService(
        oauth=SimpleNamespace(lifecycle=SimpleNamespace(db=sharing.db)),
        store=DriveSuggestionStore(db=sharing.db),
        verify_recipient=AsyncMock(),
    )
    recipient = await delivery.delivery(user_id="trusted-member", request_id=str(request_id))
    assert recipient["fileCount"] == recipient["counts"]["total"] == 1
    assert recipient["sharedCount"] == recipient["counts"]["shared"] == 1
    assert recipient["counts"]["skipped"] == 0
    assert recipient["issues"] == []


@pytest.mark.asyncio
@pytest.mark.parametrize("state,attempts", [("skipped", 1), ("unknown", 1)])
async def test_owner_cannot_recover_effect_that_may_have_posted(
    request_bulk, sharing, state, attempts
):
    with request_bulk.db.engine.begin() as connection:
        connection.execute(
            text("""INSERT INTO drive_live_preferences(
              user_id,connection_generation,background_enabled)
              VALUES('owner',1,TRUE)""")
        )
    review = await _trusted_review(request_bulk, sharing)
    await request_bulk.approve(
        user_id="owner",
        share_id=review["shareId"],
        revision=review["revision"],
        review_digest=review["reviewDigest"],
        approval_source="trusted_auto",
    )
    with request_bulk.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_bulk_share_effects SET state=:state,attempts=:attempts,
            safe_error_code='recipient_changed' WHERE share_id=:share"""),
            {"state": state, "attempts": attempts, "share": review["shareId"]},
        )
        connection.execute(
            text("""UPDATE drive_share_requests SET
            preparation_error_code='manual_search_active'
            WHERE request_id=(SELECT origin_request_id FROM drive_bulk_shares
              WHERE share_id=:share)"""),
            {"share": review["shareId"]},
        )
        request_id, search_id = connection.execute(
            text("""SELECT origin_request_id,search_job_id FROM drive_bulk_shares
            WHERE share_id=:share"""),
            {"share": review["shareId"]},
        ).one()
    batches = await request_bulk.batches_by_request(user_id="owner", request_id=str(request_id))
    assert batches["recoverablePositions"] == []
    with pytest.raises(DriveSharingError, match="bulk_conflict"):
        await request_bulk.create_review(
            user_id="owner",
            search_job_id=str(search_id),
            client_request_id=str(uuid4()),
            recipients=[_recipient("trusted-member", "trusted@example.invalid")],
            excluded=[],
            origin_request_id=str(request_id),
            selected_positions=[1],
        )


@pytest.mark.asyncio
async def test_owner_selected_exact_request_keeps_legacy_review_path(request_bulk, sharing):
    request = await sharing.create_request(
        recipient=VerifiedGoogleRecipient(
            "recipient", "1234567", "b@example.invalid", datetime.now(UTC)
        ),
        owner_user_id="owner",
        client_request_id=str(uuid4()),
        purpose=ShareRequestPurpose(purpose="One exact file chosen by the owner"),
        owner_initiated=True,
    )
    review = await sharing.owner_review(user_id="owner", request_id=request["requestId"])
    assert review["durableAvailable"] is False
    with request_bulk.db.engine.begin() as connection:
        assert (
            connection.execute(
                text(
                    "SELECT bulk_search_started_at FROM drive_share_requests WHERE request_id=:request"
                ),
                {"request": request["requestId"]},
            ).scalar_one()
            is None
        )


@pytest.mark.asyncio
async def test_request_rejects_incomplete_search_and_other_recipient(request_bulk, sharing):
    request = await _request(sharing)
    incomplete = _search(request_bulk, request_id=request["requestId"], count=26, incomplete=True)
    with pytest.raises(DriveSharingError, match="search_incomplete"):
        await request_bulk.create_review(
            user_id="owner",
            search_job_id=incomplete,
            client_request_id=str(uuid4()),
            recipients=[_recipient("recipient", "b@example.invalid")],
            excluded=[],
            origin_request_id=request["requestId"],
            excluded_positions=[],
        )
    with request_bulk.db.engine.begin() as connection:
        assert connection.execute(text("SELECT count(*) FROM drive_bulk_shares")).scalar_one() == 0

    with request_bulk.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_owner_search_jobs SET status='completed',
            incomplete_search=false WHERE job_id=:job"""),
            {"job": incomplete},
        )
    with pytest.raises(DriveSharingError):
        await request_bulk.create_review(
            user_id="owner",
            search_job_id=incomplete,
            client_request_id=str(uuid4()),
            recipients=[
                _recipient("recipient", "b@example.invalid"),
                _recipient("trusted-member", "trusted@example.invalid"),
            ],
            excluded=[],
            origin_request_id=request["requestId"],
            excluded_positions=[],
        )
    with request_bulk.db.engine.begin() as connection:
        assert connection.execute(text("SELECT count(*) FROM drive_bulk_shares")).scalar_one() == 0


@pytest.mark.asyncio
async def test_decline_during_provider_page_discards_result_and_blocks_review(
    request_bulk, sharing
):
    request = await _request(sharing)
    context = await sharing.request_bulk_context(
        user_id="owner", request_id=request["requestId"], start=True
    )
    store = DriveOwnerSearchStore(db=request_bulk.db)
    query = {"query": "Standup notes from last 3 months", "timezone": "UTC"}
    arguments = {"query": "name contains 'Standup'", "orderBy": "createdTime desc"}
    state, _ = await store.create(
        user_id="owner",
        client_request_id=request["requestId"],
        request=query,
        confirmed=True,
        checkpoint={
            "request": query,
            "request_origin_id": request["requestId"],
            "request_revision": context["revision"],
            "arguments": arguments,
            "queries": [{"arguments": arguments}],
            "query_index": 0,
            "phase": "user",
            "page_token": None,
            "drive_page_token": None,
            "drives": [],
            "drive_index": 0,
            "seen_tokens": [],
            "drive_tokens": [],
        },
    )
    entered, resume = asyncio.Event(), asyncio.Event()

    async def read(*, user_id, tool_name, arguments):
        assert user_id == "owner" and tool_name == "search_files"
        entered.set()
        await resume.wait()
        return ExternalMcpToolResult(
            False,
            {
                "files": [
                    {
                        "id": "late-result",
                        "title": "Standup notes 2026-09-20",
                        "mimeType": "application/vnd.google-apps.document",
                        "modifiedTime": "2026-09-20T00:00:00Z",
                    }
                ],
                "incompleteSearch": False,
            },
            False,
        )

    service = DriveOwnerSearchService(store=store, transport=SimpleNamespace(read_tool=read))
    task = asyncio.create_task(service.run_one(user_id="owner", job_id=state["jobId"], max_pages=1))
    await asyncio.wait_for(entered.wait(), timeout=3)
    await sharing.decline_or_cancel(
        user_id="owner",
        request_id=request["requestId"],
        revision=context["revision"],
        decision="declined",
    )
    resume.set()
    assert await task == "superseded"
    assert (await store.results(user_id="owner", job_id=state["jobId"]))["files"] == []
    with pytest.raises(DriveSharingError):
        await request_bulk.create_review(
            user_id="owner",
            search_job_id=state["jobId"],
            client_request_id=str(uuid4()),
            recipients=[_recipient("recipient", "b@example.invalid")],
            excluded=[],
            origin_request_id=request["requestId"],
            excluded_positions=[],
        )


@pytest.mark.asyncio
async def test_decline_after_review_blocks_bulk_approval(request_bulk, sharing):
    request = await _request(sharing)
    search = _search(request_bulk, request_id=request["requestId"], count=1)
    review = await request_bulk.create_review(
        user_id="owner",
        search_job_id=search,
        client_request_id=str(uuid4()),
        recipients=[_recipient("recipient", "b@example.invalid")],
        excluded=[],
        origin_request_id=request["requestId"],
        excluded_positions=[],
    )
    await sharing.decline_or_cancel(
        user_id="owner",
        request_id=request["requestId"],
        revision=request["revision"],
        decision="declined",
    )
    with pytest.raises(DriveSharingError):
        await request_bulk.approve(
            user_id="owner",
            share_id=review["shareId"],
            revision=review["revision"],
            review_digest=review["reviewDigest"],
        )
    with request_bulk.db.engine.begin() as connection:
        assert (
            connection.execute(text("SELECT count(*) FROM drive_bulk_share_effects")).scalar_one()
            == 0
        )
