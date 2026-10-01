"""Trusted Drive requests need current authority at every automatic step."""

# ruff: noqa: F401, F811 -- isolated PostgreSQL fixtures imported from their owners

from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from sqlalchemy import text

from hushh_mcp.services.drive_live_preferences import DriveLivePreferences
from hushh_mcp.services.drive_owner_search_service import DriveOwnerSearchService
from hushh_mcp.services.drive_owner_search_store import DriveOwnerSearchStore
from hushh_mcp.services.drive_owner_search_worker import DriveOwnerSearchWorker
from hushh_mcp.services.drive_request_bulk_service import DriveRequestBulkService
from hushh_mcp.services.drive_sharing_contract import (
    DriveSharingError,
    ShareRequestPurpose,
    VerifiedGoogleRecipient,
)
from hushh_mcp.services.drive_trusted_auto_service import DriveTrustedAutoService
from hushh_mcp.services.google_drive_adapter import DriveReadError
from tests.services.test_drive_request_bulk_postgres import _search, request_bulk
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


async def _request(sharing, *, owner_initiated=False):
    return await sharing.create_request(
        recipient=VerifiedGoogleRecipient(
            "recipient", "1234567", "b@example.invalid", datetime.now(UTC)
        ),
        owner_user_id="owner",
        client_request_id=str(uuid4()),
        purpose=ShareRequestPurpose(purpose="Standup notes from last 3 months"),
        owner_initiated=owner_initiated,
    )


def _membership(sharing, status):
    with sharing.db.engine.begin() as connection:
        circle = connection.execute(
            text("""SELECT id FROM one_location_circles
            WHERE owner_user_id='owner' AND system_kind='trusted'""")
        ).scalar_one()
        connection.execute(
            text("""DELETE FROM one_location_circle_memberships
            WHERE circle_id=:circle AND user_id='recipient'"""),
            {"circle": circle},
        )
        connection.execute(
            text("""INSERT INTO one_location_circle_memberships
            (circle_id,user_id,status) VALUES (:circle,'recipient',:status)"""),
            {"circle": circle, "status": status},
        )


def _auto_job(bulk, *, request_id):
    job_id = _search(bulk, request_id=request_id, count=1)
    with bulk.db.engine.begin() as connection:
        envelope = connection.execute(
            text("SELECT checkpoint_envelope FROM drive_owner_search_jobs WHERE job_id=:job"),
            {"job": job_id},
        ).scalar_one()
        checkpoint = bulk._open(
            envelope,
            user_id="owner",
            resource_id=job_id,
            purpose="owner-search-checkpoint",
        )
        checkpoint["authority_mode"] = "trusted_auto"
        connection.execute(
            text("""UPDATE drive_owner_search_jobs
              SET checkpoint_envelope=CAST(:envelope AS jsonb),status='queued',
                next_at=clock_timestamp() WHERE job_id=:job"""),
            {
                "job": job_id,
                "envelope": bulk._seal(
                    checkpoint,
                    user_id="owner",
                    resource_id=job_id,
                    purpose="owner-search-checkpoint",
                ),
            },
        )
    return job_id


@pytest.mark.asyncio
async def test_only_new_accepted_trusted_request_gets_auto_marker(request_bulk, sharing):
    with sharing.db.engine.begin() as connection:
        connection.execute(text("UPDATE connection_origins SET status='removed'"))
    unaccepted = await _request(sharing)
    assert (await sharing.owner_review(user_id="owner", request_id=unaccepted["requestId"]))[
        "trustedAuto"
    ] is False
    with sharing.db.engine.begin() as connection:
        connection.execute(text("UPDATE connection_origins SET status='active'"))
    _membership(sharing, "active")
    accepted = await _request(sharing)
    assert (await sharing.owner_review(user_id="owner", request_id=accepted["requestId"]))[
        "trustedAuto"
    ] is True
    owner_selected = await _request(sharing, owner_initiated=True)
    assert (await sharing.owner_review(user_id="owner", request_id=owner_selected["requestId"]))[
        "trustedAuto"
    ] is False
    _membership(sharing, "removed")
    removed = await _request(sharing)
    assert (await sharing.owner_review(user_id="owner", request_id=removed["requestId"]))[
        "trustedAuto"
    ] is False
    # A pre-deploy or ordinary request does not become automatic on replay.
    with sharing.db.engine.begin() as connection:
        connection.execute(text("UPDATE connection_origins SET status='active'"))
    _membership(sharing, "active")
    assert (await sharing.owner_review(user_id="owner", request_id=unaccepted["requestId"]))[
        "trustedAuto"
    ] is False


@pytest.mark.asyncio
async def test_background_off_requires_one_setup_event_and_resumes_on_enable(request_bulk, sharing):
    _membership(sharing, "active")
    await DriveLivePreferences(db=sharing.db).set_background(
        user_id="owner", enabled=False, confirmed=True
    )
    item = await _request(sharing)
    request_id = item["requestId"]
    auto = DriveTrustedAutoService(sharing=sharing, bulk=request_bulk, wake=AsyncMock())
    outcome = await auto.start_pending()
    assert outcome == {"started": 0, "deferred": 1}
    review = await sharing.owner_review(user_id="owner", request_id=request_id)
    assert review["trustedAuto"] is True
    assert review["preparationError"] == "background_preparation_required"
    assert rows(sharing, "drive_share_permission_operations") == []
    assert [event["event_type"] for event in rows(sharing, "drive_share_events")] == [
        "document_share_request"
    ]
    # The setup event is unique, and no automatic work retries in a tight loop.
    assert (await auto.start_pending())["deferred"] == 0
    preference = DriveLivePreferences(db=sharing.db)
    await preference.set_background(user_id="owner", enabled=True, confirmed=True)
    review = await sharing.owner_review(user_id="owner", request_id=request_id)
    assert review["preparationError"] is None
    assert (await sharing.trusted_request_authority(user_id="owner", request_id=request_id))[
        "recipientUserId"
    ] == "recipient"
    assert {item["request_id"] for item in await sharing.due_trusted_searches()} == {request_id}


@pytest.mark.asyncio
async def test_background_defaults_on_but_explicit_off_survives_reconnect(request_bulk, sharing):
    _membership(sharing, "active")
    preferences = DriveLivePreferences(db=sharing.db)
    assert await preferences.get_background(user_id="owner") == {"enabled": True, "revision": 0}
    item = await _request(sharing)
    request_id = item["requestId"]
    assert (await sharing.trusted_request_authority(user_id="owner", request_id=request_id))[
        "recipientUserId"
    ] == "recipient"
    await preferences.set_background(user_id="owner", enabled=False, confirmed=True)
    assert await preferences.get_background(user_id="owner") == {"enabled": False, "revision": 1}
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE user_external_connector_connections
              SET connection_generation=connection_generation+1
              WHERE user_id='owner' AND connector_id='google_drive'""")
        )
    assert await preferences.get_background(user_id="owner") == {"enabled": False, "revision": 1}
    with pytest.raises(DriveReadError, match="background_preparation_required"):
        await sharing.trusted_request_authority(user_id="owner", request_id=request_id)
    await preferences.set_background(user_id="owner", enabled=True, confirmed=True)
    assert await preferences.get_background(user_id="owner") == {"enabled": True, "revision": 2}
    assert (await sharing.trusted_request_authority(user_id="owner", request_id=request_id))[
        "recipientUserId"
    ] == "recipient"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("preference", "live_valid", "resumed"),
    [
        ("missing", True, True),
        ("explicit_off", True, False),
        ("missing", False, False),
    ],
)
async def test_default_on_migration_only_resumes_eligible_paused_requests(
    request_bulk, sharing, preference, live_valid, resumed
):
    _membership(sharing, "active")
    preferences = DriveLivePreferences(db=sharing.db)
    await preferences.set_background(user_id="owner", enabled=False, confirmed=True)
    item = await _request(sharing)
    request_id = item["requestId"]
    auto = DriveTrustedAutoService(sharing=sharing, bulk=request_bulk, wake=AsyncMock())
    assert (await auto.start_pending())["deferred"] == 1
    with sharing.db.engine.begin() as connection:
        if preference == "missing":
            connection.execute(text("DELETE FROM drive_live_preferences WHERE user_id='owner'"))
        if not live_valid:
            connection.execute(
                text("""UPDATE user_external_connector_connections
                  SET validation_state='unverified'
                  WHERE user_id='owner' AND connector_id='google_drive'""")
            )
    with sharing.db.engine.connect() as connection:
        connection.exec_driver_sql(
            (MIGRATIONS / "261_drive_background_default_on.sql").read_text().replace("%", "%%")
        )
        connection.commit()
    review = await sharing.owner_review(user_id="owner", request_id=request_id)
    assert (review["preparationError"] is None) is resumed
    if resumed:
        assert {row["request_id"] for row in await sharing.due_trusted_searches()} == {request_id}
    else:
        assert review["preparationError"] == "background_preparation_required"


@pytest.mark.asyncio
async def test_default_on_migration_wakes_a_paused_trusted_search_job(request_bulk, sharing):
    _membership(sharing, "active")
    preferences = DriveLivePreferences(db=sharing.db)
    await preferences.set_background(user_id="owner", enabled=True, confirmed=True)
    request = await _request(sharing)
    request_id = request["requestId"]
    job_id = _auto_job(request_bulk, request_id=request_id)
    store = DriveOwnerSearchStore(db=sharing.db)
    lease = await store.claim(user_id="owner", job_id=job_id)
    assert lease is not None
    await preferences.set_background(user_id="owner", enabled=False, confirmed=True)
    await sharing.defer_trusted_search(
        user_id="owner", request_id=request_id, code="background_preparation_required"
    )
    assert await store.pause_for_background(lease) == "queued"
    with sharing.db.engine.begin() as connection:
        assert connection.execute(
            text("SELECT next_at=expires_at FROM drive_owner_search_jobs WHERE job_id=:job"),
            {"job": job_id},
        ).scalar_one()
        connection.execute(text("DELETE FROM drive_live_preferences WHERE user_id='owner'"))
    with sharing.db.engine.connect() as connection:
        connection.exec_driver_sql(
            (MIGRATIONS / "261_drive_background_default_on.sql").read_text().replace("%", "%%")
        )
        connection.commit()
    with sharing.db.engine.connect() as connection:
        assert connection.execute(
            text("SELECT next_at<expires_at FROM drive_owner_search_jobs WHERE job_id=:job"),
            {"job": job_id},
        ).scalar_one()
    assert (await sharing.owner_review(user_id="owner", request_id=request_id))[
        "preparationError"
    ] is None


@pytest.mark.asyncio
async def test_removed_trust_stops_search_and_grant_authority(request_bulk, sharing):
    _membership(sharing, "active")
    await DriveLivePreferences(db=sharing.db).set_background(
        user_id="owner", enabled=True, confirmed=True
    )
    item = await _request(sharing)
    request_id = item["requestId"]
    authority = await sharing.trusted_request_authority(user_id="owner", request_id=request_id)
    synthetic_share = {
        "origin_request_id": request_id,
        "origin_request_revision": item["revision"],
        "progressive_batch": True,
        "approval_source": "trusted_auto",
        "approved_at": datetime.now(UTC),
        "connection_generation": authority["generation"],
    }
    with sharing.db.engine.begin() as connection:
        assert request_bulk._share_recipient_current(
            connection, synthetic_share, "owner", "recipient"
        )
    preferences = DriveLivePreferences(db=sharing.db)
    await preferences.set_background(user_id="owner", enabled=False, confirmed=True)
    with sharing.db.engine.begin() as connection:
        assert not request_bulk._share_recipient_current(
            connection, synthetic_share, "owner", "recipient"
        )
    await preferences.set_background(user_id="owner", enabled=True, confirmed=True)
    _membership(sharing, "removed")
    with pytest.raises(DriveSharingError, match="trusted_request_unavailable"):
        await sharing.trusted_request_authority(user_id="owner", request_id=request_id)
    with sharing.db.engine.begin() as connection:
        assert not request_bulk._share_recipient_current(
            connection, synthetic_share, "owner", "recipient"
        )
    auto = DriveTrustedAutoService(sharing=sharing, bulk=request_bulk, wake=AsyncMock())
    assert (await auto.start_pending())["deferred"] == 1
    review = await sharing.owner_review(user_id="owner", request_id=request_id)
    assert review["preparationError"] == "trusted_relationship_changed"
    assert rows(sharing, "drive_share_permission_operations") == []


@pytest.mark.asyncio
@pytest.mark.parametrize("revocation", ["background", "trusted"])
async def test_revoked_auto_search_makes_no_provider_get_or_new_page(
    request_bulk, sharing, revocation
):
    _membership(sharing, "active")
    preferences = DriveLivePreferences(db=sharing.db)
    await preferences.set_background(user_id="owner", enabled=True, confirmed=True)
    item = await _request(sharing)
    request_id = item["requestId"]
    job_id = _auto_job(request_bulk, request_id=request_id)
    with sharing.db.engine.begin() as connection:
        before = connection.execute(
            text("""SELECT matched,pages_scanned FROM
            drive_owner_search_jobs WHERE job_id=:job"""),
            {"job": job_id},
        ).one()
    if revocation == "background":
        await preferences.set_background(user_id="owner", enabled=False, confirmed=True)
    else:
        _membership(sharing, "removed")
    transport = SimpleNamespace(read_tool=AsyncMock())
    worker = DriveOwnerSearchWorker(
        DriveOwnerSearchService(store=DriveOwnerSearchStore(db=sharing.db), transport=transport),
        trusted_auto=DriveTrustedAutoService(sharing=sharing, bulk=request_bulk, wake=AsyncMock()),
    )
    await worker.run(max_jobs=1)
    transport.read_tool.assert_not_awaited()
    with sharing.db.engine.begin() as connection:
        after = connection.execute(
            text("""SELECT status,matched,pages_scanned,
            next_at,expires_at FROM drive_owner_search_jobs WHERE job_id=:job"""),
            {"job": job_id},
        ).one()
    assert (after.matched, after.pages_scanned) == (before.matched, before.pages_scanned)
    review = await sharing.owner_review(user_id="owner", request_id=request_id)
    if revocation == "background":
        assert review["preparationError"] == "background_preparation_required"
        assert after.status == "queued" and after.next_at == after.expires_at
        await preferences.set_background(user_id="owner", enabled=True, confirmed=True)
        with sharing.db.engine.begin() as connection:
            resumed = connection.execute(
                text("""SELECT next_at<expires_at FROM
                drive_owner_search_jobs WHERE job_id=:job"""),
                {"job": job_id},
            ).scalar_one()
        assert resumed
    else:
        assert review["preparationError"] == "trusted_relationship_changed"
        assert after.status == "failed"


@pytest.mark.asyncio
async def test_background_reenabled_before_pause_keeps_search_due(request_bulk, sharing):
    _membership(sharing, "active")
    preferences = DriveLivePreferences(db=sharing.db)
    await preferences.set_background(user_id="owner", enabled=True, confirmed=True)
    request = await _request(sharing)
    job_id = _auto_job(request_bulk, request_id=request["requestId"])
    store = DriveOwnerSearchStore(db=sharing.db)
    job = await store.claim(user_id="owner", job_id=job_id)
    assert job is not None
    await preferences.set_background(user_id="owner", enabled=False, confirmed=True)
    await preferences.set_background(user_id="owner", enabled=True, confirmed=True)
    assert await store.pause_for_background(job) == "queued"
    with sharing.db.engine.begin() as connection:
        assert connection.execute(
            text("""SELECT next_at<expires_at FROM drive_owner_search_jobs
              WHERE job_id=:job"""),
            {"job": job_id},
        ).scalar_one()


@pytest.mark.asyncio
async def test_owner_takeover_resumes_same_search_without_trusted_authority(request_bulk, sharing):
    _membership(sharing, "active")
    preferences = DriveLivePreferences(db=sharing.db)
    await preferences.set_background(user_id="owner", enabled=True, confirmed=True)
    request = await _request(sharing)
    request_id = request["requestId"]
    job_id = _auto_job(request_bulk, request_id=request_id)
    store = DriveOwnerSearchStore(db=sharing.db)
    old_auto_lease = await store.claim(user_id="owner", job_id=job_id)
    assert old_auto_lease is not None
    assert await sharing.trusted_request_for_job(user_id="owner", job_id=job_id) == request_id
    _membership(sharing, "removed")
    await preferences.set_background(user_id="owner", enabled=False, confirmed=True)
    service = DriveRequestBulkService(
        sharing=sharing,
        search=DriveOwnerSearchService(store=store, transport=SimpleNamespace()),
        bulk=request_bulk,
        require_owner=AsyncMock(),
        wake=AsyncMock(),
    )
    result = await service.start_search(user_id="owner", request_id=request_id)
    assert result["status"] == "queued" and result["jobId"] == job_id
    assert await sharing.trusted_request_for_job(user_id="owner", job_id=job_id) is None
    review = await sharing.owner_review(user_id="owner", request_id=request_id)
    assert review["trustedAuto"] is False and review["preparationError"] is None
    with pytest.raises(DriveReadError, match="search_superseded"):
        await store.require_current(old_auto_lease)
    owner_lease = await store.claim(user_id="owner", job_id=job_id)
    assert owner_lease is not None
    assert owner_lease["checkpoint"]["authority_mode"] == "owner"
    await store.require_current(owner_lease)
    with sharing.db.engine.begin() as connection:
        assert (
            connection.execute(
                text("""SELECT count(*) FROM drive_owner_search_results WHERE job_id=:job"""),
                {"job": job_id},
            ).scalar_one()
            == 1
        )


@pytest.mark.asyncio
async def test_bounded_auto_batches_continue_past_first_twenty_five(monkeypatch):
    from hushh_mcp.services import drive_trusted_auto_service as module

    remaining = list(range(1, 76))
    prepared = []
    approved = []
    wakes = []

    class FakeRequestBulk:
        def __init__(self, **kwargs):
            self.require_owner = kwargs["require_owner"]

        async def prepare(self, *, positions, **kwargs):
            await self.require_owner()
            assert 1 <= len(positions) <= 25
            prepared.append(positions)
            for position in positions:
                remaining.remove(position)
            return {"shareId": str(uuid4()), "revision": 0, "reviewDigest": "digest"}

    class FakeBulkService:
        def __init__(self, **kwargs):
            self.require_owner = kwargs["require_owner"]

        async def approve(self, **kwargs):
            await self.require_owner()
            approved.append(kwargs["share_id"])
            await wake("sharing")

    async def unclaimed_positions(*, limit, **kwargs):
        return remaining[:limit]

    async def wake(stage):
        wakes.append(stage)

    bulk = SimpleNamespace(
        unclaimed_positions=unclaimed_positions,
        pending_request_reviews=AsyncMock(return_value=[]),
        refresh_request=AsyncMock(),
    )
    sharing = SimpleNamespace(db=object(), trusted_request_authority=AsyncMock(return_value={}))
    monkeypatch.setattr(module, "DriveRequestBulkService", FakeRequestBulk)
    monkeypatch.setattr(module, "DriveBulkShareService", FakeBulkService)
    service = DriveTrustedAutoService(sharing=sharing, bulk=bulk, wake=wake)
    assert (
        await service.share_available(user_id="owner", request_id=str(uuid4()), max_batches=2) == 2
    )
    assert [len(batch) for batch in prepared] == [25, 25]
    assert wakes == ["sharing", "sharing", "suggestions"]
    assert (
        await service.share_available(user_id="owner", request_id=str(uuid4()), max_batches=2) == 1
    )
    assert [len(batch) for batch in prepared] == [25, 25, 25]
    assert len(approved) == 3 and remaining == []
    assert bulk.refresh_request.await_count == 2


@pytest.mark.asyncio
async def test_old_progressive_bulk_notice_cannot_duplicate_request_event():
    from hushh_mcp.services.drive_bulk_share_worker import DriveBulkShareWorker

    send = AsyncMock()
    store = SimpleNamespace(
        claim_notification=AsyncMock(
            return_value={
                "share_id": str(uuid4()),
                "recipient_user_id": "recipient",
                "origin_request_id": str(uuid4()),
                "lease_id": str(uuid4()),
            }
        ),
        settle_notification=AsyncMock(return_value="settled"),
    )
    worker = DriveBulkShareWorker(
        store=store,
        send_push=send,
        adapter=SimpleNamespace(),
        oauth=SimpleNamespace(),
        verify_recipient=AsyncMock(),
        wake=AsyncMock(),
    )
    assert (
        await worker._notification({"share_id": str(uuid4()), "recipient_user_id": "recipient"})
        == "settled"
    )
    send.assert_not_awaited()
    store.settle_notification.assert_awaited_once()
    assert store.settle_notification.await_args.kwargs["delivered"] is True


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("revocation", "expected"),
    [
        ("background_preparation_required", "queued"),
        ("trusted_request_unavailable", "failed"),
    ],
)
async def test_search_service_fences_revocation_before_provider_page(revocation, expected):
    job = {
        "user_id": "owner",
        "job_id": str(uuid4()),
        "checkpoint": {"phase": "user"},
        "lease_id": str(uuid4()),
    }
    store = SimpleNamespace(
        claim=AsyncMock(return_value=job),
        require_current=AsyncMock(),
        commit_page=AsyncMock(),
        pause_for_background=AsyncMock(return_value="queued"),
        release=AsyncMock(return_value="failed"),
    )
    service = DriveOwnerSearchService(store=store, transport=SimpleNamespace())
    service._page = AsyncMock()
    current = AsyncMock(side_effect=DriveReadError(revocation))
    result = await service.run_one(user_id="owner", job_id=job["job_id"], require_current=current)
    assert result == expected
    service._page.assert_not_awaited()
    store.require_current.assert_not_awaited()
    store.commit_page.assert_not_awaited()
    if revocation == "background_preparation_required":
        store.pause_for_background.assert_awaited_once_with(job)
    else:
        store.release.assert_awaited_once()
