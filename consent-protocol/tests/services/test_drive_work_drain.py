"""Contract tests for fixed, bounded, aggregate-only Drive work stages."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import UUID

import pytest

from hushh_mcp.services.drive_permission_worker import DrivePermissionWorker
from hushh_mcp.services.drive_share_notification_worker import DriveShareNotificationWorker
from hushh_mcp.services.drive_work_drain import DriveWorkDrain


def _worker(result):
    return type("Worker", (), {"run": AsyncMock(return_value=result)})()


def _drain(workers):
    return DriveWorkDrain(
        document_worker=workers[0],
        suggestion_worker=workers[1],
        permission_worker=workers[2],
        notification_worker=workers[3],
    )


@pytest.mark.asyncio
async def test_document_stage_is_exclusive_bounded_and_aggregate_only():
    workers = [
        _worker({"outcomes": {"ready": 1, "private": "document-id"}}),
        _worker({"outcomes": {"review_ready": 1}}),
        _worker({"outcomes": {"succeeded": 1}}),
        _worker({"outcomes": {"settled": 1}}),
    ]

    result = await _drain(workers).run(stage="documents")

    assert result == {
        "schema_version": "drive.work_drain.v1",
        "workers": {
            "documents": {"ready": 1},
            "suggestions": {"deferred": 1},
            "permissions": {"deferred": 1},
            "notifications": {"deferred": 1},
        },
    }
    workers[0].run.assert_awaited_once_with(max_jobs=1, deadline_seconds=180)
    for worker in workers[1:]:
        worker.run.assert_not_awaited()
    assert "document-id" not in str(result)


@pytest.mark.asyncio
async def test_suggestion_stage_does_not_claim_document_or_sharing_work():
    workers = [_worker({"outcomes": {"review_ready": 1}}) for _ in range(4)]

    result = await _drain(workers).run(stage="suggestions")

    workers[1].run.assert_awaited_once_with(max_jobs=1, deadline_seconds=175)
    for index in (0, 2, 3):
        workers[index].run.assert_not_awaited()
    assert result["workers"] == {
        "documents": {"deferred": 1},
        "suggestions": {"review_ready": 1},
        "permissions": {"deferred": 1},
        "notifications": {"deferred": 1},
    }


@pytest.mark.asyncio
async def test_sharing_stage_continues_notification_after_permission_failure():
    workers = [_worker({"outcomes": {"not_claimed": 1}}) for _ in range(4)]
    workers[2].run.side_effect = RuntimeError("private file and recipient")
    workers[3].run.return_value = {"outcomes": {"settled": 1, "recipient": 1}}

    result = await _drain(workers).run(stage="sharing")

    workers[0].run.assert_not_awaited()
    workers[1].run.assert_not_awaited()
    workers[2].run.assert_awaited_once_with(max_jobs=20, deadline_seconds=80)
    workers[3].run.assert_awaited_once_with(max_jobs=20, deadline_seconds=45)
    assert result["workers"] == {
        "documents": {"deferred": 1},
        "suggestions": {"deferred": 1},
        "permissions": {"unavailable": 1},
        "notifications": {"settled": 1},
    }
    assert "private" not in str(result)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("stage", "elapsed", "worker_index"),
    [("documents", 50, 0), ("suggestions", 60, 1), ("sharing", 131, 2)],
)
async def test_short_stage_budget_never_claims_work(monkeypatch, stage, elapsed, worker_index):
    workers = [_worker({"outcomes": {"not_claimed": 1}}) for _ in range(4)]
    drain = _drain(workers)
    clock = iter([0, elapsed, elapsed, elapsed])
    monkeypatch.setattr(drain, "_now", lambda: next(clock))

    result = await drain.run(stage=stage)

    workers[worker_index].run.assert_not_awaited()
    key = "permissions" if stage == "sharing" else stage
    assert result["workers"][key] == {"deadline": 1}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "kwargs",
    [
        {"stage": "all"},
        {"stage": True},
        {"max_jobs_per_worker": 0},
        {"max_jobs_per_worker": 21},
        {"max_jobs_per_worker": True},
        {"deadline_seconds": 19},
        {"deadline_seconds": 206},
    ],
)
async def test_drain_rejects_amplifying_or_unbounded_limits(kwargs):
    workers = [_worker({"outcomes": {}}) for _ in range(4)]
    with pytest.raises(ValueError, match="invalid Drive work drain bounds"):
        await _drain(workers).run(**kwargs)
    for worker in workers:
        worker.run.assert_not_awaited()


@pytest.mark.asyncio
async def test_thousand_queued_effects_drain_in_twenty_job_slices_without_reposting_unknowns(
    monkeypatch,
):
    """Delivery queue scale only: these jobs already have exact-file approval."""
    monkeypatch.setattr(
        "hushh_mcp.services.drive_permission_worker.connector_feature_enabled", lambda *_: True
    )
    jobs = {
        str(UUID(int=index)): {
            "operation_id": str(UUID(int=index)),
            "user_id": "synthetic-owner",
            "kind": "grant",
            "state": "unknown" if index % 10 == 0 else "queued",
        }
        for index in range(1, 1001)
    }
    original_unknown = {key for key, row in jobs.items() if row["state"] == "unknown"}

    async def grant(*, user_id, operation_id):
        assert user_id == "synthetic-owner"
        assert jobs.pop(operation_id)["state"] == "queued"
        return "succeeded"

    async def reconcile(*, user_id, operation_id):
        assert user_id == "synthetic-owner"
        assert jobs.pop(operation_id)["state"] == "unknown"
        return "present_unattributed"

    executor = SimpleNamespace(
        grant=AsyncMock(side_effect=grant),
        reconcile=AsyncMock(side_effect=reconcile),
        revoke=AsyncMock(side_effect=AssertionError("unexpected revocation")),
    )
    permissions = DrivePermissionWorker(executor)

    async def due(limit):
        assert 1 <= limit <= 20
        return list(jobs.values())[:limit]

    permissions.due = AsyncMock(side_effect=due)
    workers = [
        _worker({"outcomes": {}}),
        _worker({"outcomes": {}}),
        permissions,
        _worker({"outcomes": {}}),
    ]
    drain = _drain(workers)
    for remaining in range(1000, 0, -20):
        assert len(jobs) == remaining
        result = await drain.run(stage="sharing")
        assert result["workers"]["permissions"] == {"succeeded": 18, "present_unattributed": 2}
        assert len(jobs) == remaining - 20
        assert "synthetic-owner" not in str(result)

    assert (await drain.run(stage="sharing"))["workers"]["permissions"] == {}
    assert executor.grant.await_count == 900
    assert executor.reconcile.await_count == 100
    assert {
        call.kwargs["operation_id"] for call in executor.reconcile.await_args_list
    } == original_unknown
    assert not original_unknown.intersection(
        call.kwargs["operation_id"] for call in executor.grant.await_args_list
    )
    workers[0].run.assert_not_awaited()
    workers[1].run.assert_not_awaited()
    executor.revoke.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("share_count", "question_count", "first_shares", "first_questions", "later_slices"),
    [
        (12, 30, 10, 10, [20, 2]),
        # A full first outbox must leave room for answers on every invocation.
        (30, 30, 10, 10, [20, 20]),
        # Unused capacity flows to the remaining outbox.
        (0, 42, 0, 20, [20, 2]),
    ],
)
async def test_sharing_notification_budget_is_shared_across_both_outboxes(
    monkeypatch, share_count, question_count, first_shares, first_questions, later_slices
):
    monkeypatch.setattr(
        "hushh_mcp.services.drive_share_notification_worker.connector_feature_enabled",
        lambda *_: True,
    )

    def outbox(start, count):
        pending = {
            str(UUID(int=index)): {"event_id": str(UUID(int=index)), "user_id": "recipient"}
            for index in range(start, start + count)
        }

        async def due(limit):
            return list(pending.values())[:limit]

        async def claim(*, event_id):
            return pending.pop(event_id, None)

        return SimpleNamespace(due=AsyncMock(side_effect=due), claim=AsyncMock(side_effect=claim))

    shares, questions = outbox(1, share_count), outbox(101, question_count)
    notifications = DriveShareNotificationWorker(stores=(shares, questions))
    notifications._dispatch = AsyncMock(return_value="settled")
    workers = [_worker({"outcomes": {}}) for _ in range(3)] + [notifications]

    first = await _drain(workers).run(stage="sharing")
    assert first["workers"]["notifications"] == {"settled": 20}
    assert shares.claim.await_count == first_shares
    assert questions.claim.await_count == first_questions
    assert notifications._dispatch.await_count == 20

    for count in later_slices:
        before = questions.claim.await_count
        result = await _drain(workers).run(stage="sharing")
        assert result["workers"]["notifications"] == {"settled": count}
        assert questions.claim.await_count > before
    dispatched = [call.args[0]["event_id"] for call in notifications._dispatch.await_args_list]
    assert len(dispatched) == len(set(dispatched)) == share_count + question_count
