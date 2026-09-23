"""Contract tests for fixed, bounded, aggregate-only Drive work stages."""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

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
    workers[2].run.assert_awaited_once_with(max_jobs=1, deadline_seconds=80)
    workers[3].run.assert_awaited_once_with(max_jobs=1, deadline_seconds=45)
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
        {"max_jobs_per_worker": 2},
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
