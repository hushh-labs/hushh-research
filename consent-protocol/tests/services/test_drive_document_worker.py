"""Finite worker admission and aggregate-only reporting."""

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
