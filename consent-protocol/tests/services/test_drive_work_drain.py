"""Contract tests for the bounded, aggregate-only Drive work coordinator."""

from __future__ import annotations

from datetime import UTC, datetime
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.services import drive_work_drain
from hushh_mcp.services.drive_work_drain import DriveWorkDrain, _sweep_phase


def _worker(result):
    return type("Worker", (), {"run": AsyncMock(return_value=result)})()


def test_two_minute_scheduler_slots_cycle_through_all_stages():
    assert [
        _sweep_phase(datetime(2026, 1, 1, 0, minute, tzinfo=UTC)) for minute in (0, 2, 4, 6)
    ] == [0, 1, 2, 0]


@pytest.mark.asyncio
async def test_drain_sequences_dependencies_with_bounded_jobs_and_safe_aggregates(monkeypatch):
    monkeypatch.setattr(drive_work_drain, "_sweep_phase", lambda: 0)
    documents = _worker({"outcomes": {"ready": 1, "private": "document-id"}})
    suggestions = _worker({"outcomes": {"review_ready": 1, "request_id": 1}})
    permissions = _worker({"outcomes": {"succeeded": 2, "email": 1}})
    notifications = _worker({"outcomes": {"settled": 2, "event_id": 1}})

    result = await DriveWorkDrain(
        document_worker=documents,
        suggestion_worker=suggestions,
        permission_worker=permissions,
        notification_worker=notifications,
    ).run(max_jobs_per_worker=2, deadline_seconds=205)

    assert result == {
        "schema_version": "drive.work_drain.v1",
        "workers": {
            "documents": {"ready": 1},
            "suggestions": {"review_ready": 1},
            "permissions": {"succeeded": 2},
            "notifications": {"settled": 2},
        },
    }
    for worker in (documents, suggestions, permissions, notifications):
        worker.run.assert_awaited_once()
        assert worker.run.await_args.kwargs["max_jobs"] == 2
        assert 1 <= worker.run.await_args.kwargs["deadline_seconds"] <= 205
    assert "document-id" not in str(result)


@pytest.mark.asyncio
async def test_drain_continues_later_stages_after_one_worker_fails_without_error_detail(
    monkeypatch,
):
    monkeypatch.setattr(drive_work_drain, "_sweep_phase", lambda: 0)
    documents = _worker({"outcomes": {"ready": 1}})
    suggestions = _worker({"outcomes": {"review_ready": 1}})
    suggestions.run.side_effect = RuntimeError("provider contains private file and email")
    permissions = _worker({"outcomes": {"succeeded": 1}})
    notifications = _worker({"outcomes": {"settled": 1}})

    result = await DriveWorkDrain(
        document_worker=documents,
        suggestion_worker=suggestions,
        permission_worker=permissions,
        notification_worker=notifications,
    ).run(deadline_seconds=205)

    assert result["workers"] == {
        "documents": {"ready": 1},
        "suggestions": {"unavailable": 1},
        "permissions": {"succeeded": 1},
        "notifications": {"settled": 1},
    }
    assert "private" not in str(result)
    permissions.run.assert_awaited_once()
    notifications.run.assert_awaited_once()


@pytest.mark.asyncio
async def test_idle_heavy_stages_admit_later_work_with_independent_caps(monkeypatch):
    monkeypatch.setattr(drive_work_drain, "_sweep_phase", lambda: 0)
    workers = [_worker({"outcomes": {"idle": 1}}) for _ in range(4)]
    await DriveWorkDrain(
        document_worker=workers[0],
        suggestion_worker=workers[1],
        permission_worker=workers[2],
        notification_worker=workers[3],
    ).run(deadline_seconds=205)

    budgets = [worker.run.await_args.kwargs["deadline_seconds"] for worker in workers]
    assert budgets == [180, 175, 80, 45]
    assert [worker.run.await_args.kwargs["max_jobs"] for worker in workers] == [2, 2, 4, 4]


@pytest.mark.asyncio
async def test_full_document_budget_defers_suggestions_and_grants_before_claim(monkeypatch):
    monkeypatch.setattr(drive_work_drain, "_sweep_phase", lambda: 0)
    workers = [_worker({"outcomes": {"ready": 1}}) for _ in range(4)]
    drain = DriveWorkDrain(
        document_worker=workers[0],
        suggestion_worker=workers[1],
        permission_worker=workers[2],
        notification_worker=workers[3],
    )
    clock = iter([0, 0, 180, 180, 180])
    monkeypatch.setattr(drain, "_now", lambda: next(clock))

    result = await drain.run(deadline_seconds=205)

    workers[0].run.assert_awaited_once_with(max_jobs=2, deadline_seconds=180)
    for worker in workers[1:]:
        worker.run.assert_not_awaited()
    assert result["workers"]["suggestions"] == {"deadline": 1}
    assert result["workers"]["permissions"] == {"deadline": 1}
    assert result["workers"]["notifications"] == {"deadline": 1}


@pytest.mark.asyncio
async def test_fair_turns_admit_suggestions_then_grants_despite_document_backlog(monkeypatch):
    workers = [_worker({"outcomes": {"not_claimed": 1}}) for _ in range(4)]
    drain = DriveWorkDrain(
        document_worker=workers[0],
        suggestion_worker=workers[1],
        permission_worker=workers[2],
        notification_worker=workers[3],
    )

    monkeypatch.setattr(drive_work_drain, "_sweep_phase", lambda: 1)
    suggestion_turn = await drain.run(deadline_seconds=205)
    workers[0].run.assert_not_awaited()
    workers[1].run.assert_awaited_once()
    assert suggestion_turn["workers"]["documents"] == {"deferred": 1}

    for worker in workers:
        worker.run.reset_mock()
    monkeypatch.setattr(drive_work_drain, "_sweep_phase", lambda: 2)
    light_turn = await drain.run(deadline_seconds=205)
    workers[0].run.assert_not_awaited()
    workers[1].run.assert_not_awaited()
    workers[2].run.assert_awaited_once_with(max_jobs=4, deadline_seconds=80)
    workers[3].run.assert_awaited_once_with(max_jobs=4, deadline_seconds=45)
    assert light_turn["workers"]["documents"] == {"deferred": 1}
    assert light_turn["workers"]["suggestions"] == {"deferred": 1}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "kwargs",
    [
        {"max_jobs_per_worker": 0},
        {"max_jobs_per_worker": 5},
        {"max_jobs_per_worker": True},
        {"deadline_seconds": 19},
        {"deadline_seconds": 206},
    ],
)
async def test_drain_rejects_amplifying_or_unbounded_limits(kwargs):
    worker = _worker({"outcomes": {}})
    drain = DriveWorkDrain(
        document_worker=worker,
        suggestion_worker=worker,
        permission_worker=worker,
        notification_worker=worker,
    )
    with pytest.raises(ValueError, match="invalid Drive work drain bounds"):
        await drain.run(**kwargs)
    worker.run.assert_not_awaited()
