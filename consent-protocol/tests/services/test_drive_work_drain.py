"""Contract tests for the bounded, aggregate-only Drive work coordinator."""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from hushh_mcp.services.drive_work_drain import DriveWorkDrain


def _worker(result):
    return type("Worker", (), {"run": AsyncMock(return_value=result)})()


@pytest.mark.asyncio
async def test_drain_sequences_dependencies_with_small_shared_bounds_and_safe_aggregates():
    documents = _worker({"outcomes": {"ready": 1, "private": "document-id"}})
    suggestions = _worker({"outcomes": {"review_ready": 1, "request_id": 1}})
    permissions = _worker({"outcomes": {"succeeded": 2, "email": 1}})
    notifications = _worker({"outcomes": {"settled": 2, "event_id": 1}})

    result = await DriveWorkDrain(
        document_worker=documents,
        suggestion_worker=suggestions,
        permission_worker=permissions,
        notification_worker=notifications,
    ).run(max_jobs_per_worker=2, deadline_seconds=20)

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
        assert 1 <= worker.run.await_args.kwargs["deadline_seconds"] <= 25
    assert "document-id" not in str(result)


@pytest.mark.asyncio
async def test_drain_continues_later_stages_after_one_worker_fails_without_error_detail():
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
    ).run(deadline_seconds=20)

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
async def test_document_stage_gets_a_real_processing_budget_without_starving_later_work():
    workers = [_worker({"outcomes": {"idle": 1}}) for _ in range(4)]
    await DriveWorkDrain(
        document_worker=workers[0],
        suggestion_worker=workers[1],
        permission_worker=workers[2],
        notification_worker=workers[3],
    ).run(deadline_seconds=175)

    budgets = [worker.run.await_args.kwargs["deadline_seconds"] for worker in workers]
    assert budgets[0] == 95
    assert budgets[1:] == [20, 20, 20]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "kwargs",
    [
        {"max_jobs_per_worker": 0},
        {"max_jobs_per_worker": 5},
        {"max_jobs_per_worker": True},
        {"deadline_seconds": 19},
        {"deadline_seconds": 181},
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
