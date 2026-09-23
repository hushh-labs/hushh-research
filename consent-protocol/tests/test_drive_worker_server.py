"""Startup/readiness contract for the isolated, scanner-equipped ingress."""

from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from hushh_mcp.services.google_drive_adapter import DriveReadError


@pytest.mark.asyncio
async def test_worker_startup_fails_closed_without_baked_model(monkeypatch, tmp_path):
    import server_drive_worker as worker

    query = AsyncMock()
    monkeypatch.setattr(worker, "BAKED_MODEL_DIR", str(tmp_path / "missing"))
    monkeypatch.setattr(worker.IsolatedDocumentEmbedding, "query", query)
    with pytest.raises(RuntimeError, match="missing its pinned local model"):
        async with worker.lifespan(worker.app):
            pass
    query.assert_not_awaited()


@pytest.mark.asyncio
async def test_worker_waits_for_scanner_then_only_becomes_ready(monkeypatch, tmp_path):
    import server_drive_worker as worker

    query = AsyncMock(return_value=[0.0] * 384)
    check_ready = AsyncMock(side_effect=[DriveReadError("scanner_unavailable"), None, None])
    sleep = AsyncMock()
    monkeypatch.setattr(worker, "BAKED_MODEL_DIR", str(tmp_path))
    monkeypatch.setattr(worker.IsolatedDocumentEmbedding, "query", query)
    monkeypatch.setattr(worker.ClamAvScanner, "check_ready", check_ready)
    monkeypatch.setattr(worker.asyncio, "sleep", sleep)
    async with worker.lifespan(worker.app):
        assert await worker.ready() == {"status": "ready"}
    query.assert_awaited_once_with("synthetic statement")
    assert check_ready.await_count == 3
    sleep.assert_awaited_once_with(3)


@pytest.mark.asyncio
async def test_worker_readiness_fails_closed_when_scanner_degrades(monkeypatch):
    import server_drive_worker as worker

    monkeypatch.setattr(
        worker.ClamAvScanner,
        "check_ready",
        AsyncMock(side_effect=DriveReadError("scanner_unavailable")),
    )
    with pytest.raises(HTTPException) as error:
        await worker.ready()
    assert error.value.status_code == 503
    assert error.value.detail == "Drive worker unavailable"
