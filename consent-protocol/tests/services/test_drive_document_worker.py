"""Finite worker admission and aggregate-only reporting."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.services.drive_document_worker import DriveDocumentWorker


async def test_worker_requires_explicit_rollout_for_each_owner(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("DRIVE_DOCUMENT_INDEXING", "true")
    monkeypatch.setenv("CONNECTOR_INTERNAL_OWNER_COHORT", "approved-owner")
    service = SimpleNamespace(
        run_one=AsyncMock(return_value={"status": "ready", "secret": "PRIVATE"})
    )
    worker = DriveDocumentWorker(service)
    worker.due_owners = AsyncMock(return_value=["approved-owner", "other-owner"])
    result = await worker.run(max_jobs=2)
    assert result == {"schema_version": "drive.worker.v1", "outcomes": {"ready": 1, "disabled": 1}}
    worker.due_owners.assert_awaited_once_with(2, reserve_profile_upgrade=True)
    service.run_one.assert_awaited_once_with(user_id="approved-owner", prefer_profile_upgrade=True)
    assert "owner" not in str(result) and "PRIVATE" not in str(result)


@pytest.mark.parametrize(
    "bounds", [{"max_jobs": 0}, {"max_jobs": 21}, {"max_jobs": True}, {"deadline_seconds": 541}]
)
async def test_worker_rejects_unbounded_batches(bounds):
    with pytest.raises(ValueError):
        await DriveDocumentWorker(SimpleNamespace()).run(**bounds)


async def test_busy_extraction_reserves_parallel_facts_and_packet_budget(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("DRIVE_DOCUMENT_INDEXING", "true")
    monkeypatch.setenv("CONNECTOR_INTERNAL_OWNER_COHORT", "owner")
    semantic_started = asyncio.Event()

    async def extraction(**kwargs):
        await asyncio.wait_for(semantic_started.wait(), timeout=1)
        return {"status": "ready"}

    async def semantics(**kwargs):
        assert kwargs == {"max_jobs": 2, "deadline_seconds": 160}
        semantic_started.set()
        return {"facts_complete": 1, "packet_queued": 1}

    service = SimpleNamespace(run_one=AsyncMock(side_effect=extraction))
    discovery = SimpleNamespace(run=AsyncMock(return_value={"outcomes": {"synced": 2}}))
    packet_worker = SimpleNamespace(run=AsyncMock(side_effect=semantics))
    worker = DriveDocumentWorker(service, collection_sync=discovery, packet_worker=packet_worker)
    worker.due_owners = AsyncMock(return_value=["owner"])
    wake = AsyncMock()
    monkeypatch.setattr("hushh_mcp.services.drive_work_wake.wake_drive_work", wake)
    result = await worker.run(max_jobs=8, deadline_seconds=160)
    assert service.run_one.await_count == 4
    assert [call.kwargs["prefer_profile_upgrade"] for call in service.run_one.await_args_list] == [
        True,
        False,
        False,
        False,
    ]
    discovery.run.assert_awaited_once_with(max_jobs=2, deadline_seconds=100)
    packet_worker.run.assert_awaited_once()
    assert result["outcomes"] == {"ready": 4, "synced": 2, "queued": 2}
    wake.assert_awaited_once_with("documents")


async def test_unsupported_live_file_does_not_block_next_file_for_same_owner(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("DRIVE_DOCUMENT_INDEXING", "true")
    monkeypatch.setenv("CONNECTOR_INTERNAL_OWNER_COHORT", "owner")
    service = SimpleNamespace(
        run_one=AsyncMock(
            side_effect=[
                {"status": "unsupported"},
                {"status": "ready"},
                {"status": "not_ready"},
            ]
        )
    )
    worker = DriveDocumentWorker(service)
    worker.due_owners = AsyncMock(return_value=["owner"])
    monkeypatch.setattr("hushh_mcp.services.drive_work_wake.wake_drive_work", AsyncMock())

    result = await worker.run(max_jobs=4)

    assert service.run_one.await_count == 3
    assert result["outcomes"] == {"unsupported": 1, "ready": 1, "not_ready": 1}


async def test_reserved_upgrade_slot_prefers_upgrade_for_selected_owner(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("DRIVE_DOCUMENT_INDEXING", "true")
    monkeypatch.setenv("CONNECTOR_INTERNAL_OWNER_COHORT", "upgrade-owner,due-owner")
    service = SimpleNamespace(run_one=AsyncMock(return_value={"status": "ready"}))
    worker = DriveDocumentWorker(service)
    worker.due_owners = AsyncMock(return_value=["upgrade-owner", "due-owner"])

    await worker.run(max_jobs=2)

    worker.due_owners.assert_awaited_once_with(2, reserve_profile_upgrade=True)
    assert [call.kwargs for call in service.run_one.await_args_list] == [
        {"user_id": "upgrade-owner", "prefer_profile_upgrade": True},
        {"user_id": "due-owner", "prefer_profile_upgrade": False},
    ]


async def test_single_owner_uses_bounded_sweep_for_packet_phase_progress(monkeypatch):
    """A large owner must not stall after one facts and one packet phase."""
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("DRIVE_DOCUMENT_INDEXING", "true")
    monkeypatch.setenv("CONNECTOR_INTERNAL_OWNER_COHORT", "owner")
    service = SimpleNamespace(run_one=AsyncMock(return_value={"status": "ready"}))
    discovery = SimpleNamespace(run=AsyncMock(return_value={"outcomes": {"synced": 2}}))
    packet_worker = SimpleNamespace(
        run=AsyncMock(
            side_effect=[
                {"facts_complete": 1, "packet_queued": 1},
                {"facts_complete": 1, "packet_queued": 1},
                {"facts_complete": 1, "ready": 1},
            ]
        )
    )
    worker = DriveDocumentWorker(service, collection_sync=discovery, packet_worker=packet_worker)
    worker.due_owners = AsyncMock(return_value=["owner"])
    wake = AsyncMock()
    monkeypatch.setattr("hushh_mcp.services.drive_work_wake.wake_drive_work", wake)

    result = await worker.run(max_jobs=20, deadline_seconds=160)

    assert service.run_one.await_count == 12
    assert [call.kwargs["max_jobs"] for call in packet_worker.run.await_args_list] == [6, 4, 2]
    assert sum(result["outcomes"].values()) == 20
    assert result["outcomes"] == {"ready": 13, "synced": 2, "queued": 5}
    wake.assert_awaited_once_with("documents")


@pytest.mark.parametrize("outcome", [{"idle": 2}, {"facts_unavailable": 2}, {}])
async def test_semantic_sweep_does_not_spin_when_no_progress(monkeypatch, outcome):
    packet_worker = SimpleNamespace(run=AsyncMock(return_value=outcome))
    worker = DriveDocumentWorker(SimpleNamespace(), packet_worker=packet_worker)
    worker.due_owners = AsyncMock(return_value=[])
    wake = AsyncMock()
    monkeypatch.setattr("hushh_mcp.services.drive_work_wake.wake_drive_work", wake)

    await worker.run(max_jobs=20)

    packet_worker.run.assert_awaited_once()
    wake.assert_not_awaited()


async def test_larger_sweep_still_cancels_all_lanes_at_shared_deadline(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("DRIVE_DOCUMENT_INDEXING", "true")
    monkeypatch.setenv("CONNECTOR_INTERNAL_OWNER_COHORT", "owner")
    cancelled = set()

    async def wait(lane):
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.add(lane)

    service = SimpleNamespace(run_one=lambda **kwargs: wait("extraction"))
    discovery = SimpleNamespace(run=lambda **kwargs: wait("discovery"))
    packet_worker = SimpleNamespace(run=lambda **kwargs: wait("semantics"))
    worker = DriveDocumentWorker(service, collection_sync=discovery, packet_worker=packet_worker)
    worker.due_owners = AsyncMock(return_value=["owner"])

    result = await worker.run(max_jobs=20, deadline_seconds=1)

    assert result["outcomes"] == {"deadline": 1}
    assert cancelled == {"extraction", "discovery", "semantics"}


async def test_completed_extraction_wakes_next_semantic_sweep(monkeypatch):
    """Facts can be idle before parallel extraction publishes its first result."""
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("DRIVE_DOCUMENT_INDEXING", "true")
    monkeypatch.setenv("CONNECTOR_INTERNAL_OWNER_COHORT", "owner")
    semantic_finished = asyncio.Event()

    async def semantics(**kwargs):
        semantic_finished.set()
        return {"idle": 2}

    async def extraction(**kwargs):
        await semantic_finished.wait()
        return {"status": "ready"}

    worker = DriveDocumentWorker(
        SimpleNamespace(run_one=extraction),
        packet_worker=SimpleNamespace(run=semantics),
    )
    worker.due_owners = AsyncMock(return_value=["owner"])
    wake = AsyncMock()
    monkeypatch.setattr("hushh_mcp.services.drive_work_wake.wake_drive_work", wake)

    result = await worker.run(max_jobs=4)

    assert result["outcomes"] == {"idle": 2, "ready": 2}
    wake.assert_awaited_once_with("documents")
