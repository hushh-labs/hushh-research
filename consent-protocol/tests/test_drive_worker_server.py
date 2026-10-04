"""Startup/readiness contract for the isolated, scanner-equipped ingress."""

import asyncio
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


@pytest.mark.asyncio
async def test_worker_retries_cold_model_timeout_before_scanner_attestation(monkeypatch, tmp_path):
    import server_drive_worker as worker

    query = AsyncMock(
        side_effect=[DriveReadError("processing_timeout", retryable=True), [0.0] * 384]
    )
    check_ready = AsyncMock()
    monkeypatch.setattr(worker, "BAKED_MODEL_DIR", str(tmp_path))
    monkeypatch.setattr(worker.IsolatedDocumentEmbedding, "query", query)
    monkeypatch.setattr(worker.ClamAvScanner, "check_ready", check_ready)
    async with worker.lifespan(worker.app):
        assert query.await_count == 2
        check_ready.assert_awaited_once()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "errors",
    [
        [DriveReadError("processor_unavailable")],
        [DriveReadError("processing_timeout")],
        [DriveReadError("processor_unavailable", retryable=True)],
        [DriveReadError("processing_timeout", retryable=True)] * 2,
    ],
)
async def test_worker_model_failures_never_admit_or_attest_scanner(monkeypatch, tmp_path, errors):
    import server_drive_worker as worker

    query = AsyncMock(side_effect=errors)
    check_ready = AsyncMock()
    monkeypatch.setattr(worker, "BAKED_MODEL_DIR", str(tmp_path))
    monkeypatch.setattr(worker.IsolatedDocumentEmbedding, "query", query)
    monkeypatch.setattr(worker.ClamAvScanner, "check_ready", check_ready)
    with pytest.raises(DriveReadError):
        async with worker.lifespan(worker.app):
            pytest.fail("Failed model check admitted the worker")
    assert query.await_count == len(errors)
    check_ready.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("blocked_stage", ["embedding", "scanner"])
async def test_worker_total_budget_cancels_unfinished_readiness(
    monkeypatch, tmp_path, blocked_stage
):
    import server_drive_worker as worker

    cancelled = asyncio.Event()

    async def never_ready(*_args):
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    query = AsyncMock(side_effect=never_ready if blocked_stage == "embedding" else None)
    check_ready = AsyncMock(side_effect=never_ready if blocked_stage == "scanner" else None)
    monkeypatch.setattr(worker, "BAKED_MODEL_DIR", str(tmp_path))
    monkeypatch.setattr(worker, "STARTUP_TIMEOUT_SECONDS", 0.01)
    monkeypatch.setattr(worker.IsolatedDocumentEmbedding, "query", query)
    monkeypatch.setattr(worker.ClamAvScanner, "check_ready", check_ready)
    with pytest.raises(RuntimeError, match="exceeded its startup readiness budget"):
        async with worker.lifespan(worker.app):
            pytest.fail("Unfinished readiness check admitted the worker")
    assert cancelled.is_set()
    if blocked_stage == "embedding":
        check_ready.assert_not_awaited()
