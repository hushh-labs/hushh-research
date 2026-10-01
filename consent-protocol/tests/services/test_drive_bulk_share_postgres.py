"""Frozen 2,000-file manifest and 4,000-effect fanout in disposable PostgreSQL."""

# ruff: noqa: F811 -- imported isolated PostgreSQL fixtures

import asyncio
import base64
import json
import threading
from pathlib import Path
from uuid import uuid4

import pytest
from sqlalchemy import text

from hushh_mcp.services.connection_graph_service import lock_connection_graph_users
from hushh_mcp.services.drive_bulk_share_store import DriveBulkShareStore
from hushh_mcp.services.drive_sharing_contract import DriveSharingError
from hushh_mcp.services.google_drive_adapter import DRIVE_BASE, DRIVE_POLICY, LIVE_POLICY_HASH
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
        connection.execute(text((MIGRATIONS / "251_drive_owner_search_jobs.sql").read_text()))
        connection.execute(text((MIGRATIONS / "254_drive_bulk_shares.sql").read_text()))
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
            ADD CONSTRAINT drive_bulk_approval_source_check
              CHECK ((approved_at IS NULL AND approval_source IS NULL)
                OR (approved_at IS NOT NULL AND approval_source IN ('owner','trusted_auto')))""")
        )
        connection.execute(
            text("ALTER TABLE drive_bulk_share_files ADD COLUMN origin_request_id UUID")
        )
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

    with bulk.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_bulk_share_effects SET state='dispatching',
              lease_id=:lease,lease_expires_at=clock_timestamp()+INTERVAL '120 seconds'
              WHERE share_id=:share"""),
            {"lease": str(uuid4()), "share": reviews[0]["shareId"]},
        )
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
