"""Frozen 2,000-file manifest and 4,000-effect fanout in disposable PostgreSQL."""

# ruff: noqa: F811 -- imported isolated PostgreSQL fixtures

import asyncio
import base64
import json
import threading
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import httpx
import pytest
from sqlalchemy import text

from hushh_mcp.services.connection_graph_service import lock_connection_graph_users
from hushh_mcp.services.drive_bulk_share_store import DriveBulkShareStore, bulk_outcome_summary
from hushh_mcp.services.drive_bulk_share_worker import DriveBulkShareWorker
from hushh_mcp.services.drive_request_bulk_removal_store import managed_bulk_plan
from hushh_mcp.services.drive_sharing_contract import DriveSharingError
from hushh_mcp.services.google_drive_adapter import DRIVE_BASE, DRIVE_POLICY, LIVE_POLICY_HASH
from hushh_mcp.services.google_drive_permission_adapter import GoogleDrivePermissionAdapter
from tests.drive_postgres_test_support import apply_bulk_search_fixture_migrations
from tests.services.test_external_connector_lifecycle_postgres import (  # noqa: F401
    connector_postgres_url,
    lifecycle,
)

MIGRATIONS = Path(__file__).resolve().parents[2] / "db/migrations"


@pytest.fixture
def bulk(lifecycle, monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("GOOGLE_DRIVE_LIVE", "true")
    monkeypatch.setenv("DRIVE_DOCUMENT_SHARING", "true")
    monkeypatch.setenv("CONNECTOR_INTERNAL_OWNER_COHORT", "owner,recipient-1,recipient-2")
    monkeypatch.setenv("DRIVE_SHARING_KEY_V1", base64.b64encode(b"b" * 32).decode())
    with lifecycle.db.engine.begin() as connection:
        apply_bulk_search_fixture_migrations(connection)
        # This fixture has no payment ledgers. Mirror only migration 352's
        # search marker needed by the V1 share queue.
        connection.execute(
            text("""ALTER TABLE drive_owner_search_jobs
            ADD COLUMN v1_statement_search BOOLEAN NOT NULL DEFAULT FALSE""")
        )
        # Migrations 256 and 259 also need share-request tables absent from this
        # generic bulk fixture. Mirror only their columns used without an origin.
        connection.execute(
            text("""ALTER TABLE drive_owner_search_jobs
            ADD COLUMN unshareable_count INTEGER NOT NULL DEFAULT 0
            CHECK (unshareable_count BETWEEN 0 AND 10000)""")
        )
        connection.execute(
            text("""ALTER TABLE drive_bulk_shares
            ADD COLUMN origin_request_id UUID,
            ADD COLUMN origin_request_revision BIGINT,
            ADD CONSTRAINT drive_bulk_origin_request_revision_check
              CHECK ((origin_request_id IS NULL) = (origin_request_revision IS NULL))""")
        )
        connection.execute(
            text("""ALTER TABLE drive_bulk_shares
            ADD COLUMN progressive_batch BOOLEAN NOT NULL DEFAULT FALSE,
            ADD COLUMN approval_source TEXT,
            ADD COLUMN v1_statement_search BOOLEAN NOT NULL DEFAULT FALSE,
            ADD CONSTRAINT drive_bulk_approval_source_check
              CHECK ((approved_at IS NULL AND approval_source IS NULL)
                OR (approved_at IS NOT NULL AND approval_source IN ('owner','trusted_auto')))""")
        )
        connection.execute(
            text("ALTER TABLE drive_bulk_share_files ADD COLUMN origin_request_id UUID")
        )
        # The grant queue skips a request that still awaits payment. Mirror only
        # the request and order columns due() reads (migrations 232, 262, 287,
        # 298 and 356); this fixture's shares have no such request.
        connection.execute(
            text("""CREATE TABLE IF NOT EXISTS drive_share_requests (
            request_id UUID PRIMARY KEY, status TEXT NOT NULL,
            expires_at TIMESTAMPTZ NOT NULL,
            payment_required BOOLEAN NOT NULL DEFAULT FALSE,
            access_stop_requested_at TIMESTAMPTZ, access_expires_at TIMESTAMPTZ)""")
        )
        connection.execute(
            text("""CREATE TABLE IF NOT EXISTS drive_request_payment_orders (
            request_id UUID PRIMARY KEY, status TEXT NOT NULL, paid_at TIMESTAMPTZ,
            reconciliation_required BOOLEAN NOT NULL DEFAULT FALSE,
            stripe_mode TEXT NOT NULL)""")
        )
        # Migration 287's per-file removal ledger: the recipient's file lists
        # hide removed files. Mirror only the columns that check reads.
        connection.execute(
            text("""CREATE TABLE IF NOT EXISTS drive_request_bulk_removals (
            removal_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            share_id UUID NOT NULL,
            position INTEGER NOT NULL,
            recipient_user_id TEXT NOT NULL,
            state TEXT NOT NULL DEFAULT 'queued',lease_id UUID,safe_error_code TEXT,
            UNIQUE (share_id,position,recipient_user_id))""")
        )
        connection.exec_driver_sql("""CREATE TABLE drive_share_file_claims(
            file_lock_hmac TEXT PRIMARY KEY,operation_id UUID UNIQUE,erased_at TIMESTAMPTZ,
            CONSTRAINT drive_file_claim_or_erased_fence CHECK((operation_id IS NULL)=(erased_at IS NOT NULL)))""")
        for name in (
            "439_drive_rest_owner_admission.sql",
            "440_drive_permission_file_claim_lanes.sql",
        ):
            connection.exec_driver_sql((MIGRATIONS / name).read_text().replace("%", "%%"))
        connection.execute(
            text("""UPDATE external_mcp_connectors SET transport_kind='google_drive_rest',
            mcp_endpoint=:endpoint,capability_policy=CAST(:policy AS jsonb)
            WHERE connector_id='google_drive'"""),
            {"endpoint": DRIVE_BASE, "policy": json.dumps(DRIVE_POLICY)},
        )
        connection.execute(
            text("""INSERT INTO user_external_connector_connections
              (user_id,connector_id,status,validation_state,verified_policy_hash,connection_generation)
              VALUES('owner','google_drive','connected','verified',:policy,7)"""),
            {"policy": LIVE_POLICY_HASH},
        )
    store = DriveBulkShareStore(db=lifecycle.db)
    # This test exercises the real 2k-row SQL snapshot and fanout. The graph
    # membership gate is covered separately by the owner-share contract.
    monkeypatch.setattr(store, "_recipient_current", lambda connection, owner, recipient: True)
    return store


def _seed_completed_search(store, count=2000):
    job = str(uuid4())
    envelopes = []
    for position in range(1, count + 1):
        file_id = f"file-{position}"
        metadata = {
            "id": file_id,
            "name": f"Financial document {position}",
            "mimeType": "application/pdf",
            "modifiedTime": "2026-09-27T00:00:00Z",
            "openUrl": f"https://drive.google.com/open?id={file_id}",
        }
        envelopes.append(
            {
                "job": job,
                "user": "owner",
                "position": position,
                "digest": store.cipher.digest("owner-search-file", [job, file_id]),
                "envelope": store._seal(
                    metadata,
                    user_id="owner",
                    resource_id=f"{job}:{position}",
                    purpose="owner-search-result",
                ),
            }
        )
    with store.db.engine.begin() as connection:
        connection.execute(
            text("""INSERT INTO drive_owner_search_jobs(
              job_id,user_id,client_request_id,request_digest,connection_generation,
              consent_version,status,revision,matched,pages_scanned,incomplete_search,
              checkpoint_envelope)
              VALUES(:job,'owner',:client,:digest,7,'drive-owner-search-v1',
                'completed',81,:count,80,false,CAST(:checkpoint AS jsonb))"""),
            {
                "job": job,
                "client": str(uuid4()),
                "count": count,
                "digest": store.cipher.digest("test-request", [job]),
                "checkpoint": store._seal(
                    {"done": True},
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
            envelopes,
        )
    return job


@pytest.mark.asyncio
async def test_v1_delivery_queue_excludes_unmarked_auto_and_nonprogressive_shares(bulk):
    """The isolated worker sees only an explicit V1 owner selection."""
    cases = [
        ("approved_v1", True, True, "owner"),
        ("nonprogressive", True, False, "owner"),
        ("automatic", True, True, "trusted_auto"),
        ("unmarked", False, True, "owner"),
    ]
    shares = {}
    with bulk.db.engine.begin() as connection:
        for name, marked, progressive, approval_source in cases:
            search = str(uuid4())
            share = str(uuid4())
            shares[name] = share
            connection.execute(
                text("""INSERT INTO drive_owner_search_jobs(
                  job_id,user_id,client_request_id,request_digest,connection_generation,
                  consent_version,status,checkpoint_envelope,v1_statement_search)
                  VALUES(:search,'owner',:client,:digest,7,'drive-owner-search-v1',
                    'completed','{}'::jsonb,:marked)"""),
                {"search": search, "client": str(uuid4()), "digest": "a" * 64, "marked": marked},
            )
            connection.execute(
                text("""INSERT INTO drive_bulk_shares(
                  share_id,user_id,search_job_id,client_request_id,request_digest,
                  connection_generation,search_revision,review_digest,status,file_count,
                  recipient_count,excluded_envelope,origin_request_id,origin_request_revision,
                  progressive_batch,approval_source,approved_at,v1_statement_search)
                  VALUES(:share,'owner',:search,:client,:digest,7,1,:review,'queued',1,1,
                    '{}'::jsonb,:origin,1,:progressive,:approval_source,clock_timestamp(),:v1)"""),
                {
                    "share": share,
                    "search": search,
                    "client": str(uuid4()),
                    "digest": "b" * 64,
                    "review": "c" * 64,
                    "origin": str(uuid4()),
                    "progressive": progressive,
                    "approval_source": approval_source,
                    "v1": marked and progressive and approval_source == "owner",
                },
            )
            connection.execute(
                text("""INSERT INTO drive_bulk_share_files(
                  share_id,user_id,position,source_job_id,source_position,file_digest,
                  metadata_envelope)
                  VALUES(:share,'owner',1,:search,1,:digest,'{}'::jsonb)"""),
                {"share": share, "search": search, "digest": "d" * 64},
            )
            connection.execute(
                text("""INSERT INTO drive_bulk_share_recipients(
                  share_id,user_id,recipient_user_id,identity_envelope)
                  VALUES(:share,'owner','recipient-1','{}'::jsonb)"""),
                {"share": share},
            )
            connection.execute(
                text("""INSERT INTO drive_bulk_share_effects(
                  share_id,user_id,position,recipient_user_id)
                  VALUES(:share,'owner',1,'recipient-1')"""),
                {"share": share},
            )
            connection.execute(
                text("""INSERT INTO drive_bulk_share_notifications(
                  share_id,user_id,recipient_user_id)
                  VALUES(:share,'owner','recipient-1')"""),
                {"share": share},
            )

    assert {str(row["share_id"]) for row in await bulk.due(v1_only=True)} == {shares["approved_v1"]}
    assert {str(row["share_id"]) for row in await bulk.due_notifications(v1_only=True)} == {
        shares["approved_v1"]
    }
    assert {str(row["share_id"]) for row in await bulk.due()} == set(shares.values())
    assert {str(row["share_id"]) for row in await bulk.due_notifications()} == set(shares.values())


@pytest.mark.asyncio
async def test_two_thousand_files_freeze_four_thousand_effects_and_page_all_links(bulk):
    search = _seed_completed_search(bulk)
    recipients = [
        {
            "userId": f"recipient-{n}",
            "name": f"Recipient {n}",
            "email": f"recipient{n}@example.com",
            "subject": f"subject-{n}",
            "kind": "verified_email",
        }
        for n in (1, 2)
    ]
    client = str(uuid4())
    review = await bulk.create_review(
        user_id="owner",
        search_job_id=search,
        client_request_id=client,
        recipients=recipients,
        excluded=[],
    )
    assert review["fileCount"] == 2000
    assert review["recipientCount"] == 2
    assert review["counts"]["total"] == 4000
    again = await bulk.create_review(
        user_id="owner",
        search_job_id=search,
        client_request_id=str(uuid4()),
        recipients=recipients,
        excluded=[],
    )
    assert again["shareId"] == review["shareId"]

    owner_names, cursor = [], None
    for _ in range(80):
        page = await bulk.files(user_id="owner", share_id=review["shareId"], cursor=cursor)
        owner_names.extend(item["name"] for item in page["files"])
        cursor = page["nextCursor"]
    assert cursor is None
    assert len(owner_names) == len(set(owner_names)) == 2000

    approved = await bulk.approve(
        user_id="owner",
        share_id=review["shareId"],
        revision=review["revision"],
        review_digest=review["reviewDigest"],
    )
    assert approved["counts"]["pending"] == 4000
    with bulk.db.engine.begin() as connection:
        assert (
            connection.execute(text("SELECT count(*) FROM drive_bulk_share_files")).scalar_one()
            == 2000
        )
        assert (
            connection.execute(text("SELECT count(*) FROM drive_bulk_share_effects")).scalar_one()
            == 4000
        )
        # Simulate 2,000 confirmed grants. Recipient reads must exclude the
        # other 2,000 queued effects and reveal only their own granted links.
        connection.execute(
            text("""UPDATE drive_bulk_share_effects SET state='succeeded'
            WHERE recipient_user_id='recipient-1'""")
        )
        bulk._queue_notices(connection, review["shareId"])
        assert (
            connection.execute(
                text("SELECT count(*) FROM drive_bulk_share_notifications")
            ).scalar_one()
            == 1
        )
        assert (
            connection.execute(
                text("SELECT recipient_user_id FROM drive_bulk_share_notifications")
            ).scalar_one()
            == "recipient-1"
        )
    inbox = await bulk.inbox(
        recipient_user_id="recipient-1",
        recipient_subject="subject-1",
        recipient_email="recipient1@example.com",
    )
    assert len(inbox["shares"]) == 1
    assert inbox["shares"][0]["sharedCount"] == 2000
    assert (
        await bulk.inbox(
            recipient_user_id="recipient-2",
            recipient_subject="subject-2",
            recipient_email="recipient2@example.com",
        )
    )["shares"] == []
    recipient_names, cursor = [], None
    for _ in range(80):
        page = await bulk.recipient_files(
            recipient_user_id="recipient-1",
            recipient_subject="subject-1",
            recipient_email="recipient1@example.com",
            share_id=review["shareId"],
            cursor=cursor,
        )
        recipient_names.extend(item["name"] for item in page["files"])
        cursor = page["nextCursor"]
    assert cursor is None
    assert recipient_names == owner_names


@pytest.mark.asyncio
async def test_second_search_share_waits_for_stopped_inflight_grant(bulk):
    # Distinct saved searches can contain the same Drive file and recipient.
    # A stopped share's dispatched POST can still be in flight, so approval of
    # the second review must wait for that outcome to become terminal.
    recipient = {
        "userId": "recipient-1",
        "name": "Recipient 1",
        "email": "recipient1@example.com",
        "subject": "subject-1",
        "kind": "verified_email",
    }
    reviews = []
    for _ in range(3):
        reviews.append(
            await bulk.create_review(
                user_id="owner",
                search_job_id=_seed_completed_search(bulk, count=1),
                client_request_id=str(uuid4()),
                recipients=[recipient],
                excluded=[],
            )
        )

    async def approve(review):
        return await bulk.approve(
            user_id="owner",
            share_id=review["shareId"],
            revision=review["revision"],
            review_digest=review["reviewDigest"],
        )

    await approve(reviews[0])
    with pytest.raises(DriveSharingError, match="drive_share_in_progress"):
        await approve(reviews[1])

    from sqlalchemy.exc import InternalError

    # An old worker without the new common claim must fail before provider POST.
    with pytest.raises(InternalError, match="DRIVE_FILE_CLAIM_REQUIRED"):
        with bulk.db.engine.begin() as connection:
            connection.execute(
                text(
                    "UPDATE drive_bulk_share_effects SET state='dispatching' WHERE share_id=:share"
                ),
                {"share": reviews[0]["shareId"]},
            )
    claimed = await bulk.claim(**_row(reviews[0]["shareId"]))
    await bulk.mark_dispatching(claimed)
    await bulk.stop(user_id="owner", share_id=reviews[0]["shareId"])
    with pytest.raises(DriveSharingError, match="drive_share_in_progress"):
        await approve(reviews[1])

    # Expiry must not remove the fence while a POST can still be in flight.
    with bulk.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_bulk_shares
              SET expires_at=clock_timestamp()-INTERVAL '1 second'
              WHERE share_id=:share"""),
            {"share": reviews[0]["shareId"]},
        )
    with pytest.raises(DriveSharingError, match="drive_share_in_progress"):
        await approve(reviews[1])

    with bulk.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_bulk_share_effects SET state='succeeded',
              lease_id=NULL,lease_expires_at=NULL WHERE share_id=:share"""),
            {"share": reviews[0]["shareId"]},
        )
    second = await approve(reviews[1])
    assert second["status"] == "queued"
    # A seven-day-old unfinished share cannot block later work forever: its
    # queued effects cannot be claimed after expiry, and have no dispatched POST.
    with bulk.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_bulk_shares
              SET expires_at=clock_timestamp()-INTERVAL '1 second'
              WHERE share_id=:share"""),
            {"share": reviews[1]["shareId"]},
        )
    third = await approve(reviews[2])
    assert third["status"] == "queued"


@pytest.mark.asyncio
async def test_stop_serializes_pre_post_release_and_keeps_confirmed_inflight_receipt(
    bulk, monkeypatch
):
    review = await bulk.create_review(
        user_id="owner",
        search_job_id=_seed_completed_search(bulk, count=3),
        client_request_id=str(uuid4()),
        recipients=[
            {
                "userId": "recipient-1",
                "name": "Recipient 1",
                "email": "recipient1@example.com",
                "subject": "subject-1",
                "kind": "verified_email",
            }
        ],
        excluded=[],
    )
    await bulk.approve(
        user_id="owner",
        share_id=review["shareId"],
        revision=review["revision"],
        review_digest=review["reviewDigest"],
    )
    jobs = [
        await bulk.claim(
            user_id="owner",
            share_id=review["shareId"],
            position=position,
            recipient_user_id="recipient-1",
        )
        for position in (1, 2)
    ]
    assert all(jobs)
    await bulk.mark_dispatching(jobs[1])

    stopper = DriveBulkShareStore(db=bulk.db, cipher=bulk.cipher)
    parent_held, let_stop_finish, release_started = (
        threading.Event(),
        threading.Event(),
        threading.Event(),
    )
    stop_pid, release_pid = [], []
    stop_owned = stopper._owned

    def hold_stop_parent(connection, *args, **kwargs):
        row = stop_owned(connection, *args, **kwargs)
        stop_pid.append(connection.execute(text("SELECT pg_backend_pid()")).scalar_one())
        parent_held.set()
        assert let_stop_finish.wait(4), "stop barrier was not released"
        return row

    def observe_release_graph_gate(connection, *, user_ids):
        release_pid.append(connection.execute(text("SELECT pg_backend_pid()")).scalar_one())
        release_started.set()
        return lock_connection_graph_users(connection, user_ids=user_ids)

    monkeypatch.setattr(stopper, "_owned", hold_stop_parent)
    stop_task = asyncio.create_task(stopper.stop(user_id="owner", share_id=review["shareId"]))
    release_task = None
    try:
        assert await asyncio.to_thread(parent_held.wait, 2)
        monkeypatch.setattr(
            "hushh_mcp.services.connection_graph_service.lock_connection_graph_users",
            observe_release_graph_gate,
        )
        release_task = asyncio.create_task(
            bulk.release(jobs[0], error="provider_unavailable", retryable=True)
        )
        assert await asyncio.to_thread(release_started.wait, 2)
        # The recipient graph gate now serializes both writers before either
        # can lock an effect. Observe real PostgreSQL blocking at that gate.
        deadline = asyncio.get_running_loop().time() + 1
        while True:
            with bulk.db.engine.connect() as connection:
                blocked = connection.execute(
                    text("SELECT :holder = ANY(pg_blocking_pids(:waiter))"),
                    {"holder": stop_pid[0], "waiter": release_pid[0]},
                ).scalar_one()
            if blocked:
                break
            assert asyncio.get_running_loop().time() < deadline, "release did not wait on Stop"
            await asyncio.sleep(0.01)
    finally:
        let_stop_finish.set()
        outcomes = await asyncio.wait_for(
            asyncio.gather(
                *([stop_task, release_task] if release_task else [stop_task]),
                return_exceptions=True,
            ),
            6,
        )
    assert not any(isinstance(outcome, BaseException) for outcome in outcomes)
    assert outcomes[0]["status"] == "stopped"
    assert outcomes[1] in {"skipped", "failed", "superseded"}

    # Stop cannot erase a confirmed Google receipt from a dispatched write.
    assert await bulk.settle(
        jobs[1],
        state="succeeded",
        receipt={"managed": True, "permission_id": "synthetic-confirmed-permission"},
    )
    final = await bulk.review(user_id="owner", share_id=review["shareId"])
    assert final["status"] == "stopped"
    assert final["counts"]["total"] == final["counts"]["processed"] == 3
    assert final["counts"]["shared"] == 1
    assert final["counts"]["skipped"] + final["counts"]["failed"] == 2
    assert final["counts"]["pending"] == final["counts"]["unknown"] == 0
    delivered = await bulk.recipient_files(
        recipient_user_id="recipient-1",
        recipient_subject="subject-1",
        recipient_email="recipient1@example.com",
        share_id=review["shareId"],
    )
    assert delivered["sharedCount"] == 1
    assert [item["name"] for item in delivered["files"]] == ["Financial document 2"]


class _Stream(httpx.AsyncByteStream):
    def __init__(self, payload):
        self.data = json.dumps(payload).encode()

    async def __aiter__(self):
        yield self.data


class _Drive:
    """Synthetic Drive REST behind the real permission adapter.

    Records every call. ``acl`` is what permissions.list returns per file; a
    test edits it to show what Google holds after a create it answered.
    ``list_failures`` holds statuses the next permissions.list calls answer.
    """

    def __init__(self, monkeypatch, create):
        self.calls, self.acl, self.create = [], {}, create
        self.list_failures = []
        original = httpx.AsyncClient
        monkeypatch.setattr(
            httpx,
            "AsyncClient",
            lambda **kw: original(**kw, transport=httpx.MockTransport(self)),
        )

    def __call__(self, request):
        file_id = request.url.path.split("/files/", 1)[1].split("/", 1)[0]
        if request.method == "POST":
            self.calls.append(("create", file_id, request.url.params["sendNotificationEmail"]))
            status, payload = self.create(file_id)
        elif request.url.path.endswith("/permissions"):
            self.calls.append(("list", file_id, None))
            if self.list_failures:
                status = self.list_failures.pop(0)
                payload = {"error": {"code": status}}
            else:
                status, payload = 200, {"permissions": list(self.acl.get(file_id, ()))}
        else:
            self.calls.append(("inspect", file_id, None))
            status, payload = (
                200,
                {
                    "id": file_id,
                    "name": f"Financial document {file_id.removeprefix('file-')}",
                    "mimeType": "application/pdf",
                    "trashed": False,
                    "modifiedTime": "2026-09-27T00:00:00Z",
                    "capabilities": {"canShare": True},
                },
            )
        return httpx.Response(status, stream=_Stream(payload))

    def creates(self):
        return [call for call in self.calls if call[0] == "create"]


def _google_error(status, reason, message="Bad Request"):
    return status, {
        "error": {
            "code": status,
            "message": message,
            "errors": [{"domain": "global", "reason": reason, "message": message}],
        }
    }


_SHARED_WITHOUT_EMAIL = (
    'Bad Request. User message: "Sorry, the items were successfully shared but emails '
    'could not be sent to recipient1@example.com."'
)
_NO_GOOGLE_ACCOUNT = (
    'Bad Request. User message: "You are trying to invite recipient1@example.com. Since '
    "there is no Google account associated with this email address, you must check the "
    '"Notify people" box to invite this recipient."'
)
_ACL_CHANGE_NOT_ALLOWED = 'Bad Request. User message: "ACL change not allowed."'


def _viewer(file_id, *, role="reader"):
    return {
        "id": f"permission-{file_id}",
        "type": "user",
        "role": role,
        "emailAddress": "recipient1@example.com",
    }


async def _approved_share(bulk, count=1, recipient_ids=(1,)):
    review = await bulk.create_review(
        user_id="owner",
        search_job_id=_seed_completed_search(bulk, count=count),
        client_request_id=str(uuid4()),
        recipients=[
            {
                "userId": f"recipient-{n}",
                "name": f"Recipient {n}",
                "email": f"recipient{n}@example.com",
                "subject": f"subject-{n}",
                "kind": "verified_email",
            }
            for n in recipient_ids
        ],
        excluded=[],
    )
    await bulk.approve(
        user_id="owner",
        share_id=review["shareId"],
        revision=review["revision"],
        review_digest=review["reviewDigest"],
    )
    return review["shareId"]


def _worker(bulk):
    return DriveBulkShareWorker(
        store=bulk,
        adapter=GoogleDrivePermissionAdapter(),
        oauth=SimpleNamespace(
            current_credential=AsyncMock(
                return_value=(
                    {"connection_generation": 7},
                    {
                        "accessToken": "synthetic-token",
                        "subject": "owner-google",
                        "oauthClientId": "synthetic-client",
                    },
                )
            )
        ),
        verify_recipient=AsyncMock(),
        wake=AsyncMock(),
    )


def _row(share, position=1):
    return {
        "user_id": "owner",
        "share_id": share,
        "position": position,
        "recipient_user_id": "recipient-1",
    }


def _effect(bulk, share, position=1):
    with bulk.db.engine.begin() as connection:
        row = connection.execute(
            text("""SELECT e.*,EXTRACT(EPOCH FROM GREATEST(e.next_at, a.sharing_cooldown_until)-clock_timestamp()) AS wait
            FROM drive_bulk_share_effects e JOIN drive_bulk_shares b ON b.share_id=e.share_id
            LEFT JOIN drive_rest_owner_admission a ON a.user_id=b.user_id AND a.connection_generation=b.connection_generation
            WHERE e.share_id=:share AND e.position=:position"""),
            {"share": share, "position": position},
        ).mappings()
        return dict(row.one())


def _due_now(bulk, share, position=1):
    # Explicit synthetic time advancement of BOTH persisted pacing authorities.
    with bulk.db.engine.begin() as connection:
        connection.execute(
            text(
                "UPDATE drive_rest_owner_admission SET sharing_cooldown_until=clock_timestamp()-INTERVAL '1 second'"
            )
        )
        connection.execute(
            text("""UPDATE drive_bulk_share_effects
            SET next_at=clock_timestamp()-INTERVAL '1 second'
            WHERE share_id=:share AND position=:position"""),
            {"share": share, "position": position},
        )


def _requester_summary(bulk, share, total=1):
    with bulk.db.engine.begin() as connection:
        return bulk_outcome_summary(
            connection, share_id=share, total=total, recipient_user_id="recipient-1"
        )


def _receipt(bulk, share, position=1):
    return bulk._open(
        _effect(bulk, share, position)["receipt_envelope"],
        user_id="owner",
        resource_id=f"{share}:{position}:recipient-1",
        purpose="bulk-share-receipt",
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "answer,listed,state,code,managed",
    [
        # Google's 400 after a real share: the exact grant becomes One's own.
        (
            _google_error(400, "invalidSharingRequest", _SHARED_WITHOUT_EMAIL),
            _viewer("file-1"),
            "succeeded",
            None,
            True,
        ),
        # B has no Google account: no grant exists, and B is told why.
        (
            _google_error(400, "invalidSharingRequest", _NO_GOOGLE_ACCOUNT),
            None,
            "failed",
            "recipient_needs_google_account",
            False,
        ),
        (
            _google_error(400, "invalidSharingRequest", _ACL_CHANGE_NOT_ALLOWED),
            None,
            "failed",
            "drive_policy_blocked",
            False,
        ),
        # A grant that exists wins over any wording Google used.
        (
            _google_error(400, "invalidSharingRequest", _NO_GOOGLE_ACCOUNT),
            _viewer("file-1"),
            "succeeded",
            None,
            True,
        ),
        # Negative controls: a different role is never adopted, and a generic
        # uncertain write keeps the existing unattributed reconciliation.
        (
            _google_error(400, "invalidSharingRequest", _SHARED_WITHOUT_EMAIL),
            _viewer("file-1", role="writer"),
            "present_unattributed",
            "permission_outcome_unknown",
            False,
        ),
        (
            (503, {"error": {"code": 503}}),
            _viewer("file-1"),
            "present_unattributed",
            "permission_outcome_unknown",
            False,
        ),
    ],
    ids=[
        "shared_without_email",
        "no_google_account",
        "policy",
        "grant_wins",
        "other_role",
        "generic_unknown",
    ],
)
async def test_invalid_sharing_answer_is_reconciled_before_it_settles(
    bulk, monkeypatch, answer, listed, state, code, managed
):
    share = await _approved_share(bulk)
    drive = _Drive(monkeypatch, create=lambda file_id: answer)
    worker = _worker(bulk)

    assert await worker._effect(_row(share)) == "unknown"
    pending = _effect(bulk, share)
    assert pending["state"] == "unknown"
    assert pending["safe_error_code"] == "permission_outcome_unknown"
    # Until reconciled, B sees "checking", never a refusal or a success.
    assert _requester_summary(bulk, share)["counts"]["unknown"] == 1

    if listed is not None:
        drive.acl["file-1"] = [listed]
    _due_now(bulk, share)
    assert await worker._effect(_row(share)) == state

    settled = _effect(bulk, share)
    assert (settled["state"], settled["safe_error_code"]) == (state, code)
    receipt = _receipt(bulk, share)
    plan = managed_bulk_plan(
        receipt=receipt,
        file={"id": "file-1"},
        recipient={"email": "recipient1@example.com"},
    )
    # A managed grant can be removed by Stop or expiry; nothing else can.
    assert (plan is not None) is managed
    if managed:
        assert receipt["permission_id"] == "permission-file-1"
        assert receipt["issuer"] == {"subject": "owner-google", "oauthClientId": "synthetic-client"}
    # One POST, read-only reconciliation, and never a per-file email.
    assert drive.creates() == [("create", "file-1", "false")]
    assert [call[0] for call in drive.calls] == ["inspect", "list", "create", "list"]
    assert await bulk.due() == []
    summary = _requester_summary(bulk, share)
    if code in {"recipient_needs_google_account", "drive_policy_blocked"}:
        assert summary["counts"]["failed"] == 1
        # Released clients parse only codes they know; the exact one is additive.
        assert summary["issues"] == [{"reasonCode": "permission_rejected", "count": 1}]
        assert summary["issueDetails"] == [{"reasonCode": code, "count": 1}]
    if state == "succeeded":
        assert summary["counts"]["shared"] == 1 and summary["issues"] == []
        assert "issueDetails" not in summary


@pytest.mark.asyncio
async def test_plain_bad_request_is_rejected_once_and_never_retried(bulk, monkeypatch):
    share = await _approved_share(bulk)
    drive = _Drive(monkeypatch, create=lambda file_id: _google_error(400, "badRequest"))
    worker = _worker(bulk)

    assert await worker._effect(_row(share)) == "failed"
    effect = _effect(bulk, share)
    assert (effect["state"], effect["safe_error_code"]) == ("failed", "permission_rejected")
    assert effect["receipt_envelope"] is None
    _due_now(bulk, share)
    assert await bulk.due() == []
    assert await worker._effect(_row(share)) == "not_claimed"
    # No reconciliation read and no second POST for a plain refusal.
    assert [call[0] for call in drive.calls] == ["inspect", "list", "create"]
    assert _requester_summary(bulk, share)["issues"] == [
        {"reasonCode": "permission_rejected", "count": 1}
    ]


@pytest.mark.asyncio
async def test_sharing_rate_limit_waits_minutes_and_rechecks_absence_before_any_post(
    bulk, monkeypatch
):
    share = await _approved_share(bulk, count=2)
    limited = _google_error(403, "sharingRateLimitExceeded", "Rate Limit Exceeded")
    drive = _Drive(monkeypatch, create=lambda file_id: limited)
    worker = _worker(bulk)

    assert await worker._effect(_row(share, 1)) == "queued"
    first = _effect(bulk, share, 1)
    assert (first["state"], first["safe_error_code"]) == ("queued", "sharing_rate_limited")
    assert 280 < first["wait"] <= 300
    # The limit is the owner's: the batch's other file waits too.
    assert 280 < _effect(bulk, share, 2)["wait"] <= 300
    assert await bulk.due() == []
    assert await worker._effect(_row(share, 1)) == "not_claimed"
    assert len(drive.creates()) == 1

    # Google holds the grant after all: the absence check finds it, no POST.
    drive.acl["file-1"] = [_viewer("file-1")]
    _due_now(bulk, share, 1)
    assert await worker._effect(_row(share, 1)) == "preexisting"
    assert [call[0] for call in drive.calls[-2:]] == ["inspect", "list"]
    assert len(drive.creates()) == 1

    # Six quota attempts: 5m,30m,2h,6h, then the first-refusal24h boundary.
    for expected in (300, 1800, 7200, 21600, 86400):
        _due_now(bulk, share, 2)
        before = len(drive.calls)
        assert await worker._effect(_row(share, 2)) == "queued"
        # Every attempt checks absence immediately before its POST.
        assert [call[0] for call in drive.calls[before:]] == ["inspect", "list", "create"]
        assert expected - 20 < _effect(bulk, share, 2)["wait"] <= expected
    _due_now(bulk, share, 2)
    assert await worker._effect(_row(share, 2)) == "failed"
    assert (_effect(bulk, share, 2)["state"], _effect(bulk, share, 2)["safe_error_code"]) == (
        "failed",
        "sharing_rate_limited",
    )
    assert len(drive.creates()) == 7
    assert {call[2] for call in drive.creates()} == {"false"}
    summary = _requester_summary(bulk, share, total=2)
    assert summary["counts"]["alreadyShared"] == 1
    assert summary["issues"] == [{"reasonCode": "provider_unavailable", "count": 1}]
    assert summary["issueDetails"] == [{"reasonCode": "sharing_rate_limited", "count": 1}]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "failure,state",
    [
        # Quota or a 5xx can pass: the read repeats later, however many of the
        # effect's attempts the refusals used.
        (503, "unknown"),
        (429, "unknown"),
        # Negative control: an unreadable file keeps the five-attempt bound.
        (404, "failed"),
    ],
    ids=["unavailable", "read_rate_limited", "unreadable"],
)
async def test_refusals_then_an_uncertain_post_never_end_on_one_failed_read(
    bulk, monkeypatch, failure, state
):
    share = await _approved_share(bulk)
    limited = _google_error(403, "sharingRateLimitExceeded", "Rate Limit Exceeded")
    answers = [limited] * 4 + [_google_error(400, "invalidSharingRequest", _SHARED_WITHOUT_EMAIL)]
    drive = _Drive(monkeypatch, create=lambda file_id: answers.pop(0))
    worker = _worker(bulk)
    for _ in range(4):
        assert await worker._effect(_row(share)) == "queued"
        _due_now(bulk, share)
    # The fifth POST: Google created the grant but answered invalidSharingRequest.
    assert await worker._effect(_row(share)) == "unknown"
    assert _effect(bulk, share)["attempts"] == 5
    drive.acl["file-1"] = [_viewer("file-1")]
    drive.list_failures.append(failure)
    _due_now(bulk, share)
    assert await worker._effect(_row(share)) == state
    effect = _effect(bulk, share)
    assert (effect["state"], effect["safe_error_code"]) == (state, "permission_outcome_unknown")
    if state == "failed":
        assert await bulk.due() == []
        assert len(drive.creates()) == 5
        return
    # A longer wait, then the next read records the grant as One's own, so
    # Stop and expiry can remove it.
    assert 3500 < effect["wait"] <= 3600
    assert await bulk.due() == []
    _due_now(bulk, share)
    assert await worker._effect(_row(share)) == "succeeded"
    plan = managed_bulk_plan(
        receipt=_receipt(bulk, share),
        file={"id": "file-1"},
        recipient={"email": "recipient1@example.com"},
    )
    assert plan is not None
    # Reconciliation only reads: five creates, all before the uncertainty.
    assert len(drive.creates()) == 5


# The codes in BULK_REASON_CODES of every app released before 2026-10-17.
# Those apps bundle their web assets and refuse any other code.
_RELEASED_CLIENT_REASONS = frozenset(
    {
        "source_changed",
        "source_not_shareable",
        "recipient_changed",
        "connection_changed",
        "stopped",
        "sharing_unavailable",
        "date_range_required",
        "retry_limit",
        "provider_unavailable",
        "permission_rejected",
        "permission_outcome_unknown",
        "permission_catalog_incomplete",
        "unavailable",
    }
)


def test_every_public_reason_reaches_released_clients_as_a_code_they_parse():
    from hushh_mcp.services.drive_bulk_share_store import (
        _SAFE_REASONS,
        legacy_bulk_reason,
        safe_bulk_reason,
    )

    for code in [*_SAFE_REASONS, "private_provider_message", None]:
        assert legacy_bulk_reason(code) in _RELEASED_CLIENT_REASONS
        # A code they already know passes through unchanged.
        if safe_bulk_reason(code) in _RELEASED_CLIENT_REASONS:
            assert legacy_bulk_reason(code) == safe_bulk_reason(code)
    assert legacy_bulk_reason("recipient_needs_google_account") == "permission_rejected"
    assert legacy_bulk_reason("drive_policy_blocked") == "permission_rejected"
    assert legacy_bulk_reason("sharing_rate_limited") == "provider_unavailable"


@pytest.mark.asyncio
async def test_owner_outcomes_keep_released_codes_with_the_exact_code_beside_them(
    bulk, monkeypatch
):
    share = await _approved_share(bulk, count=3)
    answers = {
        "file-1": _google_error(403, "shareOutNotPermitted", "Sharing outside not permitted"),
        "file-2": _google_error(400, "badRequest"),
        "file-3": _google_error(403, "sharingRateLimitExceeded", "Rate Limit Exceeded"),
    }
    _Drive(monkeypatch, create=lambda file_id: answers[file_id])
    worker = _worker(bulk)
    assert [await worker._effect(_row(share, position)) for position in (1, 2, 3)] == [
        "failed",
        "failed",
        "queued",
    ]

    page = await bulk.files(user_id="owner", share_id=share)
    assert {item["position"]: item["outcomes"] for item in page["files"]} == {
        1: [
            {
                "status": "failed",
                "reasonCode": "permission_rejected",
                "reasonDetail": "drive_policy_blocked",
            }
        ],
        # Negative control: a code every client knows carries no detail.
        2: [{"status": "failed", "reasonCode": "permission_rejected"}],
        3: [
            {
                "status": "queued",
                "reasonCode": "provider_unavailable",
                "reasonDetail": "sharing_rate_limited",
            }
        ],
    }
    view = await bulk.review(user_id="owner", share_id=share)
    assert view["issues"] == [{"reasonCode": "permission_rejected", "count": 2}]
    assert view["issueDetails"] == [
        {"reasonCode": "drive_policy_blocked", "count": 1},
        {"reasonCode": "permission_rejected", "count": 1},
    ]
    assert {item["reasonCode"] for item in view["issues"]} <= _RELEASED_CLIENT_REASONS


@pytest.mark.asyncio
async def test_two_replicas_share_owner_admission_across_connection_generations(bulk):
    from hushh_mcp.services.drive_rest_admission import owner_scope, rest_admission

    active, peak, starts = 0, 0, []
    held, release = asyncio.Event(), asyncio.Event()
    loop = asyncio.get_running_loop()

    async def call(generation):
        nonlocal active, peak
        # Two independent context/store instances represent separate replicas.
        async with owner_scope(db=bulk.db, owner="owner", generation=generation):
            async with rest_admission():
                starts.append(loop.time())
                active += 1
                peak = max(peak, active)
                if active == 8:
                    held.set()
                await release.wait()
                active -= 1

    tasks = [asyncio.create_task(call(7 + i % 2)) for i in range(9)]
    try:
        await asyncio.wait_for(held.wait(), 5)
        assert peak == 8 and len(starts) == 8
        assert sorted(starts)[-1] - min(starts) >= 0.69
        await asyncio.sleep(0.15)
        assert len(starts) == 8  # Reconnect did not create eight additional slots.
        tasks[-1].cancel()
        release.set()
        await asyncio.gather(*tasks, return_exceptions=True)
        with bulk.db.engine.begin() as connection:
            assert (
                connection.execute(text("SELECT count(*) FROM drive_rest_call_leases")).scalar_one()
                == 0
            )
    finally:
        release.set()
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


@pytest.mark.asyncio
async def test_same_file_claim_serializes_sibling_bulk_batches_and_retains_unknown(
    bulk, monkeypatch
):
    first = await _approved_share(bulk, recipient_ids=(1, 2))
    second_row = {**_row(first), "recipient_user_id": "recipient-2"}
    job = await bulk.claim(**_row(first))
    assert job is not None
    assert await bulk.claim(**second_row) is None
    await bulk.mark_dispatching(job)
    await bulk.release(job, error="permission_outcome_unknown", uncertain=True)
    assert await bulk.claim(**second_row) is None
    with bulk.db.engine.begin() as connection:
        connection.execute(
            text(
                "UPDATE drive_bulk_share_effects SET lease_expires_at=clock_timestamp()-INTERVAL '1 second' WHERE share_id=:share AND lease_id IS NOT NULL"
            ),
            {"share": first},
        )
        assert (
            connection.execute(
                text("SELECT count(*) FROM drive_share_file_claims WHERE bulk_share_id=:share"),
                {"share": first},
            ).scalar_one()
            == 1
        )
    assert await bulk.claim(**second_row) is None


@pytest.mark.asyncio
async def test_quota_recovery_persists_counters_and_migration_replay_does_not_reset(
    bulk, monkeypatch
):
    share = await _approved_share(bulk)
    _Drive(
        monkeypatch,
        create=lambda _: _google_error(403, "sharingRateLimitExceeded", "Rate Limit Exceeded"),
    )
    assert await _worker(bulk)._effect(_row(share)) == "queued"
    before = _effect(bulk, share)
    assert before["sharing_quota_attempts"] == 1 and before["ordinary_failure_attempts"] == 0
    with bulk.db.engine.begin() as connection:
        connection.exec_driver_sql(
            (MIGRATIONS / "439_drive_rest_owner_admission.sql").read_text().replace("%", "%%")
        )
    after = _effect(bulk, share)
    assert after["sharing_quota_attempts"] == before["sharing_quota_attempts"]
    assert after["first_sharing_quota_at"] == before["first_sharing_quota_at"]
    assert after["ordinary_failure_attempts"] == before["ordinary_failure_attempts"]
    assert await DriveBulkShareStore(db=bulk.db).due() == []


@pytest.mark.asyncio
async def test_file_claim_constraint_survives_historical_and_current_migration_replay(bulk):
    share = await _approved_share(bulk)
    job = await bulk.claim(**_row(share))
    assert job is not None
    with bulk.db.engine.begin() as connection:
        old = (MIGRATIONS / "234_drive_permission_management_retention.sql").read_text()
        start = old.index("ALTER TABLE drive_share_file_claims ALTER COLUMN")
        end = old.index("END $$;", start) + len("END $$;")
        # Execute the actual historical replay section, not a copied constraint.
        connection.exec_driver_sql(old[start:end].replace("%", "%%"))
        for _ in range(2):
            connection.exec_driver_sql(
                (MIGRATIONS / "440_drive_permission_file_claim_lanes.sql")
                .read_text()
                .replace("%", "%%")
            )
        assert (
            connection.execute(
                text("SELECT count(*) FROM drive_share_file_claims WHERE bulk_share_id=:share"),
                {"share": share},
            ).scalar_one()
            == 1
        )
    await bulk.require_current(job)


@pytest.mark.asyncio
async def test_owner_cooldown_and_pacing_lease_survive_reconnect(bulk):
    from hushh_mcp.services.drive_rest_admission import (
        DriveRestAdmission,
        set_sharing_cooldown,
        sharing_cooldown,
    )

    admission = DriveRestAdmission(db=bulk.db)
    lease, _ = await admission.acquire("owner", 8)
    with bulk.db.engine.begin() as connection:
        until = connection.execute(
            text("SELECT clock_timestamp()+INTERVAL '5 minutes'")
        ).scalar_one()
        set_sharing_cooldown(connection, "owner", 7, until)
        assert sharing_cooldown(connection, "owner", 8) == until
        connection.execute(
            text(
                "UPDATE drive_rest_call_leases SET expires_at=clock_timestamp()+INTERVAL '1 second' WHERE lease_id=:lease"
            ),
            {"lease": lease},
        )
    assert await admission.pace("owner", 8, lease) == 0
    with bulk.db.engine.begin() as connection:
        remaining = connection.execute(
            text(
                "SELECT EXTRACT(EPOCH FROM expires_at-clock_timestamp()) FROM drive_rest_call_leases WHERE lease_id=:lease"
            ),
            {"lease": lease},
        ).scalar_one()
        assert remaining > 110
    await admission.release(lease)
