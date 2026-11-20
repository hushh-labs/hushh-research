"""An allowed Drive request reaches its payment step without avoidable waits.

On 2026-10-30 an allowed request showed its payment button after about six
minutes. Planner loading at worker start-up is guarded in
tests/test_drive_worker_server.py; these guard the other waits.
"""

# ruff: noqa: F401, F811 -- isolated PostgreSQL fixtures imported from their owners

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import text

from hushh_mcp.services import drive_trusted_auto_service as trusted_module
from hushh_mcp.services.drive_owner_search_store import DriveOwnerSearchStore
from hushh_mcp.services.drive_request_bulk_service import DriveRequestBulkService
from hushh_mcp.services.drive_search_start import owner_search_active
from hushh_mcp.services.drive_share_notification_worker import (
    PROMPT_NOTIFICATION_TYPES,
    DriveShareNotificationWorker,
)
from hushh_mcp.services.drive_trusted_auto_service import DriveTrustedAutoService
from hushh_mcp.services.google_drive_adapter import DriveReadError
from tests.services.test_drive_request_bulk_postgres import _request, _search, request_bulk
from tests.services.test_drive_share_notification_worker import notification_store
from tests.services.test_drive_sharing_store import (
    MIGRATIONS,
    connector_postgres_url,
    documents,
    drive,
    drive_connect,
    lifecycle,
    sharing,
)
from tests.services.test_drive_trusted_auto import _membership
from tests.services.test_drive_trusted_auto import _request as _trusted_request
from tests.services.test_drive_work_drain import _drain, _worker


@pytest.mark.asyncio
async def test_worker_warmup_builds_the_agent_the_request_planner_builds(monkeypatch):
    from hushh_mcp.hushh_adk import single_turn
    from hushh_mcp.services import drive_suggestion_service as planner
    from hushh_mcp.services.drive_planner_warmup import warm_semantic_request_planner

    monkeypatch.setenv("ENVIRONMENT", "test")
    # The worker swallows warm-up failures by design, so prove the real one completes.
    warm_semantic_request_planner()

    built = []

    def record(gene, **kwargs):
        built.append((gene.id, kwargs["output_schema"], sorted(kwargs)))
        return object()

    monkeypatch.setattr(single_turn, "build_single_turn_agent", record)
    monkeypatch.setattr(planner, "build_single_turn_agent", record)
    monkeypatch.setattr(planner, "run_single_turn", AsyncMock(return_value={}))
    warm_semantic_request_planner()
    await planner._interpret_live_search(prompt="{}", user_id="owner", semantic=True)
    # A renamed gene or changed schema would leave the first plan cold again.
    assert len(built) == 2 and built[0] == built[1]
    assert built[0][:2] == ("agent_documents_request_search", planner.SemanticLiveSearchModelPlan)


@pytest.mark.asyncio
async def test_request_and_payment_notices_do_not_wait_for_grants():
    workers = [_worker({"outcomes": {}}) for _ in range(4)]
    prompt_pass = asyncio.Event()

    async def grant(**_):
        # A grant batch still running must not hold back the payment notice.
        await asyncio.wait_for(prompt_pass.wait(), 2)
        return {"outcomes": {}}

    async def notify(**bounds):
        if bounds.get("event_types") == PROMPT_NOTIFICATION_TYPES:
            prompt_pass.set()
        return {"outcomes": {"settled": 1}}

    workers[2].run.side_effect = grant
    workers[3].run.side_effect = notify
    result = await _drain(workers).run(stage="sharing")

    assert result["workers"]["permissions"] == {}
    assert workers[3].run.await_count == 2


@pytest.mark.asyncio
async def test_prompt_pass_sends_only_notices_that_need_no_grant(monkeypatch):
    monkeypatch.setattr(
        "hushh_mcp.services.drive_share_notification_worker.connector_feature_enabled",
        lambda *_: True,
    )

    def outbox(events):
        pending = {
            event_id: {"event_id": event_id, "user_id": "recipient", "event_type": kind}
            for event_id, kind in events
        }

        async def due(limit, types=()):
            return [e for e in pending.values() if not types or e["event_type"] in types][:limit]

        async def claim(*, event_id):
            return pending.pop(event_id, None)

        return SimpleNamespace(
            due=AsyncMock(side_effect=due), claim=AsyncMock(side_effect=claim), pending=pending
        )

    shares = outbox(
        [
            ("1", "document_share_outcome"),
            ("2", "document_share_payment_ready"),
            ("3", "document_share_request"),
            ("4", "document_share_payment_confirmed"),
        ]
    )
    questions = outbox([("5", "document_share_question")])
    worker = DriveShareNotificationWorker(stores=(shares, questions))
    worker._dispatch = AsyncMock(return_value="settled")

    prompt = await worker.run(
        max_jobs=20, deadline_seconds=35, event_types=PROMPT_NOTIFICATION_TYPES
    )
    assert prompt["outcomes"] == {"settled": 3}
    # An outcome reports shared files, so it stays queued for the pass after grants.
    assert list(shares.pending) == ["1"]
    questions.due.assert_not_awaited()
    # The pass asks the outbox for its own types, so it never reorders other notices.
    assert {call.kwargs.get("types") for call in shares.due.await_args_list} == {
        tuple(sorted(PROMPT_NOTIFICATION_TYPES))
    }

    full = await worker.run(max_jobs=20, deadline_seconds=35)
    assert full["outcomes"] == {"settled": 2}
    assert not shares.pending and not questions.pending
    with pytest.raises(ValueError, match="invalid worker bounds"):
        await worker.run(event_types=frozenset({"document_share_unknown"}))


@pytest.mark.asyncio
async def test_a_typed_outbox_read_leaves_other_notices_in_their_place(
    request_bulk, sharing, notification_store
):
    await _request(sharing)  # Queues the owner's request notice and the requester's receipt.
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_share_events
              SET notification_next_attempt_at=clock_timestamp()-INTERVAL '1 second'""")
        )

    def inspected():
        with sharing.db.engine.connect() as connection:
            return dict(
                connection.execute(
                    text("""SELECT event_type,notification_inspected_at FROM drive_share_events
                      WHERE notification_state='queued'""")
                ).all()
            )

    before = inspected()
    assert {"document_share_request", "document_share_request_sent"} <= set(before)
    due = await notification_store.due(20, types=("document_share_request",))

    assert [item["event_type"] for item in due] == ["document_share_request"]
    after = inspected()
    # Only the notice that was read moves back; the full pass reaches the rest first.
    assert after["document_share_request_sent"] == before["document_share_request_sent"]
    assert after["document_share_request"] > before["document_share_request"]
    assert {item["event_type"] for item in await notification_store.due(20)} == set(before)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("v1_only", "stages"), [(False, ["suggestions", "sharing"]), (True, ["v1"])]
)
async def test_a_started_search_wakes_its_slice_and_the_checkout_lane(monkeypatch, v1_only, stages):
    # Checkout needs only a started search. Waiting for the next sharing sweep
    # added up to a minute before the payment button. The V1 slice runs Checkout.
    class Started:
        def __init__(self, **_):
            pass

        async def start_search(self, **_):
            return {"status": "queued"}

    monkeypatch.setattr(trusted_module, "DriveRequestBulkService", Started)
    sharing = SimpleNamespace(
        db=object(),
        due_trusted_searches=AsyncMock(
            return_value=[{"user_id": "owner", "request_id": "request-1"}]
        ),
        defer_trusted_search=AsyncMock(),
    )
    wake = AsyncMock()
    auto = DriveTrustedAutoService(
        sharing=sharing, bulk=SimpleNamespace(), payment=SimpleNamespace(), wake=wake
    )
    monkeypatch.setattr(auto, "_authority", lambda *_: AsyncMock())

    assert await auto.start_pending(v1_only=v1_only) == {"started": 1, "deferred": 0}
    assert [call.args[0] for call in wake.await_args_list] == stages


@pytest.mark.asyncio
async def test_a_busy_owner_is_seen_before_any_plan_is_made(request_bulk, sharing):
    store = DriveOwnerSearchStore(db=sharing.db)
    first = (await _request(sharing))["requestId"]
    second = (await _request(sharing))["requestId"]
    job = _search(request_bulk, request_id=first, count=1)

    def job_state(assignments):
        with sharing.db.engine.begin() as connection:
            connection.execute(
                text(f"UPDATE drive_owner_search_jobs SET {assignments} WHERE job_id=:job"),
                {"job": job},
            )

    running = (
        "status='running',connection_generation=1,period_packet_id=NULL,lease_id=NULL,"
        "lease_expires_at=NULL,expires_at=clock_timestamp()+INTERVAL '1 hour'"
    )
    job_state(running)
    assert await owner_search_active(store, "owner", second) is True
    # A request's own search never holds it back; create() returns that search.
    assert await owner_search_active(store, "owner", first) is False

    # The owner's searches run one at a time. The second request now waits
    # without spending a model plan that create() would refuse afterwards.
    planner = AsyncMock(side_effect=AssertionError("planned while the owner was busy"))
    search = SimpleNamespace(
        store=store, create_for_request=AsyncMock(side_effect=AssertionError("created"))
    )
    service = DriveRequestBulkService(
        sharing=sharing,
        search=search,
        bulk=request_bulk,
        planner=planner,
        semantic_planner=planner,
        require_owner=AsyncMock(),
        wake=AsyncMock(),
    )
    with pytest.raises(DriveReadError, match="search_in_progress"):
        await service.start_search(user_id="owner", request_id=second)
    planner.assert_not_awaited()

    # Before refusing, create() removes expired searches, stops background
    # preparation that holds no live lease, and fails another account's search.
    # None of these may hold the request back.
    # This compact schema keeps migration 411's packet column without packet heads.
    preparation = "period_packet_id=gen_random_uuid()"
    for finished in (
        "expires_at=clock_timestamp()-INTERVAL '1 minute'",
        "connection_generation=2",
        "status='completed'",
        f"{preparation},status='queued'",
        f"{preparation},lease_id=gen_random_uuid(),"
        "lease_expires_at=clock_timestamp()-INTERVAL '1 second'",
    ):
        job_state(running)
        job_state(finished)
        assert await owner_search_active(store, "owner", second) is False, finished

    # A preparation slice that holds a live lease is running, so create() refuses.
    job_state(running)
    job_state(
        f"{preparation},expires_at=clock_timestamp()-INTERVAL '1 minute',"
        "lease_id=gen_random_uuid(),lease_expires_at=clock_timestamp()+INTERVAL '1 minute'"
    )
    assert await owner_search_active(store, "owner", second) is True


@pytest.mark.asyncio
@pytest.mark.usefixtures("shared_hub_owner")
async def test_a_search_queued_behind_the_owners_other_search_retries_next_drain(
    request_bulk, sharing
):
    _membership(sharing, "active")
    request_id = (await _trusted_request(sharing))["requestId"]

    def seconds_until_retry():
        with sharing.db.engine.connect() as connection:
            return connection.execute(
                text("""SELECT EXTRACT(EPOCH FROM preparation_next_at-clock_timestamp())
                  FROM drive_share_requests WHERE request_id=:request"""),
                {"request": request_id},
            ).scalar_one()

    # Before: five minutes even after the other search had already finished.
    await sharing.defer_trusted_search(
        user_id="owner", request_id=request_id, code="share_in_progress"
    )
    assert seconds_until_retry() <= 0
    assert request_id in {item["request_id"] for item in await sharing.due_trusted_searches()}

    # A failed start still waits five minutes before trying again.
    await sharing.defer_trusted_search(
        user_id="owner", request_id=request_id, code="preparation_unavailable"
    )
    assert seconds_until_retry() > 240

    # So does a request whose own search exists and is waiting on a batch.
    _search(request_bulk, request_id=request_id, count=1)
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_share_requests SET preparation_next_at=clock_timestamp()
              WHERE request_id=:request"""),
            {"request": request_id},
        )
    await sharing.defer_trusted_search(
        user_id="owner", request_id=request_id, code="share_in_progress"
    )
    assert seconds_until_retry() > 240
