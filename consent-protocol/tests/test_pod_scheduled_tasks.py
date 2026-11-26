"""Bounded durable schedule lifecycle; simulated provider delivery only."""

import asyncio
import base64
import json
from datetime import datetime
from types import SimpleNamespace

import pytest

from hushh_mcp.one_adk.file_schedule_proposal import propose_file_schedule


def test_sandbox_delivery_names_only_the_signed_owners_occurrence(monkeypatch):
    from hushh_mcp.services.pod_sandbox_scheduled_delivery import (
        SandboxScheduleOffer,
        sandbox_cloud_task,
    )
    from hushh_mcp.services.pod_scheduled_contracts import ScheduleRefused, occurrence_id

    edge = "https://sandbox-edge.example.test"
    worker = "sandbox-schedule@hushh-pda-dev.iam.gserviceaccount.com"
    queue = "projects/hushh-pda-dev/locations/us-central1/queues/sandbox-test"
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "dev")
    monkeypatch.setenv("HUSSH_SANDBOX_EDGE_PUBLIC_URL", edge)
    monkeypatch.setenv("HUSSH_SANDBOX_TASK_WORKER_EMAIL", worker)
    monkeypatch.setenv("HUSSH_SANDBOX_TASK_QUEUE", queue)
    placement = SimpleNamespace(hushh_id="owner-a", environment="dev", url=edge + "/u/owner-a")
    now = 2_000_000_000
    due = now + 60 * 86400
    schedule_id = "schedule_" + "a" * 32
    occurrence = occurrence_id(schedule_id, 3, due)
    offer = SandboxScheduleOffer(
        schedule_id=schedule_id, revision=3, occurrence_id=occurrence, due_at=due
    )
    assert sandbox_cloud_task(offer, placement=placement, now=now + 1) == (
        sandbox_cloud_task(offer, placement=placement, now=now)
    )
    name, task = sandbox_cloud_task(offer, placement=placement, now=now)
    assert name == queue
    assert now < datetime.fromisoformat(task["scheduleTime"]).timestamp() < due
    request = task["httpRequest"]
    assert request["url"] == placement.url + "/api/one/pod/tasks/worker"
    assert request["oidcToken"] == {"serviceAccountEmail": worker, "audience": placement.url}
    assert json.loads(base64.b64decode(request["body"])) == {
        "schedule_id": schedule_id,
        "revision": 3,
        "occurrence_id": occurrence,
    }
    placement.url = edge + "/u/owner-b"
    with pytest.raises(ScheduleRefused, match="SCHEDULE_DELIVERY_REFUSED"):
        sandbox_cloud_task(offer, placement=placement, now=now)
    monkeypatch.setenv("HUSHH_DEPLOY_ENV", "uat")
    with pytest.raises(ScheduleRefused, match="SCHEDULE_CLOUD_DELIVERY_UNQUALIFIED"):
        sandbox_cloud_task(offer, placement=placement, now=now)


def test_chat_file_schedule_review_only_returns_normalized_time():
    assert propose_file_schedule("2030-02-01T09:30:00+05:30") == {
        "status": "proposal_ready",
        "type": "files.schedule_organization",
        "run_at": "2030-02-01T04:00:00+00:00",
    }
    for unresolved in ("2030-02-01T09:30:00", "2030-02-32T09:30:00+00:00", "tomorrow"):
        assert propose_file_schedule(unresolved)["run_at"] is None
    assert propose_file_schedule(repeat="weekdays") == {
        "status": "proposal_ready",
        "type": "files.schedule_organization",
        "run_at": None,
        "repeat": "weekdays",
    }


def test_sandbox_queue_publication_requires_the_current_primary_signature(monkeypatch):
    from unittest.mock import AsyncMock, Mock

    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from api.routes.one import pod_schedule_delivery as route
    from hushh_mcp.services.pod_request_signing import VerifiedPod

    registry = SimpleNamespace(
        get_by_hushh_id=AsyncMock(
            return_value={
                "status": "provisioned",
                "pod_signing_key_id": "current-key",
            }
        )
    )
    verify = AsyncMock(return_value=VerifiedPod("owner-a", service_account="unbound"))
    placement = SimpleNamespace(hushh_id="owner-a")
    enqueue = Mock()
    monkeypatch.setattr(route, "sandbox_worker_email", lambda: "worker")
    monkeypatch.setattr(route, "PersonalAgentRegistryRepo", lambda: registry)
    monkeypatch.setattr(route, "verify_pod_request", verify)
    monkeypatch.setattr(route, "retained_hosted_ace_placement", lambda _row: placement)
    monkeypatch.setattr(route, "enqueue_sandbox_schedule", enqueue)
    app = FastAPI()
    app.include_router(route.router)
    body = {
        "schedule_id": "schedule_" + "a" * 32,
        "revision": 1,
        "occurrence_id": "b" * 32,
        "due_at": 2_000_000_000,
    }
    with TestClient(app) as client:
        assert client.post(route.OFFER_PATH, json=body).status_code == 403
        verify.return_value = VerifiedPod("owner-a", key_id="rotated-key")
        assert client.post(route.OFFER_PATH, json=body).status_code == 403
        verify.return_value = VerifiedPod("owner-a", key_id="current-key")
        invalid = client.post(route.OFFER_PATH, json={**body, "title": "synthetic private title"})
        assert invalid.status_code == 422
        assert "synthetic private title" not in invalid.text
        enqueue.assert_not_called()
        assert client.post(route.OFFER_PATH, json=body).status_code == 204
        assert verify.await_args.kwargs["owner_bound"] is True
        enqueue.assert_called_once()
        assert enqueue.call_args.kwargs["placement"] is placement


@pytest.mark.parametrize("scopes", [(), ("files.manage",), ("pod.act", "pod.act")])
async def test_unscoped_adapter_cannot_prepare_private_information(scheduled_tasks, scopes):
    from hushh_mcp.services.pod_scheduled_tasks import ScheduleRefused

    world = scheduled_tasks
    world.capability.required_scopes = scopes
    with pytest.raises(ScheduleRefused, match="SCHEDULE_CAPABILITY_GRANT_INVALID"):
        await world.runtime.create(
            schedule_request(), grant={"subject_id": "browser", "version": 1}
        )
    world.capability.prepare.assert_not_awaited()
    assert await world.log.replay() == []


@pytest.fixture
def scheduled_tasks(tmp_path):
    from unittest.mock import AsyncMock

    from hushh_mcp.services.pod_commit_log import LocalObjectStore, PodCommitLog
    from hushh_mcp.services.pod_scheduled_tasks import ScheduleAccess, ScheduledTasks

    clock = [1000]
    log = PodCommitLog(LocalObjectStore(str(tmp_path / "schedule")), b"s" * 32, owner_id="pod")
    capability = SimpleNamespace(
        max_active_seconds=180,
        required_scopes=("pod.act", "files.manage"),
        prepare=AsyncMock(return_value={"file_revision": 1}),
        run=AsyncMock(return_value="completed"),
    )
    delivery = SimpleNamespace(require_ready=lambda: None, offer=AsyncMock())
    permit = SimpleNamespace(release=AsyncMock())
    admission = SimpleNamespace(acquire_turn=AsyncMock(return_value=permit))
    check, check_grant = AsyncMock(), AsyncMock(return_value=10_000_000)

    def build(incarnation="epoch"):
        return ScheduledTasks(
            access=ScheduleAccess("owner", "pod", incarnation, check),
            log=log,
            capabilities={"agent_files.organize_file.v1": capability},
            delivery=delivery,
            admission=admission,
            check_grant=check_grant,
            clock=lambda: clock[0],
        )

    return SimpleNamespace(
        runtime=build(),
        build=build,
        log=log,
        clock=clock,
        capability=capability,
        delivery=delivery,
        check_grant=check_grant,
        permit=permit,
    )


def schedule_request(**changes):
    from hushh_mcp.services.pod_scheduled_tasks import ScheduleRequest

    return ScheduleRequest(
        **{
            "request_id": "synthetic-request",
            "title": "Organize synthetic file",
            "capability": "agent_files.organize_file.v1",
            "parameters": {"file_id": "a" * 32},
            "first_run_at": 1100,
            "timezone": "America/Los_Angeles",
            "authorization_expires_at": 2000,
            "confirmed": True,
            **changes,
        }
    )


@pytest.mark.asyncio
async def test_schedule_recovers_outbox_and_claims_once_before_effect(scheduled_tasks):
    from hushh_mcp.services.pod_scheduled_tasks import ScheduleRefused

    world = scheduled_tasks
    world.delivery.offer.side_effect = ScheduleRefused("SCHEDULE_DELIVERY_UNCONFIRMED")
    with pytest.raises(ScheduleRefused):
        await world.runtime.create(
            schedule_request(), grant={"subject_id": "browser", "version": 1}
        )
    records = await world.log.replay()
    assert records[-1]["payload"]["state"] == "pending_delivery"
    world.delivery.offer.side_effect = None
    restarted = world.build()
    created = await restarted.create(
        schedule_request(), grant={"subject_id": "browser", "version": 1}
    )
    assert created["state"] == "scheduled"
    delivery = world.delivery.offer.call_args.args
    world.clock[0] = 1101
    from unittest.mock import AsyncMock

    entered, release = asyncio.Event(), asyncio.Event()

    async def effect(terms, occurrence, check):
        await check()
        assert (await world.log.replay())[-1]["payload"]["last_run"]["state"] == "running"
        entered.set()
        await release.wait()
        return "completed"

    world.capability.run = AsyncMock(side_effect=effect)
    first = asyncio.create_task(restarted.run(*delivery[:3]))
    await asyncio.wait_for(entered.wait(), 2)
    duplicate = await world.build().run(*delivery[:3])
    assert duplicate["state"] == "running"
    release.set()
    assert (await first)["state"] == "completed"
    assert (await world.build().run(*delivery[:3]))["state"] == "completed"
    assert world.capability.run.await_count == 1
    # An exact request retry after its due time returns the same operation.
    assert (
        await restarted.create(schedule_request(), grant={"subject_id": "browser", "version": 1})
    )["id"] == created["id"]


async def test_one_time_cancelled_outcome_is_terminal_on_redelivery(scheduled_tasks):
    world = scheduled_tasks
    grant = {"subject_id": "browser", "version": 1}
    await world.runtime.create(schedule_request(), grant=grant)
    delivery = world.delivery.offer.call_args.args[:3]
    other = await world.runtime.create(schedule_request(request_id="another-request"), grant=grant)
    world.clock[0] = 1101
    world.capability.run.return_value = "cancelled"
    for runtime in (world.runtime, world.build()):
        result = await runtime.run(*delivery)
        assert result["state"] == result["last_run"]["state"] == "cancelled"
    world.capability.run.assert_awaited_once()
    assert (await world.runtime.get(other["id"]))["state"] == "scheduled"


@pytest.mark.asyncio
async def test_recurring_schedule_repairs_lost_next_delivery_without_replaying_effect(
    scheduled_tasks,
):
    from hushh_mcp.services.pod_scheduled_tasks import ScheduleRefused

    world = scheduled_tasks
    await world.runtime.create(
        schedule_request(repeat="daily", authorization_expires_at=200000),
        grant={"subject_id": "browser", "version": 1},
    )
    original = world.delivery.offer.call_args.args
    world.clock[0] = 1101
    world.delivery.offer.side_effect = ScheduleRefused("SCHEDULE_DELIVERY_UNCONFIRMED")
    with pytest.raises(ScheduleRefused, match="DELIVERY_UNCONFIRMED"):
        await world.runtime.run(*original[:3])
    world.capability.run.assert_awaited_once()
    pending = (await world.log.replay())[-1]["payload"]
    assert pending["state"] == "pending_delivery" and pending["next_run_at"] > world.clock[0]
    world.delivery.offer.side_effect = None
    settled = await world.build().run(*original[:3])
    assert settled["state"] == "scheduled"
    assert world.delivery.offer.call_args.args[:3] != original[:3]
    world.capability.run.assert_awaited_once()


async def test_schedule_revocation_pause_and_incarnation_refuse_old_delivery(scheduled_tasks):
    from hushh_mcp.services.pod_scheduled_tasks import ScheduleRefused

    world = scheduled_tasks
    task = await world.runtime.create(
        schedule_request(), grant={"subject_id": "browser", "version": 1}
    )
    delivery = world.delivery.offer.call_args.args
    paused = await world.runtime.control(task["id"], task["revision"], "pause")
    world.clock[0] = 1101
    assert (await world.runtime.run(*delivery[:3]))["state"] == "paused"
    world.capability.run.assert_not_awaited()
    with pytest.raises(ScheduleRefused, match="SCHEDULE_APPROVAL_REQUIRED"):
        await world.runtime.control(task["id"], paused["revision"], "resume")
    resumed = await world.runtime.control(task["id"], paused["revision"], "resume", confirmed=True)
    newer = world.delivery.offer.call_args.args
    assert newer[:3] != delivery[:3]
    world.clock[0] = 1162
    world.check_grant.side_effect = ScheduleRefused("SCHEDULE_GRANT_REVOKED")
    assert (await world.runtime.run(*newer[:3]))["state"] == "needs_review"
    world.capability.run.assert_not_awaited()
    world.check_grant.side_effect = None
    assert (await world.build("replacement").run(*newer[:3]))["state"] == "needs_review"
    world.capability.run.assert_not_awaited()
    assert (await world.runtime.control(task["id"], resumed["revision"], "cancel"))[
        "state"
    ] == "cancelled"


@pytest.mark.asyncio
async def test_schedule_checkpoint_and_interrupted_claim_never_replay(scheduled_tasks):
    from hushh_mcp.services.pod_scheduled_tasks import KIND, ScheduleRefused

    world = scheduled_tasks
    task = await world.runtime.create(
        schedule_request(), grant={"subject_id": "browser", "version": 1}
    )
    delivery = world.delivery.offer.call_args.args
    assert (await world.runtime.run(*delivery[:3]))["state"] == "scheduled"
    world.capability.run.assert_not_awaited()  # A metadata checkpoint is not a turn.
    records = await world.log.replay()
    claimed = records[-1]["payload"]
    claimed.update(
        state="running",
        revision=claimed["revision"] + 1,
        last_run={"id": delivery[2], "state": "running", "started_at": 1100, "lease_until": 1280},
    )
    await world.log.append(KIND, claimed, expected_seq=records[-1]["seq"])
    world.clock[0] = 1281
    assert (await world.build().run(*delivery[:3]))["state"] == "needs_review"
    with pytest.raises(ScheduleRefused, match="SCHEDULE_OUTCOME_UNCERTAIN"):
        await world.build().control(task["id"], claimed["revision"], "resume", confirmed=True)
    world.capability.run.assert_not_awaited()


async def test_recovered_schedule_rejects_malformed_effect_selection(scheduled_tasks):
    from hushh_mcp.services.pod_scheduled_tasks import KIND, ScheduleRefused

    world = scheduled_tasks
    await world.runtime.create(schedule_request(), grant={"subject_id": "browser", "version": 1})
    records = await world.log.replay()
    malformed = records[-1]["payload"]
    malformed.update(revision=malformed["revision"] + 1, capability="arbitrary.provider.call")
    await world.log.append(KIND, malformed, expected_seq=records[-1]["seq"])
    with pytest.raises(ScheduleRefused, match="SCHEDULE_RECOVERY_INVALID"):
        await world.build().list()
    world.capability.run.assert_not_awaited()


def test_schedule_calendar_coalesces_dst_and_missed_runs():
    from datetime import datetime
    from zoneinfo import ZoneInfo

    from hushh_mcp.services.pod_scheduled_tasks import next_run_after

    zone = ZoneInfo("America/Los_Angeles")
    before = int(datetime(2026, 3, 7, 2, 30, tzinfo=zone).timestamp())
    after = next_run_after(before, "daily", "America/Los_Angeles", before)
    assert datetime.fromtimestamp(after, zone).hour == 3  # Nonexistent 02:30 advances.
    following = next_run_after(after, "daily", "America/Los_Angeles", after, anchor_at=before)
    assert datetime.fromtimestamp(following, zone).hour == 2
    assert (
        next_run_after(before, "daily", "America/Los_Angeles", after + 3 * 86400)
        > after + 3 * 86400
    )


@pytest.mark.parametrize(
    ("repeat", "first", "weekdays", "following"),
    [
        ("weekly", "1970-01-02T09:00:00+00:00", [0, 4], "1970-01-05T09:00:00+00:00"),
        ("monthly", "1970-01-31T09:00:00+00:00", None, "1970-03-31T09:00:00+00:00"),
    ],
)
async def test_recurring_schedule_retains_its_calendar_after_recovery(
    scheduled_tasks, repeat, first, weekdays, following
):
    from datetime import datetime

    first_at = int(datetime.fromisoformat(first).timestamp())
    following_at = int(datetime.fromisoformat(following).timestamp())
    world = scheduled_tasks
    world.clock[0] = first_at - 3600
    request = schedule_request(
        repeat=repeat,
        weekdays=weekdays,
        timezone="UTC",
        first_run_at=first_at,
        authorization_expires_at=following_at + 3600,
    )
    task = await world.runtime.create(request, grant={"subject_id": "browser", "version": 1})
    delivery = world.delivery.offer.await_args.args
    world.clock[0] = first_at
    result = await world.build().run(*delivery[:3])
    assert result["last_run"]["state"] == "completed"
    assert result["state"] == "scheduled"
    assert result["next_run_at"] == following_at
    assert result.get("weekdays") == weekdays
    assert world.delivery.offer.await_args.args[-1] == following_at
    world.capability.run.assert_awaited_once()
    assert task["id"] == result["id"]
    following_delivery = world.delivery.offer.await_args.args
    world.clock[0] = following_at
    await world.build().run(*following_delivery[:3])
    [recovered] = await world.build().list()
    assert recovered["state"] == "completed"
    assert recovered["recent_runs"] == [
        {
            "id": following_delivery[2],
            "state": "completed",
            "started_at": following_at,
            "finished_at": following_at,
        },
        {"id": delivery[2], "state": "completed", "started_at": first_at, "finished_at": first_at},
    ]


def test_selected_weekdays_reject_an_unapproved_first_run():
    from pydantic import ValidationError

    with pytest.raises(ValidationError, match="Invalid schedule terms"):
        schedule_request(repeat="weekly", weekdays=[0], timezone="UTC")


async def test_skip_next_fences_previous_delivery_and_preserves_the_series(scheduled_tasks):
    world = scheduled_tasks
    grant = {"subject_id": "browser", "version": 1}
    task = await world.runtime.create(
        schedule_request(repeat="daily", authorization_expires_at=200000), grant=grant
    )
    skipped = world.delivery.offer.await_args.args
    result = await world.runtime.control(
        task["id"], task["revision"], "skip_next", confirmed=True, caller_grant=grant
    )
    next_delivery = world.delivery.offer.await_args.args
    assert next_delivery[-1] == skipped[-1] + 86400
    assert result["id"] == task["id"] and result["state"] == "scheduled"
    world.clock[0] = skipped[-1]
    await world.build().run(*skipped[:3])
    world.capability.run.assert_not_awaited()
    world.clock[0] = next_delivery[-1]
    await world.build().run(*next_delivery[:3])
    world.capability.run.assert_awaited_once()


async def test_run_now_claims_a_distinct_occurrence_and_keeps_regular_due_time(scheduled_tasks):
    world = scheduled_tasks
    task = await world.runtime.create(
        schedule_request(repeat="daily", authorization_expires_at=200000),
        grant={"subject_id": "browser", "version": 1},
    )
    regular = world.delivery.offer.await_args.args
    requested = await world.runtime.control(task["id"], task["revision"], "run_now", confirmed=True)
    manual = world.delivery.offer.await_args.args
    assert requested["run_now_pending"] and manual[-1] == world.clock[0]
    assert manual[2] != regular[2]

    await world.build().run(*regular[:3])
    world.capability.run.assert_not_awaited()
    restored = await world.build().run(*manual[:3])
    assert restored["state"] == "scheduled" and not restored["run_now_pending"]
    assert restored["next_run_at"] == regular[-1]
    next_delivery = world.delivery.offer.await_args.args
    assert next_delivery[2] != regular[2] and next_delivery[-1] == regular[-1]

    await world.build().run(*manual[:3])
    world.capability.run.assert_awaited_once()
    world.clock[0] = regular[-1]
    await world.build().run(*next_delivery[:3])
    assert world.capability.run.await_count == 2


async def test_session_only_lockdown_pauses_due_work_after_runtime_recovery(scheduled_tasks):
    from hushh_mcp.services.pod_config import POD_CONFIG_RECORD_KIND

    world = scheduled_tasks
    task = await world.runtime.create(
        schedule_request(), grant={"subject_id": "browser", "version": 1}
    )
    due = world.delivery.offer.await_args.args
    await world.log.append(
        POD_CONFIG_RECORD_KIND,
        {"hushh_id": "pod", "config": {"session_only_lockdown": True}},
    )
    world.clock[0] = due[-1]
    paused = await world.build().run(*due[:3])
    assert paused["state"] == "paused" and paused["last_run"] is None
    world.capability.run.assert_not_awaited()

    await world.log.append(
        POD_CONFIG_RECORD_KIND,
        {"hushh_id": "pod", "config": {"session_only_lockdown": False}},
    )
    await world.build().run(*due[:3])
    world.capability.run.assert_not_awaited()
    await world.runtime.control(task["id"], paused["revision"], "resume", confirmed=True)
    resumed = world.delivery.offer.await_args.args
    world.clock[0] = resumed[-1]
    assert (await world.build().run(*resumed[:3]))["state"] == "completed"
    world.capability.run.assert_awaited_once()


async def test_session_only_lockdown_fences_an_active_offline_claim(scheduled_tasks):
    from hushh_mcp.services.pod_config import POD_CONFIG_RECORD_KIND
    from hushh_mcp.services.pod_scheduled_tasks import ScheduleRefused

    world = scheduled_tasks
    await world.runtime.create(schedule_request(), grant={"subject_id": "browser", "version": 1})
    due = world.delivery.offer.await_args.args
    world.clock[0] = due[-1]

    async def lock_during_run(_terms, _occurrence, check):
        await world.log.append(
            POD_CONFIG_RECORD_KIND,
            {"hushh_id": "pod", "config": {"session_only_lockdown": True}},
        )
        await check()
        pytest.fail("The claimed execution continued after lockdown")

    world.capability.run.side_effect = lock_during_run
    with pytest.raises(ScheduleRefused, match="SCHEDULE_LOCKDOWN_PAUSED"):
        await world.runtime.run(*due[:3])
    [task] = await world.build().list()
    assert task["state"] == "needs_review"
    assert task["last_run"]["state"] == "outcome_uncertain"


@pytest.mark.asyncio
async def test_schedule_rejects_horizon_outside_signed_grant_before_persisting(scheduled_tasks):
    from hushh_mcp.services.pod_scheduled_tasks import ScheduleRefused

    world = scheduled_tasks
    world.check_grant.return_value = 1999
    with pytest.raises(ScheduleRefused, match="SCHEDULE_AUTHORIZATION_HORIZON_REFUSED"):
        await world.runtime.create(
            schedule_request(), grant={"subject_id": "browser", "version": 1}
        )
    assert await world.log.replay() == []
    world.capability.prepare.assert_not_awaited()
    world.delivery.offer.assert_not_awaited()


@pytest.mark.asyncio
async def test_schedule_cancel_stays_pending_until_active_work_has_settled(scheduled_tasks):
    from unittest.mock import AsyncMock

    from hushh_mcp.services.pod_scheduled_tasks import ScheduleRefused

    world = scheduled_tasks
    await world.runtime.create(schedule_request(), grant={"subject_id": "browser", "version": 1})
    delivery = world.delivery.offer.call_args.args
    world.clock[0] = 1101
    entered, finish = asyncio.Event(), asyncio.Event()

    async def effect(terms, occurrence, check):
        entered.set()
        await finish.wait()
        with pytest.raises(ScheduleRefused, match="SCHEDULE_AUTHORITY_CHANGED"):
            await check()
        return "cancelled"

    world.capability.run = AsyncMock(side_effect=effect)
    running = asyncio.create_task(world.runtime.run(*delivery[:3]))
    await asyncio.wait_for(entered.wait(), 2)
    row = await world.runtime.get(delivery[0])
    cancelled = await world.runtime.control(row["id"], row["revision"], "cancel")
    assert cancelled["state"] == "cancelling"
    world.permit.release.assert_not_awaited()
    finish.set()
    assert (await running)["state"] == "cancelled"
    world.permit.release.assert_awaited_once()


async def test_schedule_slow_cleanup_keeps_cancellation_pending_then_releases_admission(
    scheduled_tasks, monkeypatch
):
    from unittest.mock import AsyncMock

    from hushh_mcp.services import pod_scheduled_lease
    from hushh_mcp.services.pod_scheduled_tasks import ScheduleRefused

    monkeypatch.setattr(pod_scheduled_lease, "RENEW_SECONDS", 0.001)
    monkeypatch.setattr(pod_scheduled_lease, "CLEANUP_SECONDS", 0.01)
    world = scheduled_tasks
    await world.runtime.create(schedule_request(), grant={"subject_id": "browser", "version": 1})
    delivery = world.delivery.offer.call_args.args
    world.clock[0] = 1101
    entered, stopping, cleanup = asyncio.Event(), asyncio.Event(), asyncio.Event()

    async def effect(terms, occurrence, check):
        entered.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            stopping.set()
            await cleanup.wait()
            raise

    world.capability.run = AsyncMock(side_effect=effect)
    running = asyncio.create_task(world.runtime.run(*delivery[:3]))
    await asyncio.wait_for(entered.wait(), 2)
    row = await world.runtime.get(delivery[0])
    await world.runtime.control(row["id"], row["revision"], "cancel")
    try:
        await asyncio.wait_for(stopping.wait(), 2)
        with pytest.raises(ScheduleRefused, match="SCHEDULE_CLEANUP_UNCONFIRMED"):
            await running
        assert (await world.runtime.get(row["id"]))["state"] == "cancelling"
        world.permit.release.assert_not_awaited()
    finally:
        cleanup.set()

    async def settled():
        while world.runtime.runner._cleanup:
            await asyncio.sleep(0.001)

    await asyncio.wait_for(settled(), 2)
    assert (await world.runtime.get(row["id"]))["state"] == "cancelled"
    world.permit.release.assert_awaited_once()
    assert (await world.build().run(*delivery[:3]))["state"] == "cancelled"
    world.capability.run.assert_awaited_once()
    world.capability.run.assert_awaited_once()


def test_schedule_delivery_is_model_independent_but_refuses_a_foreign_queue(monkeypatch):
    from hushh_mcp.services.pod_files import model_binding
    from hushh_mcp.services.pod_files.provisioning import coordinates
    from hushh_mcp.services.pod_scheduled_delivery import GcpScheduledDelivery
    from hushh_mcp.services.pod_scheduled_tasks import ScheduleRefused

    names = coordinates("synthetic-owner", "owner-project", "us-central1")
    settings = {
        "K_SERVICE": "synthetic-pod",
        "HUSSH_ID": "synthetic-owner",
        "HUSSH_POD_USER_ADC_ENABLED": "true",
        "HUSSH_POD_KMS_KEY": "projects/owner-project/locations/us-central1/keyRings/owner/cryptoKeys/pod",
        "POD_FILES_TASK_QUEUE": names["queue"],
        "POD_FILES_WORKER_SERVICE_ACCOUNT": names["worker"],
        "POD_FILES_ENABLED": "false",
    }
    for name, value in settings.items():
        monkeypatch.setenv(name, value)
    monkeypatch.delenv("CONTAINER_APP_NAME", raising=False)

    def no_model_for_clock_delivery():
        pytest.fail("Publishing a metadata-only wake must not resolve a Files model")

    monkeypatch.setattr(model_binding, "organization_model_binding", no_model_for_clock_delivery)
    delivery = GcpScheduledDelivery(None)
    delivery.require_ready()
    monkeypatch.setenv(
        "POD_FILES_TASK_QUEUE", names["queue"].replace("owner-project", "foreign-project")
    )
    with pytest.raises(ScheduleRefused, match="SCHEDULE_DELIVERY_NOT_CONFIGURED"):
        delivery.require_ready()


async def test_active_schedule_renews_its_claim_without_extending_the_approved_deadline(
    scheduled_tasks, monkeypatch
):
    from unittest.mock import AsyncMock

    from hushh_mcp.services import pod_scheduled_lease

    monkeypatch.setattr(pod_scheduled_lease, "RENEW_SECONDS", 0.001)
    world = scheduled_tasks
    world.capability.max_active_seconds = 300
    await world.runtime.create(schedule_request(), grant={"subject_id": "browser", "version": 1})
    delivery = world.delivery.offer.call_args.args
    world.clock[0] = 1101

    async def renewed(previous):
        while (await world.log.replay())[-1]["payload"]["last_run"]["lease_until"] <= previous:
            await asyncio.sleep(0.001)

    async def effect(terms, occurrence, check):
        # Model/provider work can exceed the old fixed 180-second window.
        for _ in range(5):
            previous = (await world.log.replay())[-1]["payload"]["last_run"]["lease_until"]
            world.clock[0] += 45
            await check()
            await asyncio.wait_for(renewed(previous), 3)
        return "completed"

    world.capability.run = AsyncMock(side_effect=effect)
    result = await world.runtime.run(*delivery[:3])
    assert result["state"] == "completed"
    assert result["last_run"]["deadline_at"] == 1401
    assert result["last_run"]["lease_until"] <= 1401
    assert result["authorization_expires_at"] == 2000
    assert (await world.build().run(*delivery[:3]))["state"] == "completed"
    world.capability.run.assert_awaited_once()
    world.permit.release.assert_awaited_once()


@pytest.mark.parametrize("recover_uncertain", [False, True])
async def test_schedule_settlement_failure_cannot_acknowledge_update_idle(
    scheduled_tasks, recover_uncertain
):
    from unittest.mock import AsyncMock

    from hushh_mcp.services.pod_scheduled_tasks import KIND, ScheduleRefused

    world = scheduled_tasks
    await world.runtime.create(schedule_request(), grant={"subject_id": "browser", "version": 1})
    delivery = world.delivery.offer.call_args.args
    original_append = world.log.append

    async def append(kind, payload, **kwargs):
        terminal = {"completed"} if recover_uncertain else {"completed", "outcome_uncertain"}
        if kind == KIND and payload.get("last_run", {}).get("state") in terminal:
            raise ScheduleRefused("SCHEDULE_SETTLEMENT_UNCONFIRMED")
        return await original_append(kind, payload, **kwargs)

    world.log.append = AsyncMock(side_effect=append)
    world.clock[0] = 1101
    with pytest.raises(ScheduleRefused, match="SCHEDULE_SETTLEMENT_UNCONFIRMED"):
        await world.runtime.run(*delivery[:3])
    expected = "outcome_uncertain" if recover_uncertain else "running"
    assert (await world.log.replay())[-1]["payload"]["last_run"]["state"] == expected
    assert world.permit.release.await_count == int(recover_uncertain)
    assert not world.runtime.runner._cleanup
    assert bool(world.runtime.runner.cleanup_failures) is not recover_uncertain
    assert (await world.build().run(*delivery[:3]))["state"] == (
        "needs_review" if recover_uncertain else "running"
    )
    world.capability.run.assert_awaited_once()


@pytest.mark.parametrize("authority_loss", ["revoked", "expired"])
async def test_schedule_authority_loss_cancels_work_before_releasing_update_admission(
    scheduled_tasks, monkeypatch, authority_loss
):
    from unittest.mock import AsyncMock

    from hushh_mcp.services import pod_scheduled_lease
    from hushh_mcp.services.pod_scheduled_tasks import ScheduleRefused

    monkeypatch.setattr(pod_scheduled_lease, "RENEW_SECONDS", 0.001)
    world = scheduled_tasks
    await world.runtime.create(schedule_request(), grant={"subject_id": "browser", "version": 1})
    delivery = world.delivery.offer.call_args.args
    world.clock[0] = 1101
    entered, stopping, cleanup = asyncio.Event(), asyncio.Event(), asyncio.Event()

    async def effect(terms, occurrence, check):
        entered.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            stopping.set()
            await cleanup.wait()
            raise

    world.capability.run = AsyncMock(side_effect=effect)
    running = asyncio.create_task(world.runtime.run(*delivery[:3]))
    try:
        await asyncio.wait_for(entered.wait(), 2)
        if authority_loss == "revoked":
            world.check_grant.side_effect = ScheduleRefused("SCHEDULE_GRANT_REVOKED")
        else:
            world.clock[0] = 2001
        await asyncio.wait_for(stopping.wait(), 2)
        world.permit.release.assert_not_awaited()
    finally:
        cleanup.set()
        if not stopping.is_set():
            running.cancel()
    with pytest.raises(ScheduleRefused):
        await running
    records = await world.log.replay()
    assert records[-1]["payload"]["last_run"]["state"] == "outcome_uncertain"
    assert (await world.build().run(*delivery[:3]))["state"] == "needs_review"
    world.capability.run.assert_awaited_once()
    world.permit.release.assert_awaited_once()


async def test_control_cannot_advance_an_exact_time_capability(scheduled_tasks):
    from hushh_mcp.services.pod_scheduled_mail import ScheduledMailFollowup
    from hushh_mcp.services.pod_scheduled_tasks import ScheduleRefused

    world = scheduled_tasks
    world.capability.allow_run_now = ScheduledMailFollowup.allow_run_now
    row = await world.runtime.create(
        schedule_request(), grant={"subject_id": "browser", "version": 1}
    )
    with pytest.raises(ScheduleRefused, match="SCHEDULE_RUN_NOW_REFUSED"):
        await world.runtime.control(row["id"], row["revision"], "run_now", confirmed=True)
    assert (await world.runtime.get(row["id"]))["next_run_at"] == 1100
    world.capability.run.assert_not_awaited()
