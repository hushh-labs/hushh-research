"""A document request freezes every Drive match for only its verified recipient."""

# ruff: noqa: F811 -- imported isolated PostgreSQL fixtures

import asyncio
import base64
import json
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from sqlalchemy import text

from hushh_mcp.services.drive_bulk_share_store import DriveBulkShareStore
from hushh_mcp.services.drive_owner_search_service import DriveOwnerSearchService
from hushh_mcp.services.drive_owner_search_store import DriveOwnerSearchStore
from hushh_mcp.services.drive_sharing_contract import (
    DriveSharingError,
    ShareRequestPurpose,
    VerifiedGoogleRecipient,
)
from hushh_mcp.services.drive_sharing_service import DriveSharingService
from hushh_mcp.services.drive_suggestion_store import DriveSuggestionStore
from hushh_mcp.services.external_mcp_client import ExternalMcpToolResult
from hushh_mcp.services.google_drive_adapter import DRIVE_BASE, DRIVE_POLICY, LIVE_POLICY_HASH
from tests.services.test_drive_sharing_store import (  # noqa: F401
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
            text("""CREATE TABLE connection_origins(
              connection_id UUID, status TEXT, origin_kind TEXT)""")
        )
        connection.execute(
            text("""CREATE TABLE one_location_circles(
              id UUID, owner_user_id TEXT, system_kind TEXT, status TEXT)""")
        )
        connection.execute(
            text("""CREATE TABLE one_location_circle_memberships(
              circle_id UUID, user_id TEXT, status TEXT)""")
        )
        connection.execute(
            text("""INSERT INTO connection_origins(connection_id,status,origin_kind)
            SELECT id,'active','direct_request' FROM connections""")
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
    return DriveBulkShareStore(db=sharing.db)


async def _request(sharing):
    return await sharing.create_request(
        recipient=VerifiedGoogleRecipient(
            "recipient", "1234567", "b@example.invalid", datetime.now(UTC)
        ),
        owner_user_id="owner",
        client_request_id=str(uuid4()),
        purpose=ShareRequestPurpose(purpose="Standup notes from last 3 months"),
    )


def _search(bulk, *, request_id, count=525, incomplete=False):
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
        }
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
        connection.execute(
            text("""UPDATE drive_share_requests SET bulk_search_started_at=clock_timestamp()
            WHERE request_id=:request"""),
            {"request": request_id},
        )
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
                    {"done": not incomplete},
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
                    }
                },
                False,
            )
        assert tool_name == "search_files"
        assert arguments["pageSize"] == 25
        if "driveId" not in arguments:
            numbers = range(1, 26)
            next_token = None
        else:
            assert arguments["driveId"] == "shared-drive-1"
            offset = int(arguments.get("pageToken") or "0")
            seen_shared_pages.append(offset)
            numbers = range(26 + offset, min(26 + offset + 25, 526))
            next_token = str(offset + 25) if offset + 25 < 500 else None
        files = [
            {
                "id": f"standup-file-{number}",
                "title": f"Standup notes {today.isoformat()} #{number}",
                "mimeType": "application/vnd.google-apps.document",
                "modifiedTime": older_modified
                if number == 525
                else today.isoformat() + "T00:00:00Z",
            }
            for number in numbers
        ]
        if 525 in numbers:
            files[-1] = {
                "id": "standup-shortcut-525",
                "title": f"Standup notes {today.isoformat()} #525",
                "mimeType": "application/vnd.google-apps.shortcut",
                "modifiedTime": older_modified,
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
    assert seen_shared_pages == list(range(0, 500, 25))
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


@pytest.mark.asyncio
async def test_request_freezes_all_525_matches_for_only_b(request_bulk, sharing):
    request = await _request(sharing)
    search = await _complete_shared_drive_search(
        request_bulk, sharing, request_id=request["requestId"]
    )
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
