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
    worker.due_owners.assert_awaited_once_with(2)
    service.run_one.assert_awaited_once_with(user_id="approved-owner")
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
    discovery.run.assert_awaited_once_with(max_jobs=2, deadline_seconds=100)
    packet_worker.run.assert_awaited_once()
    assert result["outcomes"] == {"ready": 4, "synced": 2, "queued": 2}
    wake.assert_awaited_once_with("documents")
